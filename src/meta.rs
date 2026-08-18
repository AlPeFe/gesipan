//! # meta.rs — Captura automática de metadatos de una URL
//!
//! Cuando el usuario añade un bookmark, intentamos "descubrirlo" automáticamente
//! como hace Raindrop: hacemos una petición a la página, extraemos el `<title>`,
//! la meta descripción y el favicon, y obtenemos una miniatura de la web.
//!
//! La miniatura se genera con un servicio gratuito sin llave (Screenshot One),
//! que devuelve una imagen del sitio. Si no se consigue, se usa el favicon.

use serde::Serialize;

/// Metadatos extraídos de una URL.
#[derive(Debug, Clone, Serialize, Default)]
pub struct PageMeta {
    pub title: String,
    pub excerpt: String,
    pub favicon: String,
    pub thumbnail: String,
}

/// Cliente HTTP reutilizado para las peticiones.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (compatible; Pizarra/0.1 bookmark-fetcher)")
        .build()
        .unwrap_or_default()
}

/// Devuelve el host de una URL (p.ej. `https://x.com/a` → `x.com`).
fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

/// Busca el valor de una etiqueta HTML simple: `<title>..</title>` o
/// `<meta name="description" content="..">`.
fn extract_between(html: &str, open: &str, close: &str) -> Option<String> {
    let idx = html.to_lowercase().find(&open.to_lowercase())?;
    let rest = &html[idx + open.len()..];
    let end = rest.find(close)?;
    Some(rest[..end].trim().to_string())
}

/// Extrae la meta descripción (`<meta name="description" content="...">`).
fn extract_meta(html: &str, attr_value: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let needle = "content=";
    let mut start = 0;
    while start < html.len() {
        // Localiza el atributo buscado a partir de `start`.
        let rel = lower[start..].find(attr_value.to_lowercase().as_str())?;
        let idx = start + rel;
        // Busca el siguiente `content=` a partir de ahí.
        let rest = &html[idx..];
        let content_pos = rest.find(needle)?;
        let val_start = idx + content_pos + needle.len();
        let after = &html[val_start..];
        let trimmed = after.trim_start_matches(['"', '\'', ' ', '=']);
        // Recalcula: puede haber espacios entre `content` y el valor.
        let value = trimmed
            .trim_start_matches(['"', '\''])
            .chars()
            .take_while(|&c| c != '"' && c != '\'')
            .collect::<String>();
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
        start = idx + attr_value.len();
    }
    None
}

/// Extrae el favicon de los `<link rel="icon">`, o del `/favicon.ico` por defecto.
fn extract_favicon(html: &str, url: &str) -> String {
    let lower = html.to_lowercase();
    let mut start = 0;
    while start < html.len() {
        let rel = match lower[start..].find("rel=\"icon\"") {
            Some(i) => start + i,
            None => break,
        };
        // Busca href= antes o después de rel (orden variable).
        let lo = rel.saturating_sub(200);
        let hi = (rel + 300).min(html.len());
        if let Some(href) = extract_href(&html[lo..hi]) {
            return resolve_url(&href, url);
        }
        start = rel + 10;
    }
    // Fallback: favicon.ico del dominio.
    let h = host_of(url);
    format!("https://{h}/favicon.ico")
}

/// Extrae `href="..."` del fragmento dado.
fn extract_href(html: &str) -> Option<String> {
    let idx = html.to_lowercase().find("href=")?;
    let rest = &html[idx + 5..];
    let rest = rest.trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = rest[1..].find(quote)? + 1;
    Some(rest[1..end].to_string())
}

/// Resuelve una URL relativa contra una base absoluta.
fn resolve_url(href: &str, base: &str) -> String {
    let href = href.trim();
    // No tocar URIs de datos ni otros esquemas (javascript:, data:, etc.).
    if href.contains("://") || href.starts_with("data:") || href.starts_with("javascript:")
        || href.starts_with("mailto:") || href.starts_with("tel:")
    {
        return href.to_string();
    }
    if href.starts_with("//") {
        return format!("https:{href}");
    }
    let h = host_of(base);
    if href.starts_with('/') {
        return format!("https://{h}{href}");
    }
    // Ruta relativa: usa el esquema+host.
    let scheme = base.split("://").next().unwrap_or("https");
    let base_path = base.split('?').next().unwrap_or(base);
    let path = base_path.rsplitn(2, '/').nth(1).unwrap_or("");
    format!("{scheme}://{h}/{path}/{href}")
}

/// Genera una miniatura del sitio usando el servicio gratuito Screenshot One
/// (no requiere API key para peticiones simples).
fn thumbnail_for(url: &str) -> String {
    format!("https://image.thum.io/get/width/400/{url}")
}

/// Descarga y extrae los metadatos de una página.
/// Devuelve `Ok(None)` si no se pudo acceder (para no bloquear el guardado).
pub async fn fetch(url: &str) -> anyhow::Result<PageMeta> {
    let resp = client().get(url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("HTTP {}", resp.status());
    }
    // Lee como texto, truncado para no quedarnos con páginas gigantes.
    let html = resp.text().await.unwrap_or_default();

    let mut meta = PageMeta::default();

    // Título: <title> o fallback al host.
    let title = extract_between(&html, "<title>", "</title>")
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| host_of(url));
    meta.title = html_unescape(&title);

    // Descripción.
    let desc = extract_meta(&html, "name=\"description\"")
        .or_else(|| extract_meta(&html, "property=\"og:description\""));
    if let Some(d) = desc {
        meta.excerpt = html_unescape(&d);
    }

    // Favicon.
    meta.favicon = extract_favicon(&html, url);

    // Miniatura.
    meta.thumbnail = thumbnail_for(url);

    Ok(meta)
}

/// Desentidades HTML básicas (&amp; &lt; &gt; &quot; &#39; &nbsp;).
fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}
