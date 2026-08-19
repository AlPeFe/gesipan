<p align="center">
  <img src="web/logo.png" alt="gesipan" width="160" />
</p>

<h1 align="center">gesipan · 게시판</h1>

<p align="center">
  A cozy infinite whiteboard + bookmarks manager, served from a single binary.
</p>

<p align="center">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.97+-DEA584?logo=rust&logoColor=white" />
  <img alt="Axum" src="https://img.shields.io/badge/Axum-0.8-000000?logo=axum&logoColor=white" />
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white" />
  <img alt="Vanilla JS" src="https://img.shields.io/badge/UI-Vanilla%20JS-F7DF1E?logo=javascript&logoColor=black" />
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue" />
</p>

---

## What is gesipan?

**gesipan** (게시판 = "tablero de notas" en coreano) es un **whiteboard infinito**
con notas estilo *post-it* y *papel con chincheta*, más una pestaña de
**bookmarks** estilo Raindrop. Todo en un **único ejecutable** con la interfaz
embebida y los datos en un fichero **SQLite** local.

> Un binario. Sin servidor externo. Sin Node. Sin dependencias del sistema.

## What it does

- **Whiteboard infinito** — lienzo sin fin con *pan* y *zoom* centrado en el cursor.
- **Notas post-it / chincheta** — arrastrables, redimensionables, con **etiquetas**,
  **colores** y **estilo** elegibles.
- **Grupos** ▣ — recuadros que agrupan notas y las mueven en conjunto; con
  **título** y **color**. Las notas ancladas quedan recluidas dentro del grupo.
- **Unir notas** ⤳ — flechas orgánicas dibujadas a mano, de **punto de anclaje a
  punto de anclaje**.
- **Privacidad** 🙈 — las notas privadas se difuminan (blur del contenido); un
  toggle global las revela u oculta.
- **Bookmarks estilo Raindrop** — captura automática de metadatos (título,
  descripción, favicon, miniatura), **colecciones**, **favoritos**, **tags** y
  búsqueda, en **lista con detalle visual**.
- **Papelera de reciclaje** — al borrar, notas y bookmarks van a la papelera
  (soft-delete) y se pueden restaurar o purgar.
- **MCP server** 🤖 — para que agentes de IA organicen el contenido automáticamente.
- **Backup automático** de la BD SQLite (consistente, con rotación).
- **Múltiples boards** y **exportación a Markdown** legible por agentes.

## How to use it

1. **Arranca** `gesipan` (o `target/release/gesipan.exe`).
2. Abre **http://127.0.0.1:8733** en el navegador.
3. Pulsa el botón **＋** de la barra inferior para crear una nota, grupo, etc.
4. En la pestaña **Bookmarks**, añade links con **＋** (descubre metadatos
   automáticamente).

Para acceder desde la LAN: `GESIPAN_HOST=0.0.0.0` y abre el puerto `8733`.

## Tech stack

| Capa        | Tecnología |
|-------------|-----------|
| Backend     | Rust + axum (HTTP) + rusqlite (SQLite **bundled**) |
| Frontend    | HTML/CSS/JS **vanilla**, embebido con rust-embed |
| UI          | Estética **editorial** (Plus Jakarta Sans), temas claro/oscuro |
| Persistencia| SQLite (un solo fichero `.db`) |

## Screenshots

<p align="center">
  <em>Whiteboard infinito · notas, grupos, flechas y privacidad.</em>
</p>

---

## Deployment

### Option A — Prebuilt binary

```bash
gesipan
# → Gesipan sirviendo en http://127.0.0.1:8733
```

### Option B — Build from source

```bash
cargo build --release
# → target/release/gesipan.exe   (a single binary)
./target/release/gesipan
```

### Expose on the LAN

```bash
GESIPAN_HOST=0.0.0.0 gesipan
```

Open TCP port `8733` in the firewall:

```powershell
New-NetFirewallRule -DisplayName "Gesipan Local" -Direction Inbound -Protocol TCP -LocalPort 8733 -Action Allow -Profile Any
```

### Run as a Windows startup service

```powershell
$action = New-ScheduledTaskAction -Execute "C:\path\to\gesipan.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Gesipan" -Action $action -Trigger $trigger -Force
```

### Docker

Gesipan is **dockerized**. The final image is minimal (only the binary), and the
DB + backups live in a persistent volume.

```bash
docker compose up -d --build
# → http://localhost:8733   (or the host IP from the LAN)
```

Data lives in the `gesipan-data` volume (`/data`), so it **survives**
`docker compose down` and container recreation.

---

## Automatic database backup

Gesipan backs up its SQLite DB automatically: one copy on startup, then every
interval — without stopping the service. It uses SQLite's *online backup API*,
so the copy is **consistent** even with WAL active.

| Variable             | Default     | Description                          |
|----------------------|-------------|--------------------------------------|
| `GESIPAN_BACKUP_DIR` | `backups/`  | Folder where backups are written     |
| `GESIPAN_BACKUP_EVERY`| `3600`     | Seconds between backups (1h)         |
| `GESIPAN_BACKUP_KEEP`| `24`        | Max number of backups to keep        |

Files are named `gesipan-YYYYMMDD-HHMMSS.db`. Old ones are pruned (rotation).

### Where the DB lives

- **Local**: `gesipan.db` in the working directory (or `GESIPAN_DATA`).
- **Docker**: `/data/gesipan.db`, backups in `/data/backups` (volume `gesipan-data`).

### Restore a backup

```bash
cp backups/gesipan-20260818-120000.db gesipan.db
```

---

## MCP (AI-driven organization)

Gesipan exposes an **MCP server** on the same port at `/mcp` (Streamable HTTP),
so AI agents can organize content automatically.

### Tools

| Tool               | Description                                  |
|--------------------|----------------------------------------------|
| `list_boards`      | List all boards                              |
| `create_note`      | Create a note (text/tags/style/color)        |
| `list_notes`       | List notes in a board                        |
| `list_bookmarks`   | List all bookmarks                           |
| `add_bookmark`     | Add a bookmark (collection + tags)           |
| `organize_bookmark`| Move a bookmark / set its tags               |
| `create_collection`| Create a bookmark collection                 |

### Register it in Hermes

```bash
hermes config set mcp_servers.gesipan.url "http://127.0.0.1:8733/mcp"
hermes config set mcp_servers.gesipan.timeout 180
hermes mcp list    # should show ✓ enabled
hermes mcp test gesipan   # ✓ Connected + tools
```

Tools appear as `mcp_gesipan_*`. For Claude Desktop / Cursor, add
`{"mcpServers":{"gesipan":{"url":"http://127.0.0.1:8733/mcp"}}}` to their config.

> `/mcp` only accepts local (loopback) connections, so Hermes must run on the
> same machine, or the tunnel must not expose it publicly.

---

## Configuration (env vars)

| Variable            | Default                   | Description                         |
|---------------------|---------------------------|-------------------------------------|
| `GESIPAN_PORT`      | `8733`                    | HTTP port                           |
| `GESIPAN_HOST`      | `127.0.0.1`               | Listen address (`0.0.0.0` = LAN)    |
| `GESIPAN_DATA`      | `gesipan.db`              | SQLite file path                    |
| `GESIPAN_BACKUP_DIR`| `backups/`                | Backup folder                       |
| `GESIPAN_BACKUP_EVERY`| `3600`                  | Seconds between backups (1h)        |
| `GESIPAN_BACKUP_KEEP`| `24`                     | Backups to keep                     |
| `OPENAI_API_KEY`    | *(empty → off)*            | Enables inference                   |
| `OPENAI_BASE_URL`   | `https://api.openai.com/v1` | Compatible API base URL            |
| `OPENAI_MODEL`      | `gpt-4o-mini`             | Model to use                        |

### Inference

```bash
# OpenAI
OPENAI_API_KEY=sk-... gesipan

# Local Ollama
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3 gesipan
```

Check status with `curl http://127.0.0.1:8733/api/llm/status`.

---

## Usage

| Action                  | How                                             |
|-------------------------|-------------------------------------------------|
| **Move canvas**         | Drag the empty background                       |
| **Zoom**                | Mouse wheel, or ＋/－ in the bottom bar          |
| **Create**              | Press **＋**, pick the type, click on the canvas |
| **Edit / tags / color** | Click a note (contextual popup)                 |
| **Move a note**         | Drag it by its body                             |
| **Join notes**          | Open a note → **⤳ Unir**, drag anchor→anchor    |
| **Group**               | Create from **＋**; select it to edit title/color|
| **Privacy**             | 👁️ in the toolbar (create private) + global toggle |
| **Delete**              | 🗑 in the note, or select + `Supr`              |
| **Boards**              | Create (＋), rename (dblclick), delete (✕)      |
| **Export .md**          | `⬇ .md` button in the sidebar                   |
| **Bookmarks**           | **Bookmarks** tab in the sidebar                |

---

## How it's built (architecture)

```
src/
├── main.rs    axum server + serves embedded UI (rust-embed) + config + backup
├── api.rs     REST routes (boards, notes, connections, groups, bookmarks, trash, export, LLM)
├── db.rs      SQLite layer (schema + CRUD + migrations + Markdown export + trash)
├── backup.rs  Automatic DB backup (online backup API + rotation)
├── llm.rs     Optional inference (OpenAI-compatible, off by default)
├── meta.rs    Automatic URL metadata capture (bookmarks)
├── mcp.rs     MCP server (Streamable HTTP) for AI organization
└── state.rs   Shared state (DB connection + LLM config)
web/           Vanilla JS frontend (HTML/CSS/JS) + fonts + logo, embedded in the binary
Dockerfile / docker-compose.yml   Container deployment
```

### Why a single executable

The UI is compiled *inside* the binary with `rust-embed`, and SQLite is compiled
in C with rusqlite's `bundled` feature. Result: **nothing to install** on the
target machine — copy the `.exe` and it works.

### API

| Method | Route                          | Description                          |
|--------|--------------------------------|--------------------------------------|
| GET    | `/api/boards`                  | List boards                          |
| POST   | `/api/boards`                  | Create board `{name}`                |
| PATCH  | `/api/boards/{id}`             | Rename `{name}`                      |
| DELETE | `/api/boards/{id}`             | Delete board                         |
| GET    | `/api/boards/{id}/data`        | Board + notes + connections + groups |
| GET    | `/api/boards/{id}/export.md`   | Export to Markdown                   |
| POST   | `/api/boards/{id}/notes`       | Create note `{x,y,style,color}`      |
| PATCH  | `/api/notes/{id}`              | Update note (text/tags/color/private…) |
| POST   | `/api/notes/{id}/raise`        | Bring to front                        |
| DELETE | `/api/notes/{id}`              | Delete note                           |
| POST   | `/api/boards/{id}/connections` | Create connection `{from_id,to_id}`  |
| DELETE | `/api/connections/{id}`        | Delete connection                    |
| POST   | `/api/boards/{id}/groups`      | Create group `{x,y}`                 |
| PATCH  | `/api/groups/{id}`             | Update group (pos/size/title/color)  |
| DELETE | `/api/groups/{id}`             | Delete group                         |
| POST   | `/api/llm/complete`            | Inference (only if configured)       |
| GET    | `/api/llm/status`              | Is inference available?              |
| GET    | `/api/collections`             | List bookmark collections            |
| POST   | `/api/collections`             | Create collection `{name}`           |
| DELETE | `/api/collections/{id}`        | Delete collection                    |
| GET    | `/api/bookmarks`               | List bookmarks (filters)             |
| POST   | `/api/bookmarks`               | Create bookmark `{url,...}`          |
| POST   | `/api/bookmarks/fetch`         | Discover URL metadata                |
| DELETE | `/api/bookmarks/{id}`          | Delete bookmark                      |
| POST   | `/api/bookmarks/{id}/fav`      | Toggle favorite                      |

### Data model

- **boards** — independent canvases.
- **notes** — notes with world-coordinate position `(x,y)`, size, text,
  `style` (`postit`/`pin`), `color`, `z`-order, `tags`, `private` and optional `group_id`.
- **connections** — arrows joining two notes (anchor→anchor).
- **groups** — boxes that group notes (with `title` and `color`).
- **bookmark_collections / bookmarks** — collections and links (Raindrop-style).

Positions are stored in *world* coordinates (not screen), so they stay stable
across zoom changes.

---

## Extending

The frontend is deliberately vanilla JS (zero dependencies → clean binary). The
backend uses `rusqlite` with SQLite *bundled*, so there are no system
dependencies. To add features: new routes in `api.rs`, new queries in `db.rs`,
and their button/handler in `web/`.

`app.js` organizes the code by commented sections (camera, notes, groups,
connections, search, privacy, inspector, bookmarks) for easy reading and extending.

---

## Tests

```bash
cargo test
```

Integration tests boot the API with an in-memory DB and exercise the full flow
(boards, notes, connections, groups, and Markdown export).

---

## License

MIT
