//! # Pizarra — librería
//!
//! Expone los módulos internos para que los tests de integración (y cualquier
//! consumidor del crate) puedan usarlos. El binario (`main.rs`) también depende
//! de esta librería.

pub mod api;
pub mod db;
pub mod llm;
pub mod meta;
pub mod state;
