/* =========================================================================
   Gesipan — whiteboard infinito (Material 3) + bookmarks (estilo Raindrop)
   Vanilla JS, sin dependencias.

   Modelo de "gesipan infinita":
   - El "mundo" (#world) contiene notas y grupos.
   - La cámara { x, y, zoom } se aplica con transform CSS translate+scale.
   - Las notas se guardan en coordenadas DE MUNDO (ya escaladas). Al arrastrar
     convertimos píxeles de pantalla -> mundo dividiendo por el zoom.
   ========================================================================= */

"use strict";

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
const state = {
  boards: [],
  currentBoardId: null,
  notes: [],
  connections: [],
  groups: [],

  cam: { x: 0, y: 0, zoom: 1 },

  // Herramienta activa: "pan" | "group" | "connect"
  tool: "pan",
  // Estilo de las notas nuevas: "postit" | "pin"
  noteStyle: "postit",
  activeColor: "yellow",

  // Conexión: { noteId, anchor } de la primera ancla pulsada
  connectAnchorFrom: null,
  selectedNoteId: null,
  selectedGroupId: null,

  drag: null,   // { noteId|groupId, offX, offY, kind }
  panning: false,

  privacyOn: false,
  search: "",
};

// ---------------------------------------------------------------------------
// Elementos del DOM
// ---------------------------------------------------------------------------
const el = {
  board: document.getElementById("board"),
  world: document.getElementById("world"),
  connectionsLayer: document.getElementById("connections-layer"),
  boardList: document.getElementById("board-list"),
  zoomLabel: document.getElementById("zoom-label"),
  connectHint: document.getElementById("connect-hint"),
  toolHint: document.getElementById("tool-hint"),
  colorPicker: document.getElementById("color-picker"),
  llmDot: document.getElementById("llm-dot"),
  noteSearch: document.getElementById("note-search"),
  searchClear: document.getElementById("search-clear"),
  modal: document.getElementById("modal"),
  modalInput: document.getElementById("modal-input"),
  inspector: document.getElementById("inspector"),
  inspText: document.getElementById("insp-text"),
  inspTags: document.getElementById("insp-tags"),
  inspClose: document.getElementById("insp-close"),
  inspStylePostit: document.getElementById("insp-style-postit"),
  inspStylePin: document.getElementById("insp-style-pin"),
  inspDelete: document.getElementById("insp-delete"),
};

// ---------------------------------------------------------------------------
// API
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
// Cámara
// ---------------------------------------------------------------------------
function applyCamera() {
  el.world.style.transform = `translate(${state.cam.x}px, ${state.cam.y}px) scale(${state.cam.zoom})`;
  el.zoomLabel.textContent = Math.round(state.cam.zoom * 100) + "%";
  drawConnections();
}

function screenToWorld(sx, sy) {
  const rect = el.board.getBoundingClientRect();
  return {
    x: (sx - rect.left - state.cam.x) / state.cam.zoom,
    y: (sy - rect.top - state.cam.y) / state.cam.zoom,
  };
}

function viewCenter() {
  const rect = el.board.getBoundingClientRect();
  return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

// ---------------------------------------------------------------------------
// Carga de gesipans
// ---------------------------------------------------------------------------
async function loadBoards() {
  state.boards = await api("/api/boards");
  renderBoardList();
  const exists = state.boards.some((b) => b.id === state.currentBoardId);
  if (!exists && state.boards.length > 0) await loadBoard(state.boards[0].id);
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
    del.title = "Borrar gesipan";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Borrar la gesipan "${b.name}" y todas sus notas?`)) return;
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
  state.groups = data.groups;
  state.connectAnchorFrom = null;
  state.selectedNoteId = null;
  state.selectedGroupId = null;
  hideInspector();
  renderBoardList();
  renderAll();
  applyFilter();
  applyPrivacy();
  applyToolMode();
}

// ---------------------------------------------------------------------------
// Render: grupos + notas
// ---------------------------------------------------------------------------
function renderAll() {
  el.world.innerHTML = "";
  for (const g of state.groups) el.world.appendChild(createGroupEl(g));
  for (const n of state.notes) el.world.appendChild(createNoteEl(n));
}

function createGroupEl(g) {
  const div = document.createElement("div");
  div.className = "group-box" + (state.selectedGroupId === g.id ? " selected" : "");
  div.dataset.groupId = g.id;
  div.style.left = g.x + "px";
  div.style.top = g.y + "px";
  div.style.width = g.width + "px";
  div.style.height = g.height + "px";
  div.style.zIndex = 1;

  const title = document.createElement("input");
  title.className = "group-title";
  title.value = g.title;
  title.placeholder = "Título del grupo";
  title.addEventListener("pointerdown", (e) => e.stopPropagation());
  title.addEventListener("input", () => {
    g.title = title.value;
    api(`/api/groups/${g.id}`, "PATCH", { title: g.title }).catch(() => {});
  });
  div.appendChild(title);

  const handle = document.createElement("div");
  handle.className = "group-handle";
  div.appendChild(handle);

  div.addEventListener("pointerdown", (e) => {
    if (e.target === title || e.target === handle) return;
    if (state.tool === "connect") return; // en modo conectar no se arrastra
    e.preventDefault();
    state.selectedNoteId = null;
    state.selectedGroupId = g.id;
    setSelections();
    startGroupDrag(e, g, div);
  });
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.selectedGroupId = g.id;
    setSelections();
    startGroupResize(e, g, div);
  });
  return div;
}

// Mover un grupo: desplaza las notas ancladas (con el centro dentro) con él.
function startGroupDrag(e, g, div) {
  const rect = div.getBoundingClientRect();
  const world = screenToWorld(rect.left, rect.top);
  const offX = world.x - g.x;
  const offY = world.y - g.y;
  state.drag = { kind: "group", id: g.id, offX, offY };

  const onMove = (ev) => {
    const w = screenToWorld(ev.clientX, ev.clientY);
    const dx = w.x - state.drag.offX - g.x;
    const dy = w.y - state.drag.offY - g.y;
    g.x += dx;
    g.y += dy;
    div.style.left = g.x + "px";
    div.style.top = g.y + "px";
    // Mueve las notas ancladas al grupo (centro dentro del recuadro).
    for (const n of state.notes) {
      if (noteAnchoredToGroup(n, g)) {
        n.x += dx;
        n.y += dy;
        const noteEl = el.world.querySelector(`.note[data-id="${n.id}"]`);
        if (noteEl) {
          noteEl.style.left = n.x + "px";
          noteEl.style.top = n.y + "px";
        }
        saveNote(n);
      }
    }
    drawConnections();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.drag = null;
    api(`/api/groups/${g.id}`, "PATCH", { x: g.x, y: g.y }).catch(() => {});
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startGroupResize(e, g, div) {
  const startX = e.clientX, startY = e.clientY;
  const startW = g.width, startH = g.height;
  const onMove = (ev) => {
    g.width = Math.max(120, startW + (ev.clientX - startX) / state.cam.zoom);
    g.height = Math.max(90, startH + (ev.clientY - startY) / state.cam.zoom);
    div.style.width = g.width + "px";
    div.style.height = g.height + "px";
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    api(`/api/groups/${g.id}`, "PATCH", { width: g.width, height: g.height }).catch(() => {});
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// Una nota está "anclada" al grupo si el centro de la nota cae dentro del grupo.
function noteAnchoredToGroup(n, g) {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  return cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height;
}

// ---------------------------------------------------------------------------
// Render de una nota
// ---------------------------------------------------------------------------
function createNoteEl(n) {
  const div = document.createElement("div");
  div.className = `note ${n.style} ${n.color}`;
  div.dataset.id = n.id;
  div.style.left = n.x + "px";
  div.style.top = n.y + "px";
  div.style.width = n.width + "px";
  div.style.height = n.height + "px";
  div.style.zIndex = n.z;

  if (n.style === "pin") {
    const pin = document.createElement("div");
    pin.className = "pin-head";
    div.appendChild(pin);
  }

  // Contenido (solo lectura; se edita desde el inspector).
  const content = document.createElement("div");
  content.className = "content";
  content.textContent = n.text;
  div.appendChild(content);

  // Etiquetas
  if (n.tags.trim()) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "tags-row";
    n.tags.split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = t;
      tagsRow.appendChild(chip);
    });
    div.appendChild(tagsRow);
  }

  // Icono de privada si aplica
  if (n.private) {
    const priv = document.createElement("span");
    priv.className = "note-priv";
    priv.textContent = "🔒";
    priv.title = "Privada";
    div.appendChild(priv);
  }

  // Puntos de anclaje (visibles en modo conectar)
  for (const pos of ["top", "right", "bottom", "left"]) {
    const a = document.createElement("div");
    a.className = `anchor anchor-${pos}`;
    a.dataset.noteId = n.id;
    a.dataset.anchor = pos;
    a.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleAnchorClick(n, pos, a);
    });
    div.appendChild(a);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(actionBtn("✎", "Editar", () => openInspector(n)));
  actions.appendChild(actionBtn("⬆", "Traer al frente", () => raiseNote(n, div)));
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
// Eventos de nota
// ---------------------------------------------------------------------------
function attachNoteEvents(div, n) {
  // pointerdown en cualquier parte del cuerpo de la nota (menos acciones/anclas):
  // si la herramienta es "conectar", selecciona la nota; si no, inicia drag.
  div.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".actions")) return;
    if (e.target.classList.contains("anchor")) return;

    state.selectedGroupId = null;
    state.selectedNoteId = n.id;
    setSelections();

    if (state.tool === "connect") {
      // En modo conectar, un clic en la nota sin ancla no hace nada de drag.
      return;
    }
    startNoteDrag(e, n, div);
  });

  // Clic sin arrastre (release) abre el inspector.
  div.addEventListener("click", (e) => {
    if (e.target.closest(".actions")) return;
    if (e.target.classList.contains("anchor")) return;
    // Si acabamos de arrastrar, no abrimos el inspector.
    if (noteJustDragged) { noteJustDragged = false; return; }
    openInspector(n);
  });
}

// Bandera: true justo después de arrastrar una nota (para que el click post-drag
// no abra el inspector). Se resetea en el primer click.
let noteJustDragged = false;

function startNoteDrag(e, note, div) {
  const rect = div.getBoundingClientRect();
  const worldPos = screenToWorld(rect.left, rect.top);
  const offX = worldPos.x - note.x;
  const offY = worldPos.y - note.y;
  state.drag = { kind: "note", id: note.id, offX, offY, moved: false };

  const onMove = (ev) => {
    if (!state.drag) return;
    state.drag.moved = true;
    const w = screenToWorld(ev.clientX, ev.clientY);
    note.x = w.x - state.drag.offX;
    note.y = w.y - state.drag.offY;
    div.style.left = note.x + "px";
    div.style.top = note.y + "px";
    drawConnections();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const moved = state.drag && state.drag.moved;
    state.drag = null;
    if (moved) {
      noteJustDragged = true;
      saveNote(note);
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// ---------------------------------------------------------------------------
// Conexiones con puntos de anclaje
// ---------------------------------------------------------------------------
function handleAnchorClick(n, anchor, el) {
  if (state.connectAnchorFrom === null) {
    state.connectAnchorFrom = { noteId: n.id, anchor };
    // Resalta la ancla seleccionada.
    document.querySelectorAll(".anchor").forEach((a) => a.classList.remove("selected-anchor"));
    el.classList.add("selected-anchor");
  } else {
    const from = state.connectAnchorFrom;
    state.connectAnchorFrom = null;
    document.querySelectorAll(".anchor").forEach((a) => a.classList.remove("selected-anchor"));
    if (from.noteId === n.id && from.anchor === anchor) return; // mismo punto
    api(`/api/boards/${state.currentBoardId}/connections`, "POST", {
      from_id: from.noteId, to_id: n.id,
      from_anchor: from.anchor, to_anchor: anchor, label: "",
    }).then((c) => {
      state.connections.push(c);
      drawConnections();
    }).catch((err) => alert(err.message));
  }
}

// Devuelve el offset (0..1) del punto de anclaje dentro de la nota.
function anchorOffset(anchor) {
  switch (anchor) {
    case "top": return { fx: 0.5, fy: 0 };
    case "right": return { fx: 1, fy: 0.5 };
    case "bottom": return { fx: 0.5, fy: 1 };
    case "left": return { fx: 0, fy: 0.5 };
    default: return { fx: 0.5, fy: 0.5 };
  }
}

function drawConnections() {
  el.connectionsLayer.innerHTML = "";
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="var(--md-primary)"/></marker>`;
  el.connectionsLayer.appendChild(defs);

  for (const c of state.connections) {
    const from = state.notes.find((n) => n.id === c.from_id);
    const to = state.notes.find((n) => n.id === c.to_id);
    if (!from || !to) continue;

    const fo = anchorOffset(c.from_anchor || "center");
    const toff = anchorOffset(c.to_anchor || "center");
    const fx = state.cam.x + (from.x + from.width * fo.fx) * state.cam.zoom;
    const fy = state.cam.y + (from.y + from.height * fo.fy) * state.cam.zoom;
    const tx = state.cam.x + (to.x + to.width * toff.fx) * state.cam.zoom;
    const ty = state.cam.y + (to.y + to.height * toff.fy) * state.cam.zoom;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "conn");
    const mx = (fx + tx) / 2, my = (fy + ty) / 2;
    path.setAttribute("d", `M ${fx} ${fy} Q ${mx} ${my} ${tx} ${ty}`);

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
// Pan del lienzo
// ---------------------------------------------------------------------------
el.board.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target !== el.board) return;

  // En modo grupo, un clic en el fondo crea un grupo en ese punto.
  if (state.tool === "group") {
    const w = screenToWorld(e.clientX, e.clientY);
    createGroup(w.x, w.y);
    return;
  }

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
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    state.panning = false;
    el.board.classList.remove("panning");
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
});

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------
el.board.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = el.board.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const before = {
    x: (sx - state.cam.x) / state.cam.zoom,
    y: (sy - state.cam.y) / state.cam.zoom,
  };
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  state.cam.zoom = Math.min(3, Math.max(0.25, state.cam.zoom * factor));
  state.cam.x = sx - before.x * state.cam.zoom;
  state.cam.y = sy - before.y * state.cam.zoom;
  applyCamera();
});

// ---------------------------------------------------------------------------
// Crear nota / grupo
// ---------------------------------------------------------------------------
async function createNote(x, y) {
  const note = await api(`/api/boards/${state.currentBoardId}/notes`, "POST", {
    x, y, style: state.noteStyle, color: state.activeColor,
  });
  state.notes.push(note);
  renderAll();
  applyFilter();
  applyPrivacy();
  applyToolMode();
  openInspector(note);
}

async function createGroup(x, y) {
  const g = await api(`/api/boards/${state.currentBoardId}/groups`, "POST", { x, y });
  state.groups.push(g);
  state.selectedGroupId = g.id;
  state.selectedNoteId = null;
  renderAll();
  setSelections();
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------
function saveNote(n) {
  api(`/api/notes/${n.id}`, "PATCH", {
    x: n.x, y: n.y, width: n.width, height: n.height, text: n.text,
    style: n.style, color: n.color, tags: n.tags, private: n.private,
  }).catch((err) => console.error(err));
}

function raiseNote(n, div) {
  api(`/api/notes/${n.id}/raise`, "POST").then(() => {
    n.z = Math.max(...state.notes.map((x) => x.z)) + 1;
    div.style.zIndex = n.z;
  });
}

async function deleteNote(n) {
  if (!confirm("¿Eliminar esta nota?")) return;
  await api(`/api/notes/${n.id}`, "DELETE");
  state.notes = state.notes.filter((x) => x.id !== n.id);
  state.connections = state.connections.filter((c) => c.from_id !== n.id && c.to_id !== n.id);
  if (state.selectedNoteId === n.id) hideInspector();
  renderAll();
  applyFilter();
  applyPrivacy();
  applyToolMode();
}

async function deleteGroup(g) {
  if (!confirm("¿Eliminar este grupo?")) return;
  await api(`/api/groups/${g.id}`, "DELETE");
  state.groups = state.groups.filter((x) => x.id !== g.id);
  state.selectedGroupId = null;
  renderAll();
}

// ---------------------------------------------------------------------------
// Selección
// ---------------------------------------------------------------------------
function setSelections() {
  el.world.querySelectorAll(".note").forEach((d) => {
    d.classList.toggle("selected", Number(d.dataset.id) === state.selectedNoteId);
  });
  el.world.querySelectorAll(".group-box").forEach((d) => {
    d.classList.toggle("selected", Number(d.dataset.groupId) === state.selectedGroupId);
  });
}

// ---------------------------------------------------------------------------
// Panel inspector
// ---------------------------------------------------------------------------
let editingNote = null;

function openInspector(n) {
  editingNote = n;
  state.selectedNoteId = n.id;
  setSelections();
  el.inspector.classList.remove("hidden");
  el.inspText.value = n.text;
  el.inspTags.value = n.tags;
  el.inspStylePostit.classList.toggle("active", n.style !== "pin");
  el.inspStylePin.classList.toggle("active", n.style === "pin");
  el.inspector.querySelectorAll(".insp-colors .swatch").forEach((s) => {
    s.classList.toggle("active", s.dataset.color === n.color);
  });
  const inspPrivate = document.getElementById("insp-private");
  inspPrivate.classList.toggle("active", n.private);
  inspPrivate.textContent = n.private ? "🔓 Quitar privacidad" : "🔒 Marcar como privada";
  el.inspText.focus();
}

function hideInspector() {
  el.inspector.classList.add("hidden");
  editingNote = null;
}

el.inspText.addEventListener("input", () => {
  if (!editingNote) return;
  editingNote.text = el.inspText.value;
  const noteEl = el.world.querySelector(`.note[data-id="${editingNote.id}"]`);
  if (noteEl) noteEl.querySelector(".content").textContent = editingNote.text;
  saveNote(editingNote);
});
el.inspTags.addEventListener("input", () => {
  if (!editingNote) return;
  editingNote.tags = el.inspTags.value.trim();
  saveNote(editingNote);
  renderAll();
  applyFilter();
  applyPrivacy();
  applyToolMode();
});
el.inspStylePostit.addEventListener("click", () => {
  if (!editingNote) return;
  editingNote.style = "postit";
  el.inspStylePostit.classList.add("active");
  el.inspStylePin.classList.remove("active");
  saveNote(editingNote);
  renderAll();
  applyFilter();
  applyPrivacy();
  applyToolMode();
});
el.inspStylePin.addEventListener("click", () => {
  if (!editingNote) return;
  editingNote.style = "pin";
  el.inspStylePin.classList.add("active");
  el.inspStylePostit.classList.remove("active");
  saveNote(editingNote);
  renderAll();
  applyFilter();
  applyPrivacy();
  applyToolMode();
});
el.inspector.querySelectorAll(".insp-colors .swatch").forEach((s) => {
  s.addEventListener("click", () => {
    if (!editingNote) return;
    editingNote.color = s.dataset.color;
    el.inspector.querySelectorAll(".insp-colors .swatch").forEach((x) => x.classList.remove("active"));
    s.classList.add("active");
    saveNote(editingNote);
    renderAll();
    applyFilter();
    applyPrivacy();
    applyToolMode();
  });
});
el.inspDelete.addEventListener("click", () => {
  if (editingNote) deleteNote(editingNote);
});
el.inspClose.addEventListener("click", hideInspector);

const inspPrivate = document.getElementById("insp-private");
inspPrivate.addEventListener("click", () => {
  if (!editingNote) return;
  editingNote.private = !editingNote.private;
  inspPrivate.classList.toggle("active", editingNote.private);
  inspPrivate.textContent = editingNote.private ? "🔓 Quitar privacidad" : "🔒 Marcar como privada";
  saveNote(editingNote);
  renderAll();
  applyFilter();
  applyPrivacy();
  applyToolMode();
});

// ---------------------------------------------------------------------------
// Búsqueda (filtra las notas visibles, atenuando las que no coinciden)
// ---------------------------------------------------------------------------
el.noteSearch.addEventListener("input", () => {
  state.search = el.noteSearch.value.trim().toLowerCase();
  el.searchClear.classList.toggle("hidden", !state.search);
  applyFilter();
});
el.searchClear.addEventListener("click", () => {
  el.noteSearch.value = "";
  state.search = "";
  el.searchClear.classList.add("hidden");
  applyFilter();
});

function applyFilter() {
  el.world.querySelectorAll(".note").forEach((d) => {
    const n = state.notes.find((x) => x.id === Number(d.dataset.id));
    if (!n) return;
    const haystack = (n.text + " " + n.tags).toLowerCase();
    const matches = !state.search || haystack.includes(state.search);
    d.classList.toggle("dimmed", !matches);
  });
}

// ---------------------------------------------------------------------------
// Privacidad (toggle global: difumina las notas privadas)
// ---------------------------------------------------------------------------
function applyPrivacy() {
  el.world.querySelectorAll(".note").forEach((d) => {
    const n = state.notes.find((x) => x.id === Number(d.dataset.id));
    if (!n) return;
    d.classList.toggle("blurred", state.privacyOn && n.private);
  });
}

// ---------------------------------------------------------------------------
// Herramientas / modos
// ---------------------------------------------------------------------------
function setTool(tool) {
  state.tool = tool;
  document.getElementById("group-btn").classList.toggle("active", tool === "group");
  const cb = document.getElementById("connect-btn");
  cb.classList.toggle("connect-active", tool === "connect");
  el.connectHint.classList.toggle("hidden", tool !== "connect");
  el.toolHint.classList.toggle("hidden", tool !== "group");
  el.colorPicker.classList.toggle("hidden", tool === "group" || tool === "connect");
  if (tool !== "connect") state.connectAnchorFrom = null;
  applyToolMode();
}

// Refleja el modo en las notas (mostrar/ocultar anclas, cursor).
function applyToolMode() {
  const connectMode = state.tool === "connect";
  el.world.querySelectorAll(".note").forEach((d) => {
    d.classList.toggle("anchor-mode", connectMode);
  });
}

// --- Estilo de nota nueva (postit / pin) ---
function setNoteStyle(style) {
  state.noteStyle = style;
  document.getElementById("postit-btn").classList.toggle("active", style === "postit");
  document.getElementById("pin-btn").classList.toggle("active", style === "pin");
}

// Botón crear nueva nota (explicito, en el centro de la vista).
document.getElementById("new-note-btn").addEventListener("click", () => {
  if (!state.currentBoardId) return;
  const c = viewCenter();
  createNote(c.x, c.y);
});

document.getElementById("postit-btn").addEventListener("click", () => setNoteStyle("postit"));
document.getElementById("pin-btn").addEventListener("click", () => setNoteStyle("pin"));
document.getElementById("group-btn").addEventListener("click", () =>
  setTool(state.tool === "group" ? "pan" : "group")
);
document.getElementById("connect-btn").addEventListener("click", () =>
  setTool(state.tool === "connect" ? "pan" : "connect")
);
document.getElementById("zoom-in").addEventListener("click", () => {
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

// Color picker (toolbar)
document.querySelectorAll("#color-picker .swatch").forEach((s) => {
  s.addEventListener("click", () => {
    state.activeColor = s.dataset.color;
    document.querySelectorAll("#color-picker .swatch").forEach((x) => x.classList.remove("active"));
    s.classList.add("active");
  });
});

// Borrar un grupo seleccionado con Supr.
// Esc cancela / cierra inspector
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.tool === "connect" || state.tool === "group") setTool("pan");
    state.connectAnchorFrom = null;
    hideInspector();
  }
  if (e.key === "Delete" && !e.target.isContentEditable) {
    if (state.selectedNoteId !== null) {
      const n = state.notes.find((x) => x.id === state.selectedNoteId);
      if (n) deleteNote(n);
    } else if (state.selectedGroupId !== null) {
      const g = state.groups.find((x) => x.id === state.selectedGroupId);
      if (g) deleteGroup(g);
    }
  }
});

// ---------------------------------------------------------------------------
// Gesipans: crear / renombrar / exportar
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
  el.modalInput.onkeydown = (e) => {
    if (e.key === "Enter") ok();
    if (e.key === "Escape") el.modal.classList.add("hidden");
  };
}

document.getElementById("new-board-btn").addEventListener("click", () => {
  openModal("Nombre de la nueva gesipan", async (name) => {
    const b = await api("/api/boards", "POST", { name });
    state.boards.push(b);
    await loadBoard(b.id);
  });
});

el.boardList.addEventListener("dblclick", (e) => {
  const item = e.target.closest(".board-item");
  if (!item || e.target.classList.contains("del")) return;
  const board = state.boards.find((b) => el.boardList.querySelectorAll(".board-item")[state.boards.indexOf(b)] === item);
  openModal("Renombrar gesipan", async (name) => {
    await api(`/api/boards/${board.id}`, "PATCH", { name });
    board.name = name;
    renderBoardList();
  });
});

document.getElementById("export-btn").addEventListener("click", () => {
  if (!state.currentBoardId) return;
  window.open(`/api/boards/${state.currentBoardId}/export.md`, "_blank");
});

// ---------------------------------------------------------------------------
// Estado de inferencia
// ---------------------------------------------------------------------------
async function loadLlmStatus() {
  try {
    const s = await api("/api/llm/status");
    if (s.enabled) el.llmDot.classList.add("on");
    el.llmDot.title = s.enabled ? `Inferencia: ${s.model}` : "Inferencia desactivada (define OPENAI_API_KEY)";
  } catch { /* ignorar */ }
}

// ---------------------------------------------------------------------------
// PESTAÑA BOOKMARKS (estilo Raindrop)
// ---------------------------------------------------------------------------
const bmState = {
  collections: [],
  bookmarks: [],
  currentCollection: null,
  search: "",
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

async function loadCollections() {
  bmState.collections = await api("/api/collections");
  renderCollections();
  loadBookmarks();
}

function renderCollections() {
  const container = bmEl.bmCollections;
  container.querySelectorAll(".collections-item").forEach((n) => n.remove());
  const all = document.createElement("div");
  all.className = "collections-item" + (bmState.currentCollection === null ? " active" : "");
  all.textContent = "🗂️ Todos";
  all.addEventListener("click", () => { bmState.currentCollection = null; renderCollections(); loadBookmarks(); });
  container.appendChild(all);
  for (const c of bmState.collections) {
    const item = document.createElement("div");
    item.className = "collections-item" + (bmState.currentCollection === c.id ? " active" : "");
    item.textContent = c.name;
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Borrar la colección "${c.name}"? Los links se mantienen sin colección.`)) return;
      await api(`/api/collections/${c.id}`, "DELETE");
      if (bmState.currentCollection === c.id) bmState.currentCollection = null;
      loadCollections();
    });
    item.appendChild(del);
    item.addEventListener("click", () => { bmState.currentCollection = c.id; renderCollections(); loadBookmarks(); });
    container.appendChild(item);
  }
}

async function loadBookmarks() {
  const params = new URLSearchParams();
  if (bmState.currentCollection !== null) params.set("collection", bmState.currentCollection);
  if (bmState.search) params.set("q", bmState.search);
  bmState.bookmarks = await api("/api/bookmarks?" + params.toString());
  renderBookmarks();
}

function renderBookmarks() {
  bmEl.grid.innerHTML = "";
  bmEl.empty.classList.toggle("hidden", bmState.bookmarks.length > 0);
  bmEl.title.textContent = bmState.currentCollection === null
    ? "Todos los bookmarks"
    : (bmState.collections.find((c) => c.id === bmState.currentCollection)?.name || "Bookmarks");
  for (const b of bmState.bookmarks) bmEl.grid.appendChild(createBookmarkCard(b));
}

function hostOf(url) { try { return new URL(url).hostname; } catch { return url; } }

function createBookmarkCard(b) {
  const card = document.createElement("div");
  card.className = "bm-card";
  const thumb = document.createElement("div");
  thumb.className = "bm-thumb";
  if (b.thumbnail) {
    const img = document.createElement("img");
    img.src = b.thumbnail; img.alt = ""; img.loading = "lazy";
    img.onerror = () => img.remove();
    thumb.appendChild(img);
  } else if (b.favicon) {
    const fav = document.createElement("img");
    fav.className = "bm-favicon"; fav.src = b.favicon; fav.alt = "";
    fav.onerror = () => fav.remove();
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

  const body = document.createElement("div");
  body.className = "bm-body";
  const title = document.createElement("div");
  title.className = "bm-title";
  const a = document.createElement("a");
  a.href = b.url; a.target = "_blank"; a.rel = "noopener";
  a.textContent = b.title || b.url;
  title.appendChild(a);
  body.appendChild(title);
  if (b.excerpt) {
    const ex = document.createElement("div");
    ex.className = "bm-excerpt"; ex.textContent = b.excerpt;
    body.appendChild(ex);
  }
  const host = document.createElement("div");
  host.className = "bm-host"; host.textContent = hostOf(b.url);
  body.appendChild(host);
  if (b.tags.trim()) {
    const tags = document.createElement("div");
    tags.className = "bm-tags";
    b.tags.split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => {
      const span = document.createElement("span");
      span.className = "bm-tag"; span.textContent = t;
      tags.appendChild(span);
    });
    body.appendChild(tags);
  }
  const del = document.createElement("button");
  del.className = "bm-del"; del.textContent = "✕ eliminar";
  del.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este bookmark?")) return;
    await api(`/api/bookmarks/${b.id}`, "DELETE");
    loadBookmarks();
  });
  body.appendChild(del);
  card.appendChild(body);
  return card;
}

let bmSearchTimer = null;
bmEl.search.addEventListener("input", () => {
  clearTimeout(bmSearchTimer);
  bmSearchTimer = setTimeout(() => {
    bmState.search = bmEl.search.value.trim();
    loadBookmarks();
  }, 250);
});

function openBmModal() {
  bmEl.modal.classList.remove("hidden");
  bmEl.url.value = ""; bmEl.titleInput.value = ""; bmEl.excerpt.value = "";
  bmEl.note.value = ""; bmEl.tags.value = ""; bmEl.fetchStatus.textContent = "";
  bmEl.collection.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = ""; opt.textContent = "Sin colección";
  bmEl.collection.appendChild(opt);
  for (const c of bmState.collections) {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.name;
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
      url, collection_id: collectionId, title: bmEl.titleInput.value.trim(),
      excerpt: bmEl.excerpt.value.trim(), note: bmEl.note.value.trim(), tags: bmEl.tags.value.trim(),
    });
    bmEl.modal.classList.add("hidden");
    await loadBookmarks();
  } catch (e) {
    alert("Error: " + e.message);
  }
});

// ---------------------------------------------------------------------------
// Toggle global de privacidad en la barra superior
// ---------------------------------------------------------------------------
function addPrivacyToggle() {
  const toggle = document.createElement("button");
  toggle.className = "privacy-toggle";
  toggle.innerHTML = "🔒";
  toggle.title = "Mostrar/ocultar notas privadas (difuminadas)";
  toggle.addEventListener("click", () => {
    state.privacyOn = !state.privacyOn;
    toggle.classList.toggle("on", state.privacyOn);
    applyPrivacy();
  });
  const searchBox = document.querySelector(".search-box");
  searchBox.appendChild(toggle);
}

function initBookmarks() {
  bmEl.newCollectionBtn.addEventListener("click", () => {
    openModal("Nombre de la colección", async (name) => {
      const c = await api("/api/collections", "POST", { name });
      bmState.collections.push(c);
      renderCollections();
    });
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function init() {
  applyCamera();
  await loadBoards();
  loadLlmStatus();
  initBookmarks();
  addPrivacyToggle();
}

init();
