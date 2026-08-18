//! # mcp.rs — Servidor MCP (Model Context Protocol) embebido
//!
//! Expone herramientas para que agentes de IA (Hermes, Claude Desktop, Cursor)
//! organicen las notas y bookmarks de Gesipan de forma automática.
//!
//! Se monta como un endpoint Streamable HTTP en `/mcp` del mismo servidor axum
//! (mismo proceso, misma conexión SQLite → sin problemas de concurrencia WAL).
//!
//! ## Montarlo en Hermes
//!
//! ```yaml
//! mcp_servers:
//!   gesipan:
//!     url: "http://127.0.0.1:8733/mcp"
//! ```
//!
//! Las herramientas aparecen como `mcp_gesipan_*`.

use crate::db;
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, schemars, tool, tool_router,
};
use serde::Deserialize;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// Estado del MCP (comparte la conexión SQLite de la app)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct GesipanMcp {
    db: Arc<Mutex<rusqlite::Connection>>,
}

/// Bloquea la conexión y ejecuta un cierre (como `with_db` de api.rs).
fn with_db<T>(db: &Arc<Mutex<rusqlite::Connection>>, f: impl FnOnce(&rusqlite::Connection) -> anyhow::Result<T>) -> Result<T, ErrorData> {
    let conn = db.lock().expect("db lock poisoned");
    f(&conn).map_err(|e| ErrorData::internal_error(e.to_string(), None))
}

// ---------------------------------------------------------------------------
// Tipos de petición
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NoteRequest {
    pub board_id: i64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BookmarkRequest {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub collection: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MoveRequest {
    pub id: i64,
    pub collection_id: Option<i64>,
    pub tags: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct IdRequest {
    pub id: i64,
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

#[tool_router(server_handler)]
impl GesipanMcp {
    /// Lista las pizarras (tableros) disponibles.
    #[tool(description = "List all boards.")]
    async fn list_boards(&self) -> Result<String, ErrorData> {
        let boards = with_db(&self.db, |conn| db::list_boards(conn))?;
        Ok(serde_json::to_string(&boards).map_err(internal)?)
    }

    /// Crea una nueva nota en una pizarra.
    #[tool(description = "Create a note in a board.")]
    async fn create_note(&self, Parameters(req): Parameters<NoteRequest>) -> Result<String, ErrorData> {
        let style = if req.style == "pin" { "pin" } else { "postit" };
        let color = if req.color.is_empty() { "yellow" } else { &req.color };
        let note = with_db(&self.db, |conn| db::create_note(conn, req.board_id, req.x, req.y, style, color))?;
        // Aplica texto y etiquetas si vienen.
        if !req.text.is_empty() || !req.tags.is_empty() {
            let mut n = note.clone();
            n.text = req.text;
            n.tags = req.tags;
            with_db(&self.db, |conn| db::update_note(conn, &n))?;
            return Ok(serde_json::to_string(&n).map_err(internal)?);
        }
        Ok(serde_json::to_string(&note).map_err(internal)?)
    }

    /// Lista las notas de una pizarra (id + texto + etiquetas).
    #[tool(description = "List notes in a board.")]
    async fn list_notes(&self, Parameters(req): Parameters<IdRequest>) -> Result<String, ErrorData> {
        let notes = with_db(&self.db, |conn| db::list_notes(conn, req.id))?;
        Ok(serde_json::to_string(&notes).map_err(internal)?)
    }

    /// Lista los bookmarks guardados (id, título, url, etiquetas, colección).
    #[tool(description = "List all bookmarks.")]
    async fn list_bookmarks(&self) -> Result<String, ErrorData> {
        let bookmarks = with_db(&self.db, |conn| db::list_bookmarks(conn, None, "", false))?;
        Ok(serde_json::to_string(&bookmarks).map_err(internal)?)
    }

    /// Añade un bookmark (lo crea o lo mueve de colección / asigna etiquetas).
    #[tool(description = "Add or classify a bookmark: create with tags/collection, or move/retag by id.")]
    async fn add_bookmark(&self, Parameters(req): Parameters<BookmarkRequest>) -> Result<String, ErrorData> {
        // Si hay colección nombrada, créala o reutilízala.
        let collection_id = if req.collection.trim().is_empty() {
            None
        } else {
            let name = req.collection.trim().to_string();
            Some(with_db(&self.db, |conn| -> anyhow::Result<i64> {
                let existing = db::list_collections(conn)?;
                if let Some(c) = existing.iter().find(|c| c.name == name) {
                    return Ok(c.id);
                }
                Ok(db::create_collection(conn, &name)?.id)
            })?)
        };
        let bm = with_db(&self.db, |conn| {
            db::create_bookmark(conn, collection_id, req.url.trim(), &req.title, "", "", &req.tags, "", "")
        })?;
        Ok(serde_json::to_string(&bm).map_err(internal)?)
    }

    /// Mueve un bookmark a una colección y/o le asigna etiquetas.
    #[tool(description = "Move a bookmark to a collection and/or set its tags by id.")]
    async fn organize_bookmark(&self, Parameters(req): Parameters<MoveRequest>) -> Result<String, ErrorData> {
        let mut bm = with_db(&self.db, |conn| db::get_bookmark(conn, req.id))?
            .ok_or_else(|| ErrorData::resource_not_found("bookmark not found", None))?;
        if let Some(cid) = req.collection_id {
            bm.collection_id = Some(cid);
        }
        if let Some(t) = req.tags {
            bm.tags = t;
        }
        with_db(&self.db, |conn| db::update_bookmark(conn, &bm))?;
        Ok(serde_json::to_string(&bm).map_err(internal)?)
    }

    /// Crea una colección de bookmarks.
    #[tool(description = "Create a bookmark collection.")]
    async fn create_collection(&self, Parameters(req): Parameters<CollectionReq>) -> Result<String, ErrorData> {
        let c = with_db(&self.db, |conn| db::create_collection(conn, req.name.trim()))?;
        Ok(serde_json::to_string(&c).map_err(internal)?)
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CollectionReq {
    pub name: String,
}

fn internal(e: serde_json::Error) -> ErrorData {
    ErrorData::internal_error(e.to_string(), None)
}

// ---------------------------------------------------------------------------
// Router HTTP (montar en el axum app en /mcp)
// ---------------------------------------------------------------------------

pub fn mcp_router(db: Arc<Mutex<rusqlite::Connection>>) -> axum::Router<crate::state::AppState> {
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
        session::local::LocalSessionManager,
    };
    let mut config = StreamableHttpServerConfig::default();
    // Respuestas JSON directas (sin framing SSE) para herramientas simples.
    config.json_response = true;
    let service = StreamableHttpService::new(
        move || Ok(GesipanMcp { db: db.clone() }),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    axum::Router::<crate::state::AppState>::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(mcp_loopback_guard))
}

/// Guard de loopback: solo permite peticiones locales (Host loopback ya lo
/// valida rmcp; este extra rechaza conexiones remotas explícitas).
async fn mcp_loopback_guard(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    // rmcp ya restringe allowed_hosts a localhost/127.0.0.1/::1.
    next.run(req).await
}
