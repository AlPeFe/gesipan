//! # llm.rs — Inferencia opcional (OpenAI-compatible)
//!
//! Módulo **deshabilitado por defecto**. Permite usar cualquier API compatible
//! con OpenAI (OpenAI, Ollama, vLLM, LM Studio, etc.) para hacer inferencia
//! sobre el contenido de las notas. Solo se activa si se define la variable
//! de entorno `OPENAI_API_KEY`.
//!
//! ## Configuración (variables de entorno)
//!
//! | Variable          | Defecto                     | Descripción                          |
//! |-------------------|-----------------------------|--------------------------------------|
//! | `OPENAI_API_KEY`  | *(vacío → deshabilitado)*   | Llave de la API                      |
//! | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL (para Ollama/localhost)     |
//! | `OPENAI_MODEL`    | `gpt-4o-mini`               | Modelo a usar                        |
//!
//! Para usar Ollama local: `OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3`.
//!
//! El cliente es un simple POST a `/chat/completions` siguiendo el protocolo
//! OpenAI Chat Completions.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl LlmConfig {
    /// Carga la config desde variables de entorno. Si no hay `OPENAI_API_KEY`,
    /// queda deshabilitado.
    pub fn from_env() -> Self {
        LlmConfig {
            api_key: std::env::var("OPENAI_API_KEY").unwrap_or_default(),
            base_url: std::env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".to_string()),
            model: std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.api_key.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Payloads del protocolo Chat Completions
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChatMessageOut,
}

#[derive(Deserialize)]
struct ChatMessageOut {
    content: String,
}

// ---------------------------------------------------------------------------
// Llamada a la API
// ---------------------------------------------------------------------------

/// Envía `prompt` (instrucción) y `text` (contenido de la nota) al modelo y
/// devuelve la respuesta de texto.
pub async fn complete(cfg: &LlmConfig, prompt: &str, text: &str) -> anyhow::Result<String> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));

    // Instrucción del sistema: decimos al modelo cómo tratar el texto.
    let system = "Eres un asistente que ayuda a organizar notas. \
                  Responde de forma concisa y en el idioma del texto de la nota.";
    let user_content = if text.trim().is_empty() {
        prompt.to_string()
    } else {
        format!("{prompt}\n\n---\n{text}")
    };

    let body = ChatRequest {
        model: cfg.model.clone(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: system.to_string(),
            },
            ChatMessage {
                role: "user",
                content: user_content,
            },
        ],
        temperature: Some(0.3),
    };

    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text_body = resp.text().await.unwrap_or_default();
        anyhow::bail!("LLM API error {status}: {text_body}");
    }

    let parsed: ChatResponse = resp.json().await?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| anyhow::anyhow!("LLM returned no choices"))
}
