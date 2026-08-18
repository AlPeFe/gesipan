//! # state.rs — Estado compartido de la aplicación
//!
//! `AppState` se clona en cada handler de axum (vía `Arc`) y da acceso a la
//! conexión SQLite y a la configuración de inferencia.

use crate::llm::LlmConfig;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

/// Estado global de la app, compartido por todas las rutas.
#[derive(Clone)]
pub struct AppState {
    /// Conexión SQLite envuelta en `Mutex` porque `rusqlite::Connection`
    /// no es `Sync` (no es segura para uso concurrente sin protección).
    pub db: Arc<Mutex<Connection>>,
    /// Configuración de inferencia (OpenAI-compatible). Vacía/deshabilitada
    /// si no se configuró `OPENAI_API_KEY`.
    pub llm: LlmConfig,
}
