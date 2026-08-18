//! # Pizarra — whiteboard infinito de notas
//!
//! Servidor local que sirve una UI web (embebida en el binario) + API REST,
//! con persistencia en SQLite. Todo en un único ejecutable.
//!
//! ## Uso
//!
//! ```bash
//! pizarra                  # sirve en http://127.0.0.1:8733
//! PIZARRA_PORT=9000 pizarra
//! PIZARRA_DATA=./datos.db pizarra   # cambiar la ubicación de la BD
//! OPENAI_API_KEY=sk-... pizarra     # activar inferencia (opcional)
//! ```
//!
//! ## Variables de entorno
//!
//! | Variable          | Defecto               | Descripción                        |
//! |-------------------|-----------------------|------------------------------------|
//! | `PIZARRA_PORT`    | `8733`                | Puerto HTTP                        |
//! | `PIZARRA_HOST`    | `127.0.0.1`           | IP a la que escuchar               |
//! | `PIZARRA_DATA`    | `pizarra.db`          | Ruta del fichero SQLite            |
//! | `OPENAI_API_KEY`  | *(vacío → off)*       | Activa inferencia                  |
//! | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL de la API           |
//! | `OPENAI_MODEL`    | `gpt-4o-mini`         | Modelo                             |
//!
//! ## Módulos
//!
//! - `db.rs`   — capa SQLite (boards, notes, connections) + export .md
//! - `api.rs`  — rutas REST
//! - `llm.rs`  — inferencia opcional (OpenAI-compatible)
//! - `state.rs`— estado compartido
//! - `web/`    — frontend (HTML/CSS/JS), embebido con rust-embed

use pizarra::{api, db, llm, state};

use axum::response::IntoResponse;
use axum::Router;
use rust_embed::RustEmbed;
use state::AppState;
use std::net::SocketAddr;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

/// Assets de la UI embebidos en el binario en tiempo de compilación.
#[derive(RustEmbed)]
#[folder = "web/"]
struct Asset;

/// Servidor de la UI estática + API. `fallback` sirve `index.html` para rutas
/// desconocidas (SPA-style), lo que permite recargar sin romper nada.
async fn serve_static(
    uri: axum::http::Uri,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Asset::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Ok((
                [(axum::http::header::CONTENT_TYPE, mime.to_string())],
                content.data,
            )
                .into_response())
        }
        None => Ok((
            [(axum::http::header::CONTENT_TYPE, "text/html")],
            Asset::get("index.html")
                .map(|c| c.data)
                .ok_or(axum::http::StatusCode::NOT_FOUND)?,
        )
            .into_response()),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logs legibles (solo info y errores para no saturar la consola).
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,pizarra=info")),
        )
        .init();

    // Configuración desde entorno.
    let port: u16 = std::env::var("PIZARRA_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8733);
    let host = std::env::var("PIZARRA_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let data = std::env::var("PIZARRA_DATA").unwrap_or_else(|_| "pizarra.db".to_string());

    // Abre (o crea) la BD y aplica el esquema.
    let conn = db::open(&data)?;
    let db = std::sync::Arc::new(std::sync::Mutex::new(conn));

    // Asegura que existe al menos una pizarra para empezar.
    {
        let conn = db.lock().unwrap();
        if db::list_boards(&conn)?.is_empty() {
            db::create_board(&conn, "Mi pizarra")?;
        }
    }

    let state = AppState {
        db: db.clone(),
        llm: llm::LlmConfig::from_env(),
    };

    if state.llm.is_enabled() {
        tracing::info!(
            "Inferencia activada: model={}, base={}",
            state.llm.model,
            state.llm.base_url
        );
    } else {
        tracing::info!("Inferencia desactivada (define OPENAI_API_KEY para activarla)");
    }

    // API + UI. CORS habilitado por si alguien abre la UI desde otro origen.
    let app = Router::new()
        .merge(api::router())
        .fallback(serve_static)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("Pizarra sirviendo en http://{addr}");
    tracing::info!("BD en {data}");

    axum::serve(listener, app).await?;
    Ok(())
}
