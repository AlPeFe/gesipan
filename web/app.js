/* =========================================================================
   Pizarra — lógica del whiteboard infinito (vanilla JS, sin dependencias)

   Ideas clave del modelo de "pizarra infinita":
   - Hay un "mundo" (#world) que contiene las notas.
   - La cámara se representa con { x, y, zoom } y se aplica al mundo con un
     transform CSS:  translate(x, y) scale(zoom).
   - Las notas se guardan en coordenadas DE MUNDO (ya escaladas). Al arrastrar
     una nota, convertimos píxeles de pantalla -> coordenadas de mundo
     dividiendo por el zoom. Así las posiciones son estables al hacer zoom.
   ========================================================================= */

"use strict";

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
const state = {
  boards: [],            // lista de pizarras
  currentBoardId: null,  // pizarra activa
  notes: [],             // notas de la pizarra activa
  connections: [],       // conexiones de la pizarra activa

  // Cámara (pan/zoom)
  cam: { x: 0, y: 0, zoom: 1 },

  // Modo de herramienta: "postit" | "pin" | "connect"
  tool: "postit",
  activeColor: "yellow",

  // Estado de conexión: al hacer clic en la 1ª nota guardamos su id
  connectFrom: null,
  selectedNoteId: null,

  // Drag de notas / pan
  drag: null,        // { noteId, dx, dy } en coords mundo
  panning: false,
};

// ---------------------------------------------------------------------------
// Referencias a elementos del DOM
// ---------------------------------------------------------------------------
const el = {
  board: document.getElementById("board"),
  world: document.getElementById("world"),
  connectionsLayer: document.getElementById("connections-layer"),
  boardList: document.getElementById("board-list"),
  zoomLabel: document.getElementById("zoom-label"),
  connectHint: document.getElementById("connect-hint"),
  colorPicker: document.getElementById("color-picker"),
  llmDot: document.getElementById("llm-dot"),
  modal: document.getElementById("modal"),
  modalInput: document.getElementById("modal-input"),
};

// ---------------------------------------------------------------------------
// Helpers de API (fetch unificado)
// ---------------------------------------------------------------------------
async function api(path, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Cámara: aplicar transform y convertir coordenadas
// ---------------------------------------------------------------------------
function applyCamera() {
  el.world.style.transform = `translate(${state.cam.x}px, ${state.cam.y}px) scale(${state.cam.zoom})`;
  el.zoomLabel.textContent = Math.round(state.cam.zoom * 100) + "%";
  drawConnections();
}

// Píxeles de pantalla relativos al board -> coordenadas de mundo.
function screenToWorld(sx, sy) {
  const rect = el.board.getBoundingClientRect();
  const px = sx - rect.left - state.cam.x;
  const py = sy - rect.top - state.cam.y;
  return { x: px / state.cam.zoom, y: py / state.cam.zoom };
}

// Centro visual del board en coords de mundo (para colocar notas nuevas).
function viewCenter() {
  const rect = el.board.getBoundingClientRect();
  return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

// ---------------------------------------------------------------------------
// Cargar pizarras y pizarra activa
// ---------------------------------------------------------------------------
async function loadBoards() {
  state.boards = await api("/api/boards");
  renderBoardList();

  // Selecciona la primera pizarra si no hay ninguna activa válida.
  const exists = state.boards.some((b) => b.id === state.currentBoardId);
  if (!exists && state.boards.length > 0) {
    await loadBoard(state.boards[0].id);
  }
}

function renderBoardList() {
  el.boardList.innerHTML = "";
  for (const b of state.boards) {
    const item = document.createElement("div");
    item.className = "board-item" + (b.id === state.currentBoardId ? " active" : "");
    item.textContent = b.name;

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Borrar pizarra";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Borrar la pizarra "${b.name}" y todas sus notas?`)) return;
      await api(`/api/boards/${b.id}`, "DELETE");
      await loadBoards();
    });
    item.appendChild(del);

    item.addEventListener("click", () => loadBoard(b.id));
    el.boardList.appendChild(item);
  }
}

async function loadBoard(id) {
  state.currentBoardId = id;
  const data = await api(`/api/boards/${id}/data`);
  state.notes = data.notes;
  state.connections = data.connections;
  state.connectFrom = null;
  state.selectedNoteId = null;
  renderBoardList();
  renderNotes();
  drawConnections();
}

// ---------------------------------------------------------------------------
// Render de notas
// ---------------------------------------------------------------------------
function renderNotes() {
  el.world.innerHTML = "";
  for (const n of state.notes) {
    el.world.appendChild(createNoteEl(n));
  }
}

function createNoteEl(n) {
  const div = document.createElement("div");
  div.className = `note ${n.style} ${n.color}`;
  div.dataset.id = n.id;
  div.style.left = n.x + "px";
  div.style.top = n.y + "px";
  div.style.width = n.width + "px";
  div.style.height = n.height + "px";
  div.style.zIndex = n.z;

  // Chincheta decorativa
  if (n.style === "pin") {
    const pin = document.createElement("div");
    pin.className = "pin-head";
    div.appendChild(pin);
  }

  // Contenido editable
  const content = document.createElement("div");
  content.className = "content";
  content.contentEditable = "true";
  content.textContent = n.text;
  content.spellcheck = false;
  content.addEventListener("input", () => {
    n.text = content.textContent;
    saveNote(n);
  });
  div.appendChild(content);

  // Barra de acciones
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(actionBtn("🎨", "Cambiar color", () => openColorPicker(n, div)));
  actions.appendChild(actionBtn("⬆", "Traer al frente", () => raiseNote(n, div)));
  if (state.connections.length) {
    actions.appendChild(actionBtn("〰️", "Conectar", () => startConnect(n)));
  }
  actions.appendChild(actionBtn("🗑", "Eliminar", () => deleteNote(n)));
  div.appendChild(actions);

  attachNoteEvents(div, n);
  return div;
}

function actionBtn(label, title, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// ---------------------------------------------------------------------------
// Eventos: drag de notas, selección, conexión
// ---------------------------------------------------------------------------
function attachNoteEvents(div, n) {
  // Click en la nota -> seleccionar / iniciar conexión
  div.addEventListener("mousedown", (e) => {
    // Ignorar clicks en botones de acciones o en el contenido editando.
    if (e.target.closest(".actions")) return;
    if (e.target.classList.contains("content")) return;

    state.selectedNoteId = n.id;
    setSelected();

    if (state.tool === "connect") {
      handleConnectClick(n);
      return;
    }

    startNoteDrag(e, n, div);
  });
}

// Drag de una nota: actualiza posición en mundo (divide por zoom).
function startNoteDrag(e, note, div) {
  e.preventDefault();
  const rect = div.getBoundingClientRect();
  const worldPos = screenToWorld(rect.left, rect.top);
  const startX = worldPos.x - note.x;
  const startY = worldPos.y - note.y;

  state.drag = { noteId: note.id, offX: startX, offY: startY };

  const onMove = (ev) => {
    const w = screenToWorld(ev.clientX, ev.clientY);
    note.x = w.x - state.drag.offX;
    note.y = w.y - state.drag.offY;
    div.style.left = note.x + "px";
    div.style.top = note.y + "px";
    drawConnections();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    state.drag = null;
    saveNote(note);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

// ---------------------------------------------------------------------------
// Pan del lienzo (arrastrar el fondo vacío)
// ---------------------------------------------------------------------------
el.board.addEventListener("mousedown", (e) => {
  // Solo pan cuando se arrastra el fondo vacío (#board) — no sobre una nota,
  // la toolbar, el color picker ni otros controles (son elementos distintos).
  if (e.button !== 0 || e.target !== el.board) return;
  state.panning = true;
  el.board.classList.add("panning");
  const startCamX = state.cam.x, startCamY = state.cam.y;
  const startX = e.clientX, startY = e.clientY;

  const onMove = (ev) => {
    state.cam.x = startCamX + (ev.clientX - startX);
    state.cam.y = startCamY + (ev.clientY - startY);
    applyCamera();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    state.panning = false;
    el.board.classList.remove("panning");
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

// ---------------------------------------------------------------------------
// Zoom (rueda) centrado en el cursor
// ---------------------------------------------------------------------------
el.board.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = el.board.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  // Punto del mundo bajo el cursor antes del zoom.
  const before = {
    x: (sx - state.cam.x) / state.cam.zoom,
    y: (sy - state.cam.y) / state.cam.zoom,
  };

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  state.cam.zoom = Math.min(3, Math.max(0.25, state.cam.zoom * factor));

  // Ajusta la cámara para que ese punto siga bajo el cursor.
  state.cam.x = sx - before.x * state.cam.zoom;
  state.cam.y = sy - before.y * state.cam.zoom;
  applyCamera();
});

// ---------------------------------------------------------------------------
// Herramientas (postit / pin / connect)
// ---------------------------------------------------------------------------
function setTool(tool) {
  state.tool = tool;
  document.getElementById("postit-btn").classList.toggle("active", tool === "postit");
  document.getElementById("pin-btn").classList.toggle("active", tool === "pin");
  const cb = document.getElementById("connect-btn");
  cb.classList.toggle("connect-active", tool === "connect");
  el.colorPicker.classList.toggle("hidden", tool === "connect");
  el.connectHint.classList.toggle("hidden", tool !== "connect");
  if (tool !== "connect") state.connectFrom = null;
}

// Doble clic en el fondo -> crear nota en ese punto.
el.board.addEventListener("dblclick", (e) => {
  if (e.target !== el.board) return;
  const w = screenToWorld(e.clientX, e.clientY);
  createNote(w.x, w.y);
});

async function createNote(x, y) {
  const style = state.tool === "pin" ? "pin" : "postit";
  const note = await api(`/api/boards/${state.currentBoardId}/notes`, "POST", {
    x, y, style, color: state.activeColor,
  });
  state.notes.push(note);
  const div = createNoteEl(note);
  el.world.appendChild(div);
  // Enfoca el contenido para editar al instante.
  div.querySelector(".content").focus();
  drawConnections();
}

// ---------------------------------------------------------------------------
// Conexiones
// ---------------------------------------------------------------------------
function startConnect(n) {
  setTool("connect");
  state.connectFrom = n.id;
  state.selectedNoteId = n.id;
  setSelected();
}

function handleConnectClick(n) {
  if (state.connectFrom === null) {
    state.connectFrom = n.id;
    state.selectedNoteId = n.id;
    setSelected();
  } else if (state.connectFrom === n.id) {
    // Mismo clic: cancelar selección inicial.
    state.connectFrom = null;
  } else {
    api(`/api/boards/${state.currentBoardId}/connections`, "POST", {
      from_id: state.connectFrom, to_id: n.id, label: "",
    }).then((c) => {
      state.connections.push(c);
      state.connectFrom = null;
      drawConnections();
    }).catch((err) => alert(err.message));
  }
}

// Dibuja las rayas entre notas, con el centro de cada nota como extremo.
function drawConnections() {
  el.connectionsLayer.innerHTML = "";
  for (const c of state.connections) {
    const from = state.notes.find((n) => n.id === c.from_id);
    const to = state.notes.find((n) => n.id === c.to_id);
    if (!from || !to) continue;

    // Centro en coords de mundo -> pantalla (incluye pan y zoom).
    const fx = state.cam.x + (from.x + from.width / 2) * state.cam.zoom;
    const fy = state.cam.y + (from.y + from.height / 2) * state.cam.zoom;
    const tx = state.cam.x + (to.x + to.width / 2) * state.cam.zoom;
    const ty = state.cam.y + (to.y + to.height / 2) * state.cam.zoom;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "conn");
    // Línea con curvatura suave (bezier) para que se vea orgánica.
    const mx = (fx + tx) / 2, my = (fy + ty) / 2;
    path.setAttribute("d", `M ${fx} ${fy} Q ${mx} ${my} ${tx} ${ty}`);

    // Etiqueta en el punto medio si hay texto.
    if (c.label) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("class", "conn-label");
      text.setAttribute("x", mx);
      text.setAttribute("y", my - 6);
      text.setAttribute("text-anchor", "middle");
      text.textContent = c.label;
      el.connectionsLayer.appendChild(text);
    }

    el.connectionsLayer.appendChild(path);
  }
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------
function saveNote(n) {
  api(`/api/notes/${n.id}`, "PATCH", {
    x: n.x, y: n.y, width: n.width, height: n.height, text: n.text,
    style: n.style, color: n.color,
  }).catch((err) => console.error(err));
}

function raiseNote(n, div) {
  api(`/api/notes/${n.id}/raise`, "POST").then(() => {
    n.z = (Math.max(...state.notes.map((x) => x.z)) + 1);
    div.style.zIndex = n.z;
  });
}

async function deleteNote(n) {
  await api(`/api/notes/${n.id}`, "DELETE");
  state.notes = state.notes.filter((x) => x.id !== n.id);
  state.connections = state.connections.filter((c) => c.from_id !== n.id && c.to_id !== n.id);
  if (state.selectedNoteId === n.id) state.selectedNoteId = null;
  renderNotes();
  drawConnections();
}

// ---------------------------------------------------------------------------
// Selección / color
// ---------------------------------------------------------------------------
function setSelected() {
  for (const d of el.world.children) {
    d.classList.toggle("selected", Number(d.dataset.id) === state.selectedNoteId);
  }
}

function openColorPicker(n, div) {
  el.colorPicker.classList.toggle("hidden");
  const pick = async (color) => {
    n.color = color;
    div.className = `note ${n.style} ${color}`;
    saveNote(n);
    el.colorPicker.classList.add("hidden");
  };
  // Limpia listeners previos para no acumular.
  for (const s of el.colorPicker.querySelectorAll(".swatch")) {
    s.onclick = () => {
      el.colorPicker.querySelectorAll(".swatch").forEach((x) => x.classList.remove("active"));
      s.classList.add("active");
      state.activeColor = s.dataset.color;
      pick(s.dataset.color);
    };
  }
}

// ---------------------------------------------------------------------------
// Pizarras: crear / renombrar / exportar
// ---------------------------------------------------------------------------
function openModal(placeholder, onSubmit) {
  el.modal.classList.remove("hidden");
  el.modalInput.value = "";
  el.modalInput.placeholder = placeholder;
  el.modalInput.focus();
  const ok = () => {
    const val = el.modalInput.value.trim();
    if (val) onSubmit(val);
    el.modal.classList.add("hidden");
  };
  el.modalOk = el.modalOk || document.getElementById("modal-ok");
  el.modalCancel = el.modalCancel || document.getElementById("modal-cancel");
  el.modalOk.onclick = ok;
  el.modalCancel.onclick = () => el.modal.classList.add("hidden");
  el.modalInput.onkeydown = (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") el.modal.classList.add("hidden"); };
}

document.getElementById("new-board-btn").addEventListener("click", () => {
  openModal("Nombre de la nueva pizarra", async (name) => {
    const b = await api("/api/boards", "POST", { name });
    state.boards.push(b);
    await loadBoard(b.id);
  });
});

el.boardList.addEventListener("dblclick", (e) => {
  const item = e.target.closest(".board-item");
  if (!item || e.target.classList.contains("del")) return;
  const id = state.boards.find((b) => el.boardList.querySelectorAll(".board-item")[state.boards.indexOf(b)] === item)?.id;
  const board = state.boards.find((b) => b.id === id);
  openModal("Renombrar pizarra", async (name) => {
    await api(`/api/boards/${board.id}`, "PATCH", { name });
    board.name = name;
    renderBoardList();
  });
});

document.getElementById("export-btn").addEventListener("click", async () => {
  if (!state.currentBoardId) return;
  window.open(`/api/boards/${state.currentBoardId}/export.md`, "_blank");
});

// ---------------------------------------------------------------------------
// Botones de la toolbar y zoom
// ---------------------------------------------------------------------------
document.getElementById("postit-btn").addEventListener("click", () => setTool("postit"));
document.getElementById("pin-btn").addEventListener("click", () => setTool("pin"));
document.getElementById("connect-btn").addEventListener("click", () =>
  setTool(state.tool === "connect" ? "postit" : "connect")
);
document.getElementById("zoom-in").addEventListener("click", () => {
  const c = viewCenter();
  state.cam.zoom = Math.min(3, state.cam.zoom * 1.2);
  applyCamera();
});
document.getElementById("zoom-out").addEventListener("click", () => {
  state.cam.zoom = Math.max(0.25, state.cam.zoom / 1.2);
  applyCamera();
});
document.getElementById("reset-view").addEventListener("click", () => {
  state.cam = { x: 0, y: 0, zoom: 1 };
  applyCamera();
});

// Esc cancela selección de conexión.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.tool === "connect") setTool("postit");
    state.connectFrom = null;
  }
  // Supr borra la nota seleccionada.
  if (e.key === "Delete" && state.selectedNoteId !== null && !e.target.isContentEditable) {
    const n = state.notes.find((x) => x.id === state.selectedNoteId);
    if (n) deleteNote(n);
  }
});

// ---------------------------------------------------------------------------
// Estado de inferencia (opcional)
// ---------------------------------------------------------------------------
async function loadLlmStatus() {
  try {
    const s = await api("/api/llm/status");
    if (s.enabled) el.llmDot.classList.add("on");
    el.llmDot.title = s.enabled ? `Inferencia: ${s.model}` : "Inferencia desactivada (define OPENAI_API_KEY)";
  } catch { /* sin red, ignorar */ }
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function init() {
  // Centra la vista inicialmente en el origen.
  applyCamera();
  await loadBoards();
  loadLlmStatus();
  initBookmarks();
}

init();

// ===========================================================================
// PESTAÑA BOOKMARKS (estilo Raindrop)
// ===========================================================================
const bmState = {
  collections: [],
  bookmarks: [],
  currentCollection: null, // null = todos
  search: "",
  onlyFavs: false,
};

const bmEl = {
  tabBoards: document.getElementById("tab-boards"),
  tabBookmarks: document.getElementById("tab-bookmarks"),
  boardList: document.getElementById("board-list"),
  bmCollections: document.getElementById("bm-collections"),
  view: document.getElementById("bookmarks-view"),
  boardView: document.getElementById("board"),
  title: document.getElementById("bm-collection-title"),
  search: document.getElementById("bm-search-input"),
  grid: document.getElementById("bm-grid"),
  empty: document.getElementById("bm-empty"),
  modal: document.getElementById("bm-modal"),
  url: document.getElementById("bm-url"),
  titleInput: document.getElementById("bm-title"),
  excerpt: document.getElementById("bm-excerpt"),
  note: document.getElementById("bm-note"),
  tags: document.getElementById("bm-tags"),
  collection: document.getElementById("bm-collection"),
  fetchBtn: document.getElementById("bm-fetch-btn"),
  fetchStatus: document.getElementById("bm-fetch-status"),
  save: document.getElementById("bm-save"),
  cancel: document.getElementById("bm-cancel"),
  addBtn: document.getElementById("bm-add-btn"),
  newCollectionBtn: document.getElementById("new-collection-btn"),
};

// --- Navegación entre pestañas ---
function switchTab(tab) {
  const isBm = tab === "bookmarks";
  bmEl.tabBoards.classList.toggle("active", !isBm);
  bmEl.tabBookmarks.classList.toggle("active", isBm);
  bmEl.boardList.classList.toggle("hidden", isBm);
  bmEl.bmCollections.classList.toggle("hidden", !isBm);
  bmEl.boardView.classList.toggle("hidden", isBm);
  bmEl.view.classList.toggle("hidden", !isBm);
  if (isBm) loadCollections();
}
bmEl.tabBoards.addEventListener("click", () => switchTab("boards"));
bmEl.tabBookmarks.addEventListener("click", () => switchTab("bookmarks"));

// --- Colecciones ---
async function loadCollections() {
  bmState.collections = await api("/api/collections");
  renderCollections();
  loadBookmarks();
}

function renderCollections() {
  const container = bmEl.bmCollections;
  // Mantén el botón "+ Nueva colección" y añade el de "Todos" después.
  container.querySelectorAll(".collections-item").forEach((n) => n.remove());

  const all = document.createElement("div");
  all.className = "collections-item" + (bmState.currentCollection === null ? " active" : "");
  all.textContent = "🗂️ Todos";
  all.addEventListener("click", () => {
    bmState.currentCollection = null;
    renderCollections();
    loadBookmarks();
  });
  container.appendChild(all);

  for (const c of bmState.collections) {
    const item = document.createElement("div");
    item.className = "collections-item" + (bmState.currentCollection === c.id ? " active" : "");
    item.textContent = c.name;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Borrar la colección "${c.name}"? Los links se mantienen sin colección.`)) return;
      await api(`/api/collections/${c.id}`, "DELETE");
      if (bmState.currentCollection === c.id) bmState.currentCollection = null;
      loadCollections();
    });
    item.appendChild(del);
    item.addEventListener("click", () => {
      bmState.currentCollection = c.id;
      renderCollections();
      loadBookmarks();
    });
    container.appendChild(item);
  }
}

// --- Cargar bookmarks ---
async function loadBookmarks() {
  const params = new URLSearchParams();
  if (bmState.currentCollection !== null) params.set("collection", bmState.currentCollection);
  if (bmState.search) params.set("q", bmState.search);
  bmState.bookmarks = await api("/api/bookmarks?" + params.toString());
  renderBookmarks();
}

// --- Render del grid masonry ---
function renderBookmarks() {
  bmEl.grid.innerHTML = "";
  bmEl.empty.classList.toggle("hidden", bmState.bookmarks.length > 0);
  bmEl.title.textContent =
    bmState.currentCollection === null
      ? "Todos los bookmarks"
      : (bmState.collections.find((c) => c.id === bmState.currentCollection)?.name || "Bookmarks");

  for (const b of bmState.bookmarks) {
    bmEl.grid.appendChild(createBookmarkCard(b));
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function createBookmarkCard(b) {
  const card = document.createElement("div");
  card.className = "bm-card";

  // Miniatura + estrella de favorito
  const thumb = document.createElement("div");
  thumb.className = "bm-thumb";
  if (b.thumbnail) {
    const img = document.createElement("img");
    img.src = b.thumbnail;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => { img.remove(); };
    thumb.appendChild(img);
  } else if (b.favicon) {
    const fav = document.createElement("img");
    fav.className = "bm-favicon";
    fav.src = b.favicon;
    fav.alt = "";
    fav.onerror = () => { fav.remove(); };
    thumb.appendChild(fav);
  }
  const star = document.createElement("button");
  star.className = "bm-star" + (b.favorite ? " fav" : "");
  star.textContent = b.favorite ? "★" : "☆";
  star.title = "Favorito";
  star.addEventListener("click", async () => {
    const updated = await api(`/api/bookmarks/${b.id}/fav`, "POST");
    b.favorite = updated.favorite;
    star.classList.toggle("fav", b.favorite);
    star.textContent = b.favorite ? "★" : "☆";
  });
  thumb.appendChild(star);
  card.appendChild(thumb);

  // Cuerpo
  const body = document.createElement("div");
  body.className = "bm-body";

  const title = document.createElement("div");
  title.className = "bm-title";
  const a = document.createElement("a");
  a.href = b.url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = b.title || b.url;
  title.appendChild(a);
  body.appendChild(title);

  if (b.excerpt) {
    const ex = document.createElement("div");
    ex.className = "bm-excerpt";
    ex.textContent = b.excerpt;
    body.appendChild(ex);
  }

  const host = document.createElement("div");
  host.className = "bm-host";
  host.textContent = hostOf(b.url);
  body.appendChild(host);

  if (b.tags.trim()) {
    const tags = document.createElement("div");
    tags.className = "bm-tags";
    b.tags.split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => {
      const span = document.createElement("span");
      span.className = "bm-tag";
      span.textContent = t;
      tags.appendChild(span);
    });
    body.appendChild(tags);
  }

  const del = document.createElement("button");
  del.className = "bm-del";
  del.textContent = "✕ eliminar";
  del.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este bookmark?")) return;
    await api(`/api/bookmarks/${b.id}`, "DELETE");
    loadBookmarks();
  });
  body.appendChild(del);

  card.appendChild(body);
  return card;
}

// --- Búsqueda ---
let searchTimer = null;
bmEl.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    bmState.search = bmEl.search.value.trim();
    loadBookmarks();
  }, 250);
});

// --- Modal: añadir bookmark ---
function openBmModal() {
  bmEl.modal.classList.remove("hidden");
  bmEl.url.value = "";
  bmEl.titleInput.value = "";
  bmEl.excerpt.value = "";
  bmEl.note.value = "";
  bmEl.tags.value = "";
  bmEl.fetchStatus.textContent = "";
  // Poblado de colecciones en el select
  bmEl.collection.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = "Sin colección";
  bmEl.collection.appendChild(opt);
  for (const c of bmState.collections) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name;
    o.selected = c.id === bmState.currentCollection;
    bmEl.collection.appendChild(o);
  }
  bmEl.url.focus();
}

bmEl.addBtn.addEventListener("click", openBmModal);
bmEl.cancel.addEventListener("click", () => bmEl.modal.classList.add("hidden"));

bmEl.fetchBtn.addEventListener("click", async () => {
  const url = bmEl.url.value.trim();
  if (!url) return;
  bmEl.fetchStatus.textContent = "Descubriendo…";
  try {
    const m = await api("/api/bookmarks/fetch", "POST", { url });
    if (!bmEl.titleInput.value) bmEl.titleInput.value = m.title;
    if (!bmEl.excerpt.value) bmEl.excerpt.value = m.excerpt;
    bmEl.fetchStatus.textContent = "✓ Metadatos descubiertos";
  } catch (e) {
    bmEl.fetchStatus.textContent = "No se pudo descubrir: " + e.message;
  }
});

bmEl.save.addEventListener("click", async () => {
  const url = bmEl.url.value.trim();
  if (!url) return;
  const collectionId = bmEl.collection.value ? Number(bmEl.collection.value) : null;
  try {
    await api("/api/bookmarks", "POST", {
      url,
      collection_id: collectionId,
      title: bmEl.titleInput.value.trim(),
      excerpt: bmEl.excerpt.value.trim(),
      note: bmEl.note.value.trim(),
      tags: bmEl.tags.value.trim(),
    });
    bmEl.modal.classList.add("hidden");
    await loadBookmarks();
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// Cerrar con Esc
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") bmEl.modal.classList.add("hidden");
});

function initBookmarks() {
  bmEl.newCollectionBtn.addEventListener("click", () => {
    openModal("Nombre de la colección", async (name) => {
      const c = await api("/api/collections", "POST", { name });
      bmState.collections.push(c);
      renderCollections();
    });
  });
}
