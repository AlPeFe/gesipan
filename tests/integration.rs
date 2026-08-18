//! # tests/integration.rs — Tests E2E de la API
//!
//! Levanta la app real contra una BD en memoria y comprueba los flujos
//! principales: crear pizarras, notas, conexiones y exportar a Markdown.
//!
//! Ejecutar con: `cargo test`

use pizarra::api;
use pizarra::db;
use pizarra::state::AppState;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

// Reutilizamos el cliente HTTP de axum para llamar a la app sin red.
use axum::body::Body;
use axum::http::{Request, StatusCode};

/// Construye una instancia de la app con una BD en memoria.
/// Tras `.with_state()` la app ya es un `Router<()>` listo para usar (Service).
fn test_app() -> axum::Router {
    let conn = db::open(":memory:").expect("open in-memory db");
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        llm: pizarra::llm::LlmConfig {
            api_key: String::new(), // deshabilitado
            base_url: "http://localhost/v1".into(),
            model: "test".into(),
        },
    };
    api::router().with_state(state)
}

async fn send(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let builder = Request::builder().method(method).uri(uri);
    let request = match body {
        Some(json) => builder
            .header("content-type", "application/json")
            .body(Body::from(json.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(request).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

#[tokio::test]
async fn full_whiteboard_flow() {
    let app = test_app();

    // 1) Crear una pizarra.
    let (status, board) = send(
        &app,
        "POST",
        "/api/boards",
        Some(serde_json::json!({ "name": "Proyecto Demo" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "create board");
    let board_id = board["id"].as_i64().expect("board id");
    assert_eq!(board["name"], "Proyecto Demo");

    // 2) Listar pizarras: contiene la nuestra.
    let (_, boards) = send(&app, "GET", "/api/boards", None).await;
    assert_eq!(boards.as_array().unwrap().len(), 1);

    // 3) Crear dos notas con estilos distintos.
    let (_, n1) = send(
        &app,
        "POST",
        &format!("/api/boards/{board_id}/notes"),
        Some(serde_json::json!({ "x": 0.0, "y": 0.0, "style": "postit", "color": "yellow" })),
    )
    .await;
    let (_, n2) = send(
        &app,
        "POST",
        &format!("/api/boards/{board_id}/notes"),
        Some(serde_json::json!({ "x": 300.0, "y": 200.0, "style": "pin", "color": "blue" })),
    )
    .await;
    let n1_id = n1["id"].as_i64().unwrap();
    let n2_id = n2["id"].as_i64().unwrap();
    assert_eq!(n1["style"], "postit");
    assert_eq!(n2["style"], "pin");

    // 4) Escribir texto en una nota.
    let (_, updated) = send(
        &app,
        "PATCH",
        &format!("/api/notes/{n1_id}"),
        Some(serde_json::json!({ "text": "Diseño del MVP", "x": 50.0, "y": 25.0 })),
    )
    .await;
    assert_eq!(updated["text"], "Diseño del MVP");
    assert_eq!(updated["x"], 50.0);

    // 5) Conectar las dos notas.
    let (status, conn) = send(
        &app,
        "POST",
        &format!("/api/boards/{board_id}/connections"),
        Some(serde_json::json!({ "from_id": n1_id, "to_id": n2_id, "label": "depende de" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(conn["label"], "depende de");

    // 6) Conexión a sí mismo debe fallar (400).
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/boards/{board_id}/connections"),
        Some(serde_json::json!({ "from_id": n1_id, "to_id": n1_id })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 7) Data completa de la pizarra.
    let (_, data) = send(&app, "GET", &format!("/api/boards/{board_id}/data"), None).await;
    assert_eq!(data["notes"].as_array().unwrap().len(), 2);
    assert_eq!(data["connections"].as_array().unwrap().len(), 1);

    // 8) Export a Markdown.
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/boards/{board_id}/export.md"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 9) LLM deshabilitado por defecto.
    let (status, _) = send(
        &app,
        "POST",
        "/api/llm/complete",
        Some(serde_json::json!({ "prompt": "resume", "text": "hola" })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // 10) Borrar una nota: su conexión se borra en cascada.
    send(&app, "DELETE", &format!("/api/notes/{n2_id}"), None).await;
    let (_, data) = send(&app, "GET", &format!("/api/boards/{board_id}/data"), None).await;
    assert_eq!(data["notes"].as_array().unwrap().len(), 1);
    assert_eq!(data["connections"].as_array().unwrap().len(), 0);

    // 11) Borrar la pizarra: no queda ninguna.
    send(&app, "DELETE", &format!("/api/boards/{board_id}"), None).await;
    let (_, boards) = send(&app, "GET", "/api/boards", None).await;
    assert_eq!(boards.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn export_markdown_content() {
    let app = test_app();

    let (_, board) = send(
        &app,
        "POST",
        "/api/boards",
        Some(serde_json::json!({ "name": "Notas de la reunión" })),
    )
    .await;
    let board_id = board["id"].as_i64().unwrap();

    // Dos notas + conexión, para comprobar el contenido del .md.
    let (_, n1) = send(
        &app,
        "POST",
        &format!("/api/boards/{board_id}/notes"),
        Some(serde_json::json!({ "x": 0.0, "y": 0.0, "style": "postit", "color": "yellow" })),
    )
    .await;
    let (_, n2) = send(
        &app,
        "POST",
        &format!("/api/boards/{board_id}/notes"),
        Some(serde_json::json!({ "x": 10.0, "y": 10.0, "style": "pin", "color": "green" })),
    )
    .await;
    let n1_id = n1["id"].as_i64().unwrap();
    let n2_id = n2["id"].as_i64().unwrap();
    send(
        &app,
        "PATCH",
        &format!("/api/notes/{n1_id}"),
        Some(serde_json::json!({ "text": "Punto A" })),
    )
    .await;
    send(
        &app,
        "PATCH",
        &format!("/api/notes/{n2_id}"),
        Some(serde_json::json!({ "text": "Punto B" })),
    )
    .await;
    send(
        &app,
        "POST",
        &format!("/api/boards/{board_id}/connections"),
        Some(serde_json::json!({ "from_id": n1_id, "to_id": n2_id, "label": "sigue a" })),
    )
    .await;

    // Leer el export .md de verdad.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/boards/{board_id}/export.md"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let md = String::from_utf8(bytes.to_vec()).unwrap();

    assert!(md.contains("# Notas de la reunión"), "title: {md}");
    assert!(md.contains("Punto A"), "note text: {md}");
    assert!(md.contains("Punto B"), "note text: {md}");
    assert!(md.contains("📌 chincheta"), "pin marker: {md}");
    assert!(md.contains("sigue a"), "connection label: {md}");
}
