//! # api.rs — Rutas HTTP (API REST del whiteboard)
//!
//! Expone un API JSON simple y plana:
//!
//! | Método | Ruta                          | Descripción                          |
//! |--------|-------------------------------|--------------------------------------|
//! | GET    | `/api/boards`                 | Lista gesipans                       |
//! | POST   | `/api/boards`                 | Crea gesipan `{name}`                |
//! | PATCH  | `/api/boards/{id}`            | Renombra `{name}`                    |
//! | DELETE | `/api/boards/{id}`            | Borra gesipan (+ notas y conexiones) |
//! | GET    | `/api/boards/{id}/data`       | Gesipan + notas + conexiones         |
//! | GET    | `/api/boards/{id}/export.md`  | Exporta a Markdown (agentes)         |
//! | POST   | `/api/boards/{id}/notes`      | Crea nota                            |
//! | PATCH  | `/api/notes/{id}`             | Actualiza nota                       |
//! | POST   | `/api/notes/{id}/raise`       | Trae al frente                       |
//! | DELETE | `/api/notes/{id}`             | Borra nota                           |
//! | POST   | `/api/boards/{id}/connections`| Crea conexión A→B                    |
//! | DELETE | `/api/connections/{id}`       | Borra conexión                       |
//! | POST   | `/api/llm/complete`           | Inferencia OpenAI (solo si config.)  |
//! | GET    | `/api/llm/status`             | ¿Inferencia disponible?              |
//!
//! Cada handler recibe el estado (`AppState`) que comparte la conexión SQLite
//! (bloqueada con `with_db`) y la configuración de inferencia.

use crate::db;
use crate::llm;
use crate::meta;
use crate::state::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Cuerpos de petición
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct BoardIn {
    name: String,
}

#[derive(Deserialize)]
pub struct NoteIn {
    x: f64,
    y: f64,
    #[serde(default)]
    style: String,
    #[serde(default)]
    color: String,
}

#[derive(Deserialize)]
pub struct NotePatch {
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    style: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    tags: Option<String>,
    #[serde(default)]
    private: Option<bool>,
}

#[derive(Deserialize)]
pub struct GroupIn {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
pub struct GroupPatch {
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    width: Option<f64>,
    #[serde(default)]
    height: Option<f64>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Deserialize)]
pub struct ConnectionIn {
    from_id: i64,
    to_id: i64,
    #[serde(default = "default_anchor")]
    from_anchor: String,
    #[serde(default = "default_anchor")]
    to_anchor: String,
    #[serde(default)]
    label: String,
}

fn default_anchor() -> String {
    "center".to_string()
}

#[derive(Deserialize)]
pub struct CollectionIn {
    name: String,
}

#[derive(Deserialize)]
pub struct BookmarkQuery {
    #[serde(default)]
    collection: Option<i64>,
    #[serde(default)]
    q: String,
    #[serde(default)]
    favs: bool,
}

#[derive(Deserialize)]
pub struct BookmarkIn {
    url: String,
    #[serde(default)]
    collection_id: Option<i64>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    excerpt: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    tags: String,
}

#[derive(Deserialize)]
pub struct BookmarkFetchIn {
    url: String,
}

/// Datos completos de una gesipan (board + notas + conexiones + grupos).
#[derive(serde::Serialize)]
struct BoardData {
    board: db::Board,
    notes: Vec<db::Note>,
    connections: Vec<db::Link>,
    groups: Vec<db::Group>,
}

// ---------------------------------------------------------------------------
// Construcción del router
// ---------------------------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/boards", get(list_boards).post(create_board))
        .route(
            "/api/boards/{id}",
            axum::routing::patch(rename_board).delete(delete_board),
        )
        .route("/api/boards/{id}/data", get(get_board_data))
        .route("/api/boards/{id}/export.md", get(export_md))
        .route("/api/boards/{id}/notes", post(create_note))
        .route(
            "/api/notes/{id}",
            axum::routing::patch(update_note).delete(delete_note),
        )
        .route("/api/notes/{id}/raise", post(raise_note))
        .route("/api/boards/{id}/connections", post(create_connection))
        .route(
            "/api/connections/{id}",
            axum::routing::delete(delete_connection),
        )
        .route("/api/boards/{id}/groups", post(create_group))
        .route(
            "/api/groups/{id}",
            axum::routing::patch(update_group).delete(delete_group),
        )
        .route("/api/llm/complete", post(llm_complete))
        .route("/api/llm/status", get(llm_status))
        // Bookmarks (estilo Raindrop)
        .route(
            "/api/collections",
            get(list_collections).post(create_collection),
        )
        .route(
            "/api/collections/{id}",
            axum::routing::delete(delete_collection),
        )
        .route("/api/bookmarks", get(list_bookmarks).post(create_bookmark))
        .route("/api/bookmarks/fetch", post(fetch_bookmark_meta))
        .route(
            "/api/bookmarks/{id}",
            axum::routing::delete(delete_bookmark),
        )
        .route("/api/bookmarks/{id}/fav", post(toggle_favorite))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ApiResult<T> = Result<T, (StatusCode, Json<serde_json::Value>)>;

/// Bloquea la conexión SQLite y ejecuta un cierre con acceso a `&Connection`.
/// El resultado se devuelve como `anyhow::Result<T>` para encadenar `?`.
fn with_db<T>(
    st: &AppState,
    f: impl FnOnce(&rusqlite::Connection) -> anyhow::Result<T>,
) -> ApiResult<T> {
    let conn = st.db.lock().expect("db lock poisoned");
    f(&conn).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e))
}

/// Convierte un `anyhow::Error` en una respuesta JSON de error 400/500.
fn err<E: std::fmt::Display>(code: StatusCode, msg: E) -> (StatusCode, Json<serde_json::Value>) {
    (code, Json(serde_json::json!({ "error": msg.to_string() })))
}

fn not_found(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": msg })),
    )
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

async fn list_boards(State(st): State<AppState>) -> ApiResult<Json<Vec<db::Board>>> {
    with_db(&st, |conn| db::list_boards(conn)).map(Json)
}

async fn create_board(
    State(st): State<AppState>,
    Json(body): Json<BoardIn>,
) -> ApiResult<(StatusCode, Json<db::Board>)> {
    if body.name.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    let name = body.name.trim().to_string();
    let board = with_db(&st, |conn| db::create_board(conn, &name))?;
    Ok((StatusCode::CREATED, Json(board)))
}

async fn rename_board(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<BoardIn>,
) -> ApiResult<Json<db::Board>> {
    if body.name.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    let name = body.name.trim().to_string();
    with_db(&st, |conn| db::rename_board(conn, id, &name))?;
    let board = with_db(&st, |conn| db::get_board(conn, id))?
        .ok_or_else(|| not_found("board not found"))?;
    Ok(Json(board))
}

async fn delete_board(State(st): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    with_db(&st, |conn| db::delete_board(conn, id)).expect("delete board");
    StatusCode::NO_CONTENT
}

async fn get_board_data(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<BoardData>> {
    let board = with_db(&st, |conn| db::get_board(conn, id))?
        .ok_or_else(|| not_found("board not found"))?;
    let notes = with_db(&st, |conn| db::list_notes(conn, id))?;
    let connections = with_db(&st, |conn| db::list_connections(conn, id))?;
    let groups = with_db(&st, |conn| db::list_groups(conn, id))?;
    Ok(Json(BoardData {
        board,
        notes,
        connections,
        groups,
    }))
}

// ---------------------------------------------------------------------------
// Export a Markdown
// ---------------------------------------------------------------------------

async fn export_md(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<(axum::http::HeaderMap, String)> {
    let md = with_db(&st, |conn| db::export_board_markdown(conn, id))
        .map_err(|_| not_found("board not found"))?;
    let mut headers = axum::http::HeaderMap::new();
    let name = with_db(&st, |conn| db::get_board(conn, id))
        .ok()
        .flatten()
        .map(|b| b.name)
        .unwrap_or_else(|| "gesipan".into());
    let filename = format!("{}.md", name.replace([' ', '/', '\\'], "_"));
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "text/markdown; charset=utf-8".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{filename}\"")
            .parse()
            .unwrap(),
    );
    Ok((headers, md))
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

async fn create_note(
    State(st): State<AppState>,
    Path(board_id): Path<i64>,
    Json(body): Json<NoteIn>,
) -> ApiResult<(StatusCode, Json<db::Note>)> {
    let style = if body.style == "pin" { "pin" } else { "postit" };
    let color = if body.color.is_empty() {
        "yellow"
    } else {
        &body.color
    };
    let note = with_db(&st, |conn| {
        db::create_note(conn, board_id, body.x, body.y, style, color)
    })?;
    Ok((StatusCode::CREATED, Json(note)))
}

async fn update_note(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<NotePatch>,
) -> ApiResult<Json<db::Note>> {
    let mut note =
        with_db(&st, |conn| db::get_note(conn, id))?.ok_or_else(|| not_found("note not found"))?;
    if let Some(v) = body.x {
        note.x = v;
    }
    if let Some(v) = body.y {
        note.y = v;
    }
    if let Some(v) = body.width {
        note.width = v;
    }
    if let Some(v) = body.height {
        note.height = v;
    }
    if let Some(v) = body.text {
        note.text = v;
    }
    if let Some(v) = body.style {
        note.style = if v == "pin" {
            "pin".into()
        } else {
            "postit".into()
        };
    }
    if let Some(v) = body.color {
        note.color = v;
    }
    if let Some(v) = body.tags {
        note.tags = v;
    }
    if let Some(v) = body.private {
        note.private = v;
    }
    with_db(&st, |conn| db::update_note(conn, &note))?;
    Ok(Json(note))
}

// ---------------------------------------------------------------------------
// Groups (recuadros que agrupan notas)
// ---------------------------------------------------------------------------

async fn create_group(
    State(st): State<AppState>,
    Path(board_id): Path<i64>,
    Json(body): Json<GroupIn>,
) -> ApiResult<(StatusCode, Json<db::Group>)> {
    let g = with_db(&st, |conn| db::create_group(conn, board_id, body.x, body.y))?;
    Ok((StatusCode::CREATED, Json(g)))
}

async fn update_group(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<GroupPatch>,
) -> ApiResult<Json<db::Group>> {
    let mut g = with_db(&st, |conn| db::get_group(conn, id))?
        .ok_or_else(|| not_found("group not found"))?;
    if let Some(v) = body.x {
        g.x = v;
    }
    if let Some(v) = body.y {
        g.y = v;
    }
    if let Some(v) = body.width {
        g.width = v;
    }
    if let Some(v) = body.height {
        g.height = v;
    }
    if let Some(v) = body.title {
        g.title = v;
    }
    with_db(&st, |conn| db::update_group(conn, &g))?;
    Ok(Json(g))
}

async fn delete_group(State(st): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    with_db(&st, |conn| db::delete_group(conn, id)).expect("delete group");
    StatusCode::NO_CONTENT
}

async fn raise_note(State(st): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    with_db(&st, |conn| db::raise_note(conn, id)).expect("raise note");
    StatusCode::NO_CONTENT
}

async fn delete_note(State(st): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    with_db(&st, |conn| db::delete_note(conn, id)).expect("delete note");
    StatusCode::NO_CONTENT
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async fn create_connection(
    State(st): State<AppState>,
    Path(board_id): Path<i64>,
    Json(body): Json<ConnectionIn>,
) -> ApiResult<(StatusCode, Json<db::Link>)> {
    if body.from_id == body.to_id {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "cannot connect a note to itself",
        ));
    }
    let from_anchor = body.from_anchor.clone();
    let to_anchor = body.to_anchor.clone();
    let label = body.label.clone();
    let c = with_db(&st, |conn| {
        db::create_connection(conn, board_id, body.from_id, body.to_id, &from_anchor, &to_anchor, &label)
    })?;
    Ok((StatusCode::CREATED, Json(c)))
}

async fn delete_connection(State(st): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    with_db(&st, |conn| db::delete_connection(conn, id)).expect("delete connection");
    StatusCode::NO_CONTENT
}

// ---------------------------------------------------------------------------
// Bookmarks (estilo Raindrop)
// ---------------------------------------------------------------------------

async fn list_collections(
    State(st): State<AppState>,
) -> ApiResult<Json<Vec<db::BookmarkCollection>>> {
    with_db(&st, |conn| db::list_collections(conn)).map(Json)
}

async fn create_collection(
    State(st): State<AppState>,
    Json(body): Json<CollectionIn>,
) -> ApiResult<(StatusCode, Json<db::BookmarkCollection>)> {
    if body.name.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name cannot be empty"));
    }
    let name = body.name.trim().to_string();
    let c = with_db(&st, |conn| db::create_collection(conn, &name))?;
    Ok((StatusCode::CREATED, Json(c)))
}

async fn delete_collection(State(st): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    with_db(&st, |conn| db::delete_collection(conn, id)).expect("delete collection");
    StatusCode::NO_CONTENT
}

async fn list_bookmarks(
    State(st): State<AppState>,
    Query(q): Query<BookmarkQuery>,
) -> ApiResult<Json<Vec<db::Bookmark>>> {
    let bm = with_db(&st, |conn| {
        db::list_bookmarks(conn, q.collection, &q.q, q.favs)
    })?;
    Ok(Json(bm))
}

/// Previsualiza los metadatos de una URL SIN guardarla (para el formulario).
async fn fetch_bookmark_meta(
    State(_st): State<AppState>,
    Json(body): Json<BookmarkFetchIn>,
) -> ApiResult<Json<meta::PageMeta>> {
    if body.url.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "url cannot be empty"));
    }
    let meta = meta::fetch(body.url.trim()).await.map_err(|e| {
        err(
            StatusCode::BAD_GATEWAY,
            format!("no se pudo leer la página: {e}"),
        )
    })?;
    Ok(Json(meta))
}

async fn create_bookmark(
    State(st): State<AppState>,
    Json(body): Json<BookmarkIn>,
) -> ApiResult<(StatusCode, Json<db::Bookmark>)> {
    let url = body.url.trim();
    if url.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "url cannot be empty"));
    }

    // Captura automática de metadatos (como Raindrop). Si el usuario ya dio
    // título, lo respetamos; si no, intentamos descubrirlo.
    let (mut title, mut excerpt, mut favicon, mut thumbnail) = (
        body.title.clone(),
        body.excerpt.clone(),
        String::new(),
        String::new(),
    );
    if title.trim().is_empty() {
        if let Ok(m) = meta::fetch(url).await {
            title = if m.title.is_empty() {
                url.to_string()
            } else {
                m.title
            };
            if excerpt.is_empty() {
                excerpt = m.excerpt;
            }
            favicon = m.favicon;
            thumbnail = m.thumbnail;
        } else {
            title = url.to_string();
        }
    }

    let bm = with_db(&st, |conn| {
        db::create_bookmark(
            conn,
            body.collection_id,
            url,
            &title,
            &excerpt,
            &body.note,
            &body.tags,
            &favicon,
            &thumbnail,
        )
    })?;
    Ok((StatusCode::CREATED, Json(bm)))
}

async fn delete_bookmark(State(st): State<AppState>, Path(id): Path<i64>) -> StatusCode {
    with_db(&st, |conn| db::delete_bookmark(conn, id)).expect("delete bookmark");
    StatusCode::NO_CONTENT
}

async fn toggle_favorite(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> ApiResult<Json<db::Bookmark>> {
    let bm = with_db(&st, |conn| db::toggle_bookmark_favorite(conn, id))?;
    Ok(Json(bm))
}

// ---------------------------------------------------------------------------
// Inferencia (OpenAI-compatible, opcional)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LlmIn {
    /// Instrucción/pregunta para el modelo (p.ej. "resume esto", "clasifica").
    pub prompt: String,
    /// Texto de la nota sobre el que operar (opcional).
    #[serde(default)]
    pub text: String,
}

async fn llm_status(State(st): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "enabled": st.llm.is_enabled(),
        "model": st.llm.model,
        "base_url": st.llm.base_url,
    }))
}

async fn llm_complete(
    State(st): State<AppState>,
    Json(body): Json<LlmIn>,
) -> ApiResult<Json<serde_json::Value>> {
    if !st.llm.is_enabled() {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "LLM not configured. Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL / OPENAI_MODEL) to enable.",
        ));
    }
    let result = llm::complete(&st.llm, &body.prompt, &body.text)
        .await
        .map_err(|e| err(StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(serde_json::json!({ "result": result })))
}
