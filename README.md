# 📌 Gesipan (게시판)

![logo](web/logo.png)

**Gesipan** (게시판 = "tablero de notas" en coreano) es un **whiteboard
infinito** en tu navegador, con notas estilo **post-it** 📝 y **papel con
chincheta** 📌, más una **pestaña de Bookmarks** estilo Raindrop 🔖. Está hecho
en **Rust**, la interfaz está **embebida en un único ejecutable** y los datos
viven en un fichero **SQLite** local.

> Un ejecutable. Sin servidor externo. Sin Node. Sin dependencias del sistema.

---

## ✨ Características

### Whiteboard infinito
- **Lienzo infinito** con **pan** (arrastrar el fondo) y **zoom** (rueda,
  centrada en el cursor).
- **Crear nota con un clic**: selecciona 📝 o 📌 en la barra inferior y haz clic
  en el lienzo. Al crear se abre un **panel inspector** para escribir al momento.
- **Panel inspector**: edita texto, **etiquetas (tags)**, estilo (post-it /
  chincheta) y color de cada nota.
- **Unir notas**: el botón ⤳ dibuja una **flecha física** entre dos notas.
- **Grupos** ▣: un recuadro que agrupa notas. Al arrastrar el grupo se mueven
  las notas que contiene. Redimensionable y con título.
- **Búsqueda**: filtra las notas en pantalla por texto o etiqueta (las que no
  coinciden se atenúan).
- **Privacidad**: marca una nota como 🔒 privada; un **toggle global** difumina
  (blur) las notas privadas, sin ocultarlas del todo.
- **Múltiples pizarras**, **exportación a Markdown** legible por agentes.

### Bookmarks (estilo Raindrop)
- Guarda links con **captura automática de metadatos** (título, descripción,
  favicon y miniatura) al añadir una URL.
- **Colecciones**, **etiquetas**, **favoritos** ⭐ y **búsqueda**.
- Grid **masonry** tipo Raindrop.

### Inferencia opcional (OpenAI-compatible)
Desactivada por defecto. Actívala con una variable de entorno y usa cualquier
API compatible (OpenAI, Ollama, vLLM…).

### Interfaz
Estética **Material 3** (estilo Jetpack Compose / Google): tipografía
**Roboto** embebida, paleta Material, elevation, esquinas redondeadas.

---

## 🚀 Desplegar (ejecutar)

### Opción A — Binario ya compilado

```bash
gesipan
# → Gesipan sirviendo en http://127.0.0.1:8733
```

Abre la URL en el navegador. La primera vez se crea una pizarra de ejemplo y la
base de datos `gesipan.db`.

### Opción B — Compilar desde el código

```bash
cargo build --release
# → target/release/gesipan.exe   (un único ejecutable)
./target/release/gesipan
```

La primera compilación tarda un poco (compila SQLite en C). Las siguientes son
rápidas.

### Exponerla en la red local (LAN)

```bash
GESIPAN_HOST=0.0.0.0 gesipan
```

Abre el puerto `8733` (TCP) en el firewall de Windows. En un perfil de red
*Private* o *Public*:

```powershell
New-NetFirewallRule -DisplayName "Gesipan Local" -Direction Inbound -Protocol TCP -LocalPort 8733 -Action Allow -Profile Any
```

Después accede desde otros dispositivos con `http://<IP-del-equipo>:8733`.

### Como servicio al inicio (Windows)

Regístrala como tarea programada para que arranque sola al iniciar sesión:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\ruta\a\gesipan.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Gesipan" -Action $action -Trigger $trigger -Force
```

### Con Docker (contenedor)

Gesipan está **dockerizada**. La imagen final es mínima (solo el binario, sin
Rust), y la BD + los backups se guardan en un volumen persistente.

```bash
# Construir y arrancar
docker compose up -d --build

# Abrir http://localhost:8733   (o la IP del host desde la LAN)
```

Los datos viven en el volumen `gesipan-data` (`/data` dentro del contenedor), por
lo que **sobreviven** a `docker compose down` y a recrear el contenedor.

Para personalizar (puerto, inferencia, cadencia de backup) edita
`docker-compose.yml`.

---

## 💾 Backup automático de la base de datos

Gesipan hace **backup de la BD SQLite automáticamente**: una copia al arrancar
y luego cada cierto intervalo, sin detener el servicio. Usa la *online backup
API* de SQLite, que produce una copia **consistente** incluso con WAL activo.

| Variable               | Defecto        | Descripción                           |
|------------------------|----------------|---------------------------------------|
| `GESIPAN_BACKUP_DIR`   | `backups/`     | Carpeta donde se guardan los backups  |
| `GESIPAN_BACKUP_EVERY` | `3600`         | Segundos entre backups (por defecto 1h) |
| `GESIPAN_BACKUP_KEEP`  | `24`           | Nº máximo de backups que se conservan |

Los ficheros se llaman `gesipan-YYYYMMDD-HHMMSS.db`. Cuando se supera `KEEP`,
se borran los más antiguos (rotación automática).

### Dónde está la BD
- **Local**: por defecto `gesipan.db` en el directorio de trabajo, o donde digas
  con `GESIPAN_DATA`.
- **Docker**: `/data/gesipan.db`, con los backups en `/data/backups` (volumen
  `gesipan-data`).

### Restaurar un backup
Detén la app y sustituye la BD por una copia de `backups/`:

```bash
cp backups/gesipan-20260818-120000.db gesipan.db
```

---

## ⚙️ Configuración (variables de entorno)

| Variable          | Defecto                | Descripción                            |
|-------------------|------------------------|----------------------------------------|
| `GESIPAN_PORT`    | `8733`                 | Puerto HTTP                            |
| `GESIPAN_HOST`    | `127.0.0.1`            | IP a la que escuchar (`0.0.0.0` = red) |
| `GESIPAN_DATA`    | `gesipan.db`           | Ruta del fichero SQLite                |
| `GESIPAN_BACKUP_DIR` | `backups/`          | Carpeta de backups                     |
| `GESIPAN_BACKUP_EVERY` | `3600`            | Segundos entre backups (1h)            |
| `GESIPAN_BACKUP_KEEP` | `24`               | Copias de backup que se conservan      |
| `OPENAI_API_KEY`  | *(vacío → off)*        | Activa inferencia                      |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL de la API compatible     |
| `OPENAI_MODEL`    | `gpt-4o-mini`          | Modelo a usar                          |

### Inferencia

```bash
# OpenAI
OPENAI_API_KEY=sk-... gesipan

# Ollama local
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3 gesipan
```

Comprueba el estado con `curl http://127.0.0.1:8733/api/llm/status`.

---

## 🖱️ Uso

| Acción | Gestos / controles |
|--------|--------------------|
| **Mover lienzo** | Arrastrar el fondo vacío |
| **Zoom** | Rueda del ratón, o botones ＋/－ de la barra inferior |
| **Crear nota** | Herramienta 📝 o 📌 + **un clic** en el lienzo |
| **Editar / tags / color** | Clic en ✎ de la nota (abre el inspector) |
| **Unir notas** | Botón ⤳ y clic en dos notas |
| **Grupo** | Botón ▣ y clic en el lienzo (arrastra para mover, esquina para redimensionar) |
| **Buscar notas** | Barra superior (por texto o etiqueta) |
| **Privacidad** | 🔒 en el inspector + toggle de la barra superior |
| **Borrar** | 🗑 en la nota, o seleccionar + tecla `Supr` |
| **Pizarras** | Crear (＋), renombrar (doble clic), borrar (✕) en la sidebar |
| **Exportar .md** | Botón `⬇ .md` de la sidebar |
| **Bookmarks** | Pestaña 🔖 de la sidebar |

---

## 📐 Cómo está hecho (arquitectura)

```
src/
├── main.rs    Servidor axum + sirve la UI embebida (rust-embed) + configuración + backup
├── api.rs     Rutas REST (boards, notes, connections, groups, bookmarks, export, LLM)
├── db.rs      Capa SQLite (esquema + CRUD + migraciones + export a Markdown)
├── backup.rs  Backup automático de la BD (online backup API + rotación)
├── llm.rs     Inferencia opcional (OpenAI-compatible, off por defecto)
├── meta.rs    Captura automática de metadatos de URLs (para bookmarks)
└── state.rs   Estado compartido (conexión DB + config LLM)
web/           Frontend vanilla JS (HTML/CSS/JS) + fuentes + logo, embebido en el binario
Dockerfile / docker-compose.yml   Despliegue en contenedor
```

### Stack
- **Backend**: [Rust](https://www.rust-lang.org/) + [axum](https://github.com/tokio-rs/axum) (HTTP) + [rusqlite](https://github.com/rusqlite/rusqlite) con SQLite **bundled**.
- **Frontend**: HTML/CSS/JS **vanilla** (cero dependencias), embebido con [rust-embed](https://github.com/pyrossh/rust-embed).
- **UI**: Material 3 con tipografía **Roboto** embebida.
- **Persistencia**: SQLite (un solo fichero `.db`).

### Por qué un solo ejecutable
La UI se compila *dentro* del binario con `rust-embed`, y SQLite se compila en C
con la feature `bundled` de `rusqlite`. Resultado: **no hay que instalar nada**
en el equipo donde se ejecuta — copias el `.exe` y funciona.

### API

| Método | Ruta                              | Descripción                       |
|--------|-----------------------------------|-----------------------------------|
| GET    | `/api/boards`                     | Lista pizarras                    |
| POST   | `/api/boards`                     | Crea pizarra `{name}`             |
| PATCH  | `/api/boards/{id}`                | Renombra `{name}`                 |
| DELETE | `/api/boards/{id}`                | Borra pizarra                     |
| GET    | `/api/boards/{id}/data`           | Pizarra + notas + conexiones + grupos |
| GET    | `/api/boards/{id}/export.md`      | Exporta a Markdown                |
| POST   | `/api/boards/{id}/notes`          | Crea nota `{x,y,style,color}`     |
| PATCH  | `/api/notes/{id}`                 | Actualiza nota (texto/tags/color/private…) |
| POST   | `/api/notes/{id}/raise`           | Trae al frente                    |
| DELETE | `/api/notes/{id}`                 | Borra nota                        |
| POST   | `/api/boards/{id}/connections`    | Crea conexión `{from_id,to_id}`   |
| DELETE | `/api/connections/{id}`           | Borra conexión                    |
| POST   | `/api/boards/{id}/groups`         | Crea grupo `{x,y}`                |
| PATCH  | `/api/groups/{id}`                | Actualiza grupo (posición/tamaño/título) |
| DELETE | `/api/groups/{id}`                | Borra grupo                       |
| POST   | `/api/llm/complete`               | Inferencia (solo si config.)      |
| GET    | `/api/llm/status`                 | ¿Inferencia disponible?           |
| GET    | `/api/collections`                | Lista colecciones (bookmarks)     |
| POST   | `/api/collections`                | Crea colección `{name}`           |
| DELETE | `/api/collections/{id}`           | Borra colección                   |
| GET    | `/api/bookmarks`                  | Lista bookmarks (filtros)         |
| POST   | `/api/bookmarks`                  | Crea bookmark `{url,...}`         |
| POST   | `/api/bookmarks/fetch`            | Descubre metadatos de una URL     |
| DELETE | `/api/bookmarks/{id}`             | Borra bookmark                    |
| POST   | `/api/bookmarks/{id}/fav`         | Alterna favorito                  |

### Modelo de datos

- **boards** — pizarras (lienzos independientes).
- **notes** — notas con posición `(x, y)` en coordenadas *de mundo*, tamaño,
  texto, `style` (`postit`/`pin`), `color`, orden `z`, `tags` y `private`.
- **connections** — flechas que unen dos notas.
- **groups** — recuadros que agrupan un conjunto de notas.
- **bookmark_collections / bookmarks** — colecciones y links (estilo Raindrop).

Las posiciones se guardan en coordenadas de mundo (no de pantalla), por lo que
son estables ante cambios de zoom.

---

## 🧩 Ampliar

El frontend es vanilla JS a propósito (cero dependencias → binario limpio). El
backend usa `rusqlite` con SQLite *bundled*, así que no hay dependencias del
sistema. Para añadir features: nuevas rutas en `api.rs`, nuevas consultas en
`db.rs`, y su botón/handler en `web/`.

El `app.js` organiza el código por secciones comentadas (cámara, notas, grupos,
conexiones, búsqueda, privacidad, inspector, bookmarks) para que sea fácil de
leer y extender.

---

## 🧪 Tests

```bash
cargo test
```

Los tests de integración arrancan la API con una BD en memoria y comprueban el
flujo completo (pizarras, notas, conexiones, grupos y export a Markdown).

---

## 📄 Licencia

MIT
