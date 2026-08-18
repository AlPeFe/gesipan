//! # backup.rs — Backup automático de la base de datos
//!
//! Copia la BD SQLite a una carpeta de backups de forma periódica y segura.
//! Usa la API *online backup* de SQLite (`rusqlite::backup::Backup`), que
//! produce una copia consistente incluso con el journal mode WAL activo.
//!
//! ## Configuración (variables de entorno)
//!
//! | Variable               | Defecto        | Descripción                            |
//! |------------------------|----------------|----------------------------------------|
//! | `GESIPAN_BACKUP_DIR`   | `backups/`     | Carpeta donde guardar los backups      |
//! | `GESIPAN_BACKUP_EVERY` | `3600`         | Segundos entre backups (por defecto 1h)|
//! | `GESIPAN_BACKUP_KEEP`  | `24`           | Nº máximo de backups que se conservan  |
//!
//! Los ficheros se nombran `gesipan-YYYYMMDD-HHMMSS.db`. La rotación borra los
//! más antiguos cuando se supera `KEEP`.

use rusqlite::{backup::Backup, Connection};
use std::path::{Path, PathBuf};

/// Configuración del backup.
#[derive(Debug, Clone)]
pub struct BackupConfig {
    pub dir: PathBuf,
    pub every_secs: u64,
    pub keep: usize,
}

impl BackupConfig {
    /// Carga la config desde variables de entorno con valores por defecto.
    pub fn from_env() -> Self {
        let dir = std::env::var("GESIPAN_BACKUP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("backups"));
        let every_secs = std::env::var("GESIPAN_BACKUP_EVERY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600);
        let keep = std::env::var("GESIPAN_BACKUP_KEEP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(24);
        BackupConfig { dir, every_secs, keep }
    }
}

/// Realiza una copia de seguridad de `src` en `dest` usando la API de backup
/// online de SQLite (consistente aunque la BD esté en WAL).
pub fn backup_database(src: &Connection, dest: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut dst = Connection::open(dest)?;
    let backup = Backup::new(src, &mut dst)?;
    // 1000 páginas por paso, 100ms de pausa entre pasos, sin callback.
    backup.run_to_completion(1000, std::time::Duration::from_millis(100), None)?;
    Ok(())
}

/// Genera el nombre de fichero `gesipan-YYYYMMDD-HHMMSS.db`.
fn backup_filename(now: &chrono::DateTime<chrono::Utc>) -> String {
    format!("gesipan-{}.db", now.format("%Y%m%d-%H%M%S"))
}

/// Borra los backups más antiguos cuando hay más de `keep`.
fn prune(dir: &Path, keep: usize) -> anyhow::Result<()> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|e| e == "db")
                .unwrap_or(false)
                && p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("gesipan-"))
                    .unwrap_or(false)
        })
        .collect();

    // Ordena por nombre (el timestamp está en el nombre → orden cronológico).
    files.sort();
    let count = files.len();
    if count > keep {
        for old in files.into_iter().take(count - keep) {
            let _ = std::fs::remove_file(&old);
        }
    }
    Ok(())
}

/// Ejecuta un ciclo de backup: copia la BD y poda los antiguos.
/// `db` es la conexión abierta de la app (ya protegida por el Mutex del estado).
pub fn run_backup(db: &Connection, cfg: &BackupConfig) -> anyhow::Result<PathBuf> {
    let now = chrono::Utc::now();
    let dest = cfg.dir.join(backup_filename(&now));
    backup_database(db, &dest)?;
    prune(&cfg.dir, cfg.keep)?;
    Ok(dest)
}
