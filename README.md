# 📌 Pizarra — whiteboard infinito + bookmarks (estilo Raindrop)

Un whiteboard infinito en tu navegador: notas estilo **post-it** o **papel con
chincheta**, colocadas libremente sobre un lienzo infinito que puedes arrastrar
y hacer zoom. Soporta **múltiples pizarras**, **conexiones** (rayas) entre notas
y **exportación a Markdown** para que un agente (o un humano) pueda leer la
estructura.

Incluye además una **pestaña de Bookmarks estilo Raindrop**: guarda links con
captura automática de metadatos (título, descripción, favicon y miniatura),
organizados en colecciones, con etiquetas, favoritos y búsqueda.

**Un único ejecutable**: la UI está embebida en el binario y los datos viven en
un fichero SQLite local. Sin servidor externo, sin Node, sin dependencias.

---

## 🚀 Arrancar

```bash
pizarra
# → Pizarra sirviendo en http://127.0.0.1:8733
```

Abre la URL en el navegador. La primera vez se crea una pizarra de ejemplo y la
base de datos `pizarra.db`.

## ⚙️ Configuración (variables de entorno)

| Variable          | Defecto                | Descripción                            |
|-------------------|------------------------|----------------------------------------|
| `PIZARRA_PORT`    | `8733`                 | Puerto HTTP                            |
| `PIZARRA_HOST`    | `127.0.0.1`            | IP a la que escuchar                   |
| `PIZARRA_DATA`    | `pizarra.db`           | Ruta del fichero SQLite                |
| `OPENAI_API_KEY`  | *(vacío → off)*        | Activa inferencia (ver más abajo)      |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL de la API compatible  |
| `OPENAI_MODEL`    | `gpt-4o-mini`          | Modelo a usar                          |

Para exponerla en la LAN: `PIZARRA_HOST=0.0.0.0 pizarra` (revisa el firewall).

## 🧠 Inferencia opcional (OpenAI-compatible)

**Desactivada por defecto.** Si defines `OPENAI_API_KEY`, se activa un endpoint
que permite hacer inferencia sobre el contenido de las notas usando cualquier
API compatible con OpenAI (OpenAI, Ollama, vLLM, LM Studio…).

```bash
# OpenAI
OPENAI_API_KEY=sk-... pizarra

# Ollama local
OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 OPENAI_MODEL=llama3 pizarra
```

Comprueba el estado desde el navegador o con `curl http://127.0.0.1:8733/api/llm/status`.

---

## 🖱️ Cómo se usa

| Acción | Gestos / controles |
|--------|--------------------|
| **Mover lienzo** | Arrastrar el fondo vacío |
| **Zoom** | Rueda del ratón (centrado en el cursor), o botones ＋/－ de la toolbar |
| **Crear nota** | Doble clic en el lienzo |
| **Tipo de nota** | Botón 📝 post-it o 📌 chincheta (antes de crear) |
| **Editar texto** | Clic dentro de la nota y escribir |
| **Mover nota** | Arrastrarla por el cuerpo |
| **Color** | 🎨 en la nota, o elegir el color activo en el selector |
| **Conectar notas** | Botón 〰️ y hacer clic en dos notas |
| **Borrar** | 🗑 en la nota, o seleccionar + tecla `Supr` |
| **Pizarras** | Crear (＋), renombrar (doble clic), borrar (✕) en la sidebar |
| **Exportar .md** | Botón `⬇ .md` de la sidebar |
| **Bookmarks** | Pestaña 🔖 en la sidebar. Añadir link (＋), colecciones, etiquetas, favoritos y búsqueda |

### Pestaña Bookmarks (estilo Raindrop)

- **Añadir link**: pega una URL y pulsa "✨ Descubrir metadatos" para rellenar
  título y descripción automáticamente, o guárdalo directamente (también se
  intenta descubrir solo).
- **Colecciones**: organiza los links en carpetas desde la sidebar.
- **Etiquetas**: separadas por comas, con filtro por búsqueda.
- **Favoritos**: estrella ⭐ en cada tarjeta.
- **Miniatura**: se genera automáticamente con un servicio gratuito de capturas
  de pantalla; si falla, se muestra el favicon.

---

## 📐 Arquitectura

```
src/
├── main.rs    Servidor axum + sirve la UI embebida (rust-embed) + config
├── api.rs     Rutas REST (boards, notes, connections, bookmarks, export, LLM)
├── db.rs      Capa SQLite (esquema + CRUD + export a Markdown)
├── llm.rs     Inferencia opcional (OpenAI-compatible, off por defecto)
├── meta.rs    Captura automática de metadatos de URLs (para bookmarks)
└── state.rs   Estado compartido (conexión DB + config LLM)
web/           Frontend vanilla JS (HTML/CSS/JS), embebido en el binario
```

### API

| Método | Ruta                              | Descripción                    |
|--------|-----------------------------------|--------------------------------|
| GET    | `/api/boards`                     | Lista pizarras                 |
| POST   | `/api/boards`                     | Crea pizarra `{name}`          |
| PATCH  | `/api/boards/{id}`                | Renombra `{name}`              |
| DELETE | `/api/boards/{id}`                | Borra pizarra                  |
| GET    | `/api/boards/{id}/data`           | Pizarra + notas + conexiones   |
| GET    | `/api/boards/{id}/export.md`      | Exporta a Markdown             |
| POST   | `/api/boards/{id}/notes`          | Crea nota `{x,y,style,color}`  |
| PATCH  | `/api/notes/{id}`                 | Actualiza nota                 |
| POST   | `/api/notes/{id}/raise`           | Trae al frente                 |
| DELETE | `/api/notes/{id}`                 | Borra nota                     |
| POST   | `/api/boards/{id}/connections`    | Crea conexión `{from_id,to_id}`|
| DELETE | `/api/connections/{id}`           | Borra conexión                 |
| POST   | `/api/llm/complete`               | Inferencia (solo si config.)   |
| GET    | `/api/llm/status`                 | ¿Inferencia disponible?        |
| GET    | `/api/collections`                | Lista colecciones              |
| POST   | `/api/collections`                | Crea colección `{name}`        |
| DELETE | `/api/collections/{id}`           | Borra colección                |
| GET    | `/api/bookmarks`                  | Lista bookmarks (filtros)      |
| POST   | `/api/bookmarks`                  | Crea bookmark `{url,...}`      |
| POST   | `/api/bookmarks/fetch`            | Descubre metadatos de una URL  |
| DELETE | `/api/bookmarks/{id}`             | Borra bookmark                 |
| POST   | `/api/bookmarks/{id}/fav`         | Alterna favorito               |

### Modelo de datos

- **boards** — pizarras (lienzos independientes).
- **notes** — notas con posición `(x, y)` en coordenadas *de mundo*, tamaño,
  texto, `style` (`postit`/`pin`), `color` y orden `z`.
- **connections** — rayas que unen dos notas (grafo del whiteboard).

Las posiciones se guardan en coordenadas de mundo (no de pantalla), por lo que
son estables ante cambios de zoom.

### Ampliar

El frontend es vanilla JS deliberadamente (cero dependencias → binario limpio).
El backend usa `rusqlite` con SQLite *bundled*, así que no hay dependencias del
sistema. Para añadir features: nuevas rutas en `api.rs`, nuevas consultas en
`db.rs`, y su botón/handler en `web/`.

---

## 🛠️ Build

```bash
cargo build --release
# → target/release/pizarra.exe  (un único ejecutable)
```

La primera compilación tarda un poco (compila SQLite en C). Las siguientes son
rápidas.

## 📄 Licencia

MIT
