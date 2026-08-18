//! # db.rs — Persistencia SQLite
//!
//! Capa de acceso a datos. Usa `rusqlite` con la feature `bundled`, que compila
//! SQLite en C dentro del binario → no hace falta tener SQLite instalado en el
//! sistema. Todo queda en un único fichero `.db`.
//!
//! ## Esquema
//!
//! - **boards**: pizarras. Cada una es un lienzo infinito independiente.
//! - **notes**: notas dentro de una pizarra. Cada nota tiene posición `(x, y)`
//!   en el lienzo, tamaño, texto, un `style` (`postit` | `pin`) y un color.
//! - **connections**: "rayas" que unen dos notas (grafo del whiteboard).
//!
//! Las posiciones `x`/`y` se guardan en coordenadas *de mundo* (es decir, ya
//! escaladas por el zoom), por lo que son estables aunque cambie el zoom.

use rusqlite::{params, Connection};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Tipos de dominio
// ---------------------------------------------------------------------------

/// Nota del whiteboard. `style` distingue post-it amarillo de papel con chincheta.
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    pub id: i64,
    pub board_id: i64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub style: String, // "postit" | "pin"
    pub color: String, // clase CSS o nombre de color
    pub z: i64,        // orden de apilado (mayor = encima)
}

/// Conexión ("raya") entre dos notas.
#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub id: i64,
    pub board_id: i64,
    pub from_id: i64,
    pub to_id: i64,
    pub label: String,
}

/// Pizarra (lienzo infinito).
#[derive(Debug, Clone, Serialize)]
pub struct Board {
    pub id: i64,
    pub name: String,
}

// ---------------------------------------------------------------------------
// Conexión a la base de datos
// ---------------------------------------------------------------------------

/// Abre (o crea) la base de datos en `path` y aplica el esquema.
/// `":memory:"` crea una BD volátil, útil para tests.
pub fn open(path: &str) -> anyhow::Result<Connection> {
    let conn = Connection::open(path)?;
    // WAL mejora concurrencia lectura/escritura y es seguro para una app local.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

/// Crea las tablas si no existen (migración idempotente y manual, sin refinery
/// para mantenerlo simple: este esquema aún es pequeño y estable).
fn migrate(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS boards (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notes (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            x        REAL NOT NULL DEFAULT 0,
            y        REAL NOT NULL DEFAULT 0,
            width    REAL NOT NULL DEFAULT 200,
            height   REAL NOT NULL DEFAULT 160,
            text     TEXT NOT NULL DEFAULT '',
            style    TEXT NOT NULL DEFAULT 'postit',
            color    TEXT NOT NULL DEFAULT 'yellow',
            z        INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS connections (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            from_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            to_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            label    TEXT NOT NULL DEFAULT ''
        );

        -- Pestaña Bookmarks (estilo Raindrop)
        CREATE TABLE IF NOT EXISTS bookmark_collections (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            collection_id INTEGER REFERENCES bookmark_collections(id) ON DELETE SET NULL,
            url           TEXT NOT NULL,
            title         TEXT NOT NULL DEFAULT '',
            excerpt       TEXT NOT NULL DEFAULT '',
            note          TEXT NOT NULL DEFAULT '',
            tags          TEXT NOT NULL DEFAULT '',   -- lista separada por comas
            favicon       TEXT NOT NULL DEFAULT '',
            thumbnail     TEXT NOT NULL DEFAULT '',
            favorite      INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_notes_board  ON notes(board_id);
        CREATE INDEX IF NOT EXISTS idx_conn_board   ON connections(board_id);
        CREATE INDEX IF NOT EXISTS idx_bm_collection ON bookmarks(collection_id);
        "#,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

pub fn list_boards(conn: &Connection) -> anyhow::Result<Vec<Board>> {
    let mut stmt = conn.prepare("SELECT id, name FROM boards ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        Ok(Board {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_board(conn: &Connection, id: i64) -> anyhow::Result<Option<Board>> {
    let mut stmt = conn.prepare("SELECT id, name FROM boards WHERE id = ?1")?;
    let mut rows = stmt.query_map(params![id], |r| {
        Ok(Board {
            id: r.get(0)?,
            name: r.get(1)?,
        })
    })?;
    Ok(rows.next().transpose()?)
}

pub fn create_board(conn: &Connection, name: &str) -> anyhow::Result<Board> {
    conn.execute("INSERT INTO boards (name) VALUES (?1)", params![name])?;
    let id = conn.last_insert_rowid();
    Ok(Board {
        id,
        name: name.to_string(),
    })
}

pub fn rename_board(conn: &Connection, id: i64, name: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE boards SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    Ok(())
}

pub fn delete_board(conn: &Connection, id: i64) -> anyhow::Result<()> {
    // ON DELETE CASCADE borra notas y conexiones de la pizarra automáticamente.
    conn.execute("DELETE FROM boards WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

fn row_to_note(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        board_id: r.get(1)?,
        x: r.get(2)?,
        y: r.get(3)?,
        width: r.get(4)?,
        height: r.get(5)?,
        text: r.get(6)?,
        style: r.get(7)?,
        color: r.get(8)?,
        z: r.get(9)?,
    })
}

pub fn list_notes(conn: &Connection, board_id: i64) -> anyhow::Result<Vec<Note>> {
    let mut stmt = conn.prepare(
        "SELECT id, board_id, x, y, width, height, text, style, color, z
         FROM notes WHERE board_id = ?1 ORDER BY z, id",
    )?;
    let rows = stmt.query_map(params![board_id], row_to_note)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_note(conn: &Connection, id: i64) -> anyhow::Result<Option<Note>> {
    let mut stmt = conn.prepare(
        "SELECT id, board_id, x, y, width, height, text, style, color, z
         FROM notes WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_note)?;
    Ok(rows.next().transpose()?)
}

/// Crea una nota en la parte superior del apilado (z = max + 1).
pub fn create_note(
    conn: &Connection,
    board_id: i64,
    x: f64,
    y: f64,
    style: &str,
    color: &str,
) -> anyhow::Result<Note> {
    let z: i64 = conn.query_row(
        "SELECT COALESCE(MAX(z), 0) + 1 FROM notes WHERE board_id = ?1",
        params![board_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO notes (board_id, x, y, width, height, text, style, color, z)
         VALUES (?1, ?2, ?3, 200, 160, '', ?4, ?5, ?6)",
        params![board_id, x, y, style, color, z],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get_note(conn, id)?.expect("just inserted"))
}

/// Actualiza campos mutables de una nota (posición, tamaño, texto, estilo, color).
pub fn update_note(conn: &Connection, note: &Note) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE notes SET x=?1, y=?2, width=?3, height=?4, text=?5, style=?6, color=?7, z=?8
         WHERE id=?9",
        params![
            note.x,
            note.y,
            note.width,
            note.height,
            note.text,
            note.style,
            note.color,
            note.z,
            note.id
        ],
    )?;
    Ok(())
}

/// Trae una nota al frente (z = max + 1).
pub fn raise_note(conn: &Connection, id: i64) -> anyhow::Result<()> {
    let board_id: i64 = conn.query_row(
        "SELECT board_id FROM notes WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    let z: i64 = conn.query_row(
        "SELECT COALESCE(MAX(z), 0) + 1 FROM notes WHERE board_id = ?1",
        params![board_id],
        |r| r.get(0),
    )?;
    conn.execute("UPDATE notes SET z = ?1 WHERE id = ?2", params![z, id])?;
    Ok(())
}

pub fn delete_note(conn: &Connection, id: i64) -> anyhow::Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Connections (rayas entre notas)
// ---------------------------------------------------------------------------

fn row_to_conn(r: &rusqlite::Row) -> rusqlite::Result<Link> {
    Ok(Link {
        id: r.get(0)?,
        board_id: r.get(1)?,
        from_id: r.get(2)?,
        to_id: r.get(3)?,
        label: r.get(4)?,
    })
}

pub fn list_connections(conn: &Connection, board_id: i64) -> anyhow::Result<Vec<Link>> {
    let mut stmt = conn.prepare(
        "SELECT id, board_id, from_id, to_id, label FROM connections WHERE board_id = ?1",
    )?;
    let rows = stmt.query_map(params![board_id], row_to_conn)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create_connection(
    conn: &Connection,
    board_id: i64,
    from_id: i64,
    to_id: i64,
    label: &str,
) -> anyhow::Result<Link> {
    conn.execute(
        "INSERT INTO connections (board_id, from_id, to_id, label) VALUES (?1, ?2, ?3, ?4)",
        params![board_id, from_id, to_id, label],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Link {
        id,
        board_id,
        from_id,
        to_id,
        label: label.to_string(),
    })
}

pub fn update_connection_label(conn: &Connection, id: i64, label: &str) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE connections SET label = ?1 WHERE id = ?2",
        params![label, id],
    )?;
    Ok(())
}

pub fn delete_connection(conn: &Connection, id: i64) -> anyhow::Result<()> {
    conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Export a Markdown
// ---------------------------------------------------------------------------

/// Exporta una pizarra completa a texto Markdown, pensado para que un agente
/// (o humano) pueda leer la estructura. Incluye el texto de cada nota y las
/// conexiones como vínculos.
pub fn export_board_markdown(conn: &Connection, board_id: i64) -> anyhow::Result<String> {
    let board =
        get_board(conn, board_id)?.ok_or_else(|| anyhow::anyhow!("board {board_id} not found"))?;
    let notes = list_notes(conn, board_id)?;
    let connections = list_connections(conn, board_id)?;

    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", board.name));

    if notes.is_empty() {
        md.push_str("*(pizarra vacía)*\n");
        return Ok(md);
    }

    // Índice numerado de notas.
    md.push_str("## Notas\n\n");
    for (i, n) in notes.iter().enumerate() {
        let style = if n.style == "pin" {
            "📌 chincheta"
        } else {
            "📝 post-it"
        };
        md.push_str(&format!("### [{i}] ({style})\n"));
        if !n.text.trim().is_empty() {
            md.push_str(&n.text);
            md.push('\n');
        }
        md.push('\n');
    }

    // Conexiones como lista de "A -> B".
    if !connections.is_empty() {
        md.push_str("## Conexiones\n\n");
        for c in &connections {
            let from = notes.iter().position(|n| n.id == c.from_id);
            let to = notes.iter().position(|n| n.id == c.to_id);
            if let (Some(f), Some(t)) = (from, to) {
                let lbl = if c.label.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", c.label)
                };
                md.push_str(&format!("- Nota [{f}] → Nota [{t}]{lbl}\n"));
            }
        }
    }

    Ok(md)
}

// ---------------------------------------------------------------------------
// Bookmarks (estilo Raindrop)
// ---------------------------------------------------------------------------

/// Colección de marcadores (equivalente a las "colecciones" de Raindrop).
#[derive(Debug, Clone, Serialize)]
pub struct BookmarkCollection {
    pub id: i64,
    pub name: String,
}

/// Un marcador guardado. `tags` es una lista separada por comas.
#[derive(Debug, Clone, Serialize)]
pub struct Bookmark {
    pub id: i64,
    pub collection_id: Option<i64>,
    pub url: String,
    pub title: String,
    pub excerpt: String,
    pub note: String,
    pub tags: String,
    pub favicon: String,
    pub thumbnail: String,
    pub favorite: bool,
    pub created_at: String,
}

// ---- Colecciones ----

pub fn list_collections(conn: &Connection) -> anyhow::Result<Vec<BookmarkCollection>> {
    let mut stmt = conn.prepare("SELECT id, name FROM bookmark_collections ORDER BY name")?;
    let rows = stmt.query_map([], |r| {
        Ok(BookmarkCollection { id: r.get(0)?, name: r.get(1)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create_collection(conn: &Connection, name: &str) -> anyhow::Result<BookmarkCollection> {
    conn.execute(
        "INSERT INTO bookmark_collections (name) VALUES (?1)",
        params![name],
    )?;
    let id = conn.last_insert_rowid();
    Ok(BookmarkCollection { id, name: name.to_string() })
}

pub fn delete_collection(conn: &Connection, id: i64) -> anyhow::Result<()> {
    // ON DELETE SET NULL desvincula los bookmarks de la colección borrada.
    conn.execute("DELETE FROM bookmark_collections WHERE id = ?1", params![id])?;
    Ok(())
}

// ---- Bookmarks ----

fn row_to_bookmark(r: &rusqlite::Row) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: r.get(0)?,
        collection_id: r.get(1)?,
        url: r.get(2)?,
        title: r.get(3)?,
        excerpt: r.get(4)?,
        note: r.get(5)?,
        tags: r.get(6)?,
        favicon: r.get(7)?,
        thumbnail: r.get(8)?,
        favorite: r.get::<_, i64>(9)? != 0,
        created_at: r.get(10)?,
    })
}

/// Lista bookmarks. Filtros opcionales por colección, texto (title/excerpt/tags)
/// y favoritos.
pub fn list_bookmarks(
    conn: &Connection,
    collection_id: Option<i64>,
    query: &str,
    only_favs: bool,
) -> anyhow::Result<Vec<Bookmark>> {
    let mut sql = String::from(
        "SELECT id, collection_id, url, title, excerpt, note, tags, favicon, thumbnail, favorite, created_at
         FROM bookmarks WHERE 1=1",
    );
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(cid) = collection_id {
        sql.push_str(" AND collection_id = ?");
        params_vec.push(Box::new(cid));
    }
    let q = query.trim().to_lowercase();
    if !q.is_empty() {
        // Búsqueda simple por título, descripción o etiquetas.
        sql.push_str(" AND (lower(title) LIKE ? OR lower(excerpt) LIKE ? OR lower(tags) LIKE ?)");
        let like = format!("%{q}%");
        params_vec.push(Box::new(like.clone()));
        params_vec.push(Box::new(like.clone()));
        params_vec.push(Box::new(like));
    }
    if only_favs {
        sql.push_str(" AND favorite = 1");
    }
    sql.push_str(" ORDER BY favorite DESC, id DESC");

    let mut stmt = conn.prepare(&sql)?;
    let it = stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), row_to_bookmark)?;
    Ok(it.collect::<Result<_, _>>()?)
}

pub fn get_bookmark(conn: &Connection, id: i64) -> anyhow::Result<Option<Bookmark>> {
    let mut stmt = conn.prepare(
        "SELECT id, collection_id, url, title, excerpt, note, tags, favicon, thumbnail, favorite, created_at
         FROM bookmarks WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_bookmark)?;
    Ok(rows.next().transpose()?)
}

/// Crea un bookmark. Se puede pasar un `collection_id` (None → sin colección).
pub fn create_bookmark(
    conn: &Connection,
    collection_id: Option<i64>,
    url: &str,
    title: &str,
    excerpt: &str,
    note: &str,
    tags: &str,
    favicon: &str,
    thumbnail: &str,
) -> anyhow::Result<Bookmark> {
    conn.execute(
        "INSERT INTO bookmarks (collection_id, url, title, excerpt, note, tags, favicon, thumbnail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![collection_id, url, title, excerpt, note, tags, favicon, thumbnail],
    )?;
    let id = conn.last_insert_rowid();
    Ok(get_bookmark(conn, id)?.expect("just inserted"))
}

/// Actualiza los campos editables de un bookmark.
pub fn update_bookmark(conn: &Connection, bm: &Bookmark) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE bookmarks SET collection_id=?1, url=?2, title=?3, excerpt=?4,
         note=?5, tags=?6, favicon=?7, thumbnail=?8, favorite=?9 WHERE id=?10",
        params![
            bm.collection_id,
            bm.url,
            bm.title,
            bm.excerpt,
            bm.note,
            bm.tags,
            bm.favicon,
            bm.thumbnail,
            if bm.favorite { 1 } else { 0 },
            bm.id
        ],
    )?;
    Ok(())
}

pub fn toggle_bookmark_favorite(conn: &Connection, id: i64) -> anyhow::Result<Bookmark> {
    conn.execute(
        "UPDATE bookmarks SET favorite = CASE WHEN favorite = 0 THEN 1 ELSE 0 END WHERE id = ?1",
        params![id],
    )?;
    Ok(get_bookmark(conn, id)?.expect("exists"))
}

pub fn delete_bookmark(conn: &Connection, id: i64) -> anyhow::Result<()> {
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}
