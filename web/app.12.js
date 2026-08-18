/* =========================================================================
   Gesipan — whiteboard infinito (editorial) + bookmarks
   Vanilla JS, sin dependencias. v6
   ========================================================================= */

"use strict";

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const state = {
  boards: [], currentBoardId: null,
  notes: [], connections: [], groups: [],
  cam: { x: 0, y: 0, zoom: 1 },
  pendingType: null,        // tipo pendiente de crear tras pulsar ＋: postit|pin|private|group|connect
  activeColor: "yellow",
  connectAnchorFrom: null, connecting: null,
  selectedNoteId: null, selectedGroupId: null,
  drag: null, panning: false,
  privacyOn: false, search: "",
  bmFavsOnly: false,        // filtro favoritos en bookmarks
};

// ---------------------------------------------------------------------------
// DOM
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
  inspTags: document.getElementById("insp-tags"),
  inspClose: document.getElementById("insp-close"),
  inspStylePostit: document.getElementById("insp-style-postit"),
  inspStylePin: document.getElementById("insp-style-pin"),
  inspDelete: document.getElementById("insp-delete"),
  createMenu: document.getElementById("create-menu"),
};

async function api(path, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
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
  drawConnecting();
}
function screenToWorld(sx, sy) {
  const r = el.board.getBoundingClientRect();
  return { x: (sx - r.left - state.cam.x) / state.cam.zoom, y: (sy - r.top - state.cam.y) / state.cam.zoom };
}
function viewCenter() { const r = el.board.getBoundingClientRect(); return screenToWorld(r.left + r.width / 2, r.top + r.height / 2); }

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------
async function loadBoards() {
  state.boards = await api("/api/boards");
  renderBoardList();
  const exists = state.boards.some(b => b.id === state.currentBoardId);
  if (!exists && state.boards.length > 0) await loadBoard(state.boards[0].id);
}
function renderBoardList() {
  el.boardList.innerHTML = "";
  for (const b of state.boards) {
    const item = document.createElement("div");
    item.className = "board-item" + (b.id === state.currentBoardId ? " active" : "");
    item.textContent = b.name;
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕"; del.title = "Borrar board";
    del.addEventListener("click", async e => { e.stopPropagation(); await api(`/api/boards/${b.id}`, "DELETE"); await loadBoards(); });
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
  state.connectAnchorFrom = null; state.connecting = null; state.pendingType = null;
  state.selectedNoteId = null; state.selectedGroupId = null;
  hideInspector(); closeCreateMenu();
  renderBoardList();
  renderAll();
  applyFilter(); applyPrivacy();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderAll() {
  el.world.innerHTML = "";
  for (const g of state.groups) el.world.appendChild(createGroupEl(g));
  for (const n of state.notes) el.world.appendChild(createNoteEl(n));
}

// ============================ GRUPOS ============================
function createGroupEl(g) {
  const div = document.createElement("div");
  const col = g.color || "lavender";
  div.className = "group-box g-" + col + (state.selectedGroupId === g.id ? " selected" : "");
  div.dataset.groupId = g.id;
  div.style.left = g.x + "px"; div.style.top = g.y + "px";
  div.style.width = g.width + "px"; div.style.height = g.height + "px";
  div.style.zIndex = 1;

  const title = document.createElement("input");
  title.className = "group-title";
  title.value = g.title; title.placeholder = "Título";
  title.addEventListener("pointerdown", e => e.stopPropagation());
  title.addEventListener("input", () => { g.title = title.value; api(`/api/groups/${g.id}`, "PATCH", { title: g.title }).catch(() => {}); });
  div.appendChild(title);

  const handle = document.createElement("div");
  handle.className = "group-handle";
  handle.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); state.selectedGroupId = g.id; setSelections(); startGroupResize(e, g, div); });
  div.appendChild(handle);

  div.addEventListener("pointerdown", e => {
    if (e.target === title || e.target === handle) return;
    e.preventDefault();
    state.selectedNoteId = null; state.selectedGroupId = g.id; setSelections();
    startGroupDrag(e, g, div);
  });
  // Seleccionar el grupo ya permite cambiar título/color (clic sin arrastrar).
  div.addEventListener("click", e => {
    if (e.target === handle || e.target === title) return;
    if (groupJustDragged) { groupJustDragged = false; return; }
    openGroupMenu(g, div);
  });
  return div;
}
let groupJustDragged = false;
function startGroupDrag(e, g, div) {
  const startW = screenToWorld(e.clientX, e.clientY);
  const offX = startW.x - g.x, offY = startW.y - g.y;
  // Captura las posiciones iniciales de las notas ancladas.
  const startX = g.x, startY = g.y;
  const anchoredNotes = state.notes.filter(n => n.group_id === g.id);
  const noteStarts = anchoredNotes.map(n => ({ n, x: n.x, y: n.y }));
  state.drag = { kind: "group", id: g.id, offX, offY, moved: false };
  div.classList.add("dragging");
  const onMove = ev => {
    if (!state.drag) return;
    state.drag.moved = true;
    const w = screenToWorld(ev.clientX, ev.clientY);
    const dx = w.x - offX - startX;
    const dy = w.y - offY - startY;
    // Mueve el grupo.
    g.x = startX + dx; g.y = startY + dy;
    div.style.left = g.x + "px"; div.style.top = g.y + "px";
    // Mueve las notas ancladas por el mismo delta.
    for (const { n, x, y } of noteStarts) {
      n.x = x + dx; n.y = y + dy;
      const ne = el.world.querySelector(`.note[data-id="${n.id}"]`);
      if (ne) { ne.style.left = n.x + "px"; ne.style.top = n.y + "px"; }
      saveNote(n);
    }
    drawConnections();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    const moved = state.drag && state.drag.moved;
    state.drag = null; div.classList.remove("dragging");
    if (moved) { groupJustDragged = true; dropAnim(div); }
    api(`/api/groups/${g.id}`, "PATCH", { x: g.x, y: g.y }).catch(() => {});
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
}
function startGroupResize(e, g, div) {
  const sx = e.clientX, sy = e.clientY, sw = g.width, sh = g.height;
  const onMove = ev => {
    g.width = Math.max(120, sw + (ev.clientX - sx) / state.cam.zoom);
    g.height = Math.max(90, sh + (ev.clientY - sy) / state.cam.zoom);
    div.style.width = g.width + "px"; div.style.height = g.height + "px";
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    api(`/api/groups/${g.id}`, "PATCH", { width: g.width, height: g.height }).catch(() => {});
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
}

// ============================ NOTAS ============================
function createNoteEl(n) {
  const div = document.createElement("div");
  div.className = `note ${n.style} ${n.color}` + (n.group_id ? " anchored" : "");
  div.dataset.id = n.id;
  div.style.left = n.x + "px"; div.style.top = n.y + "px";
  div.style.width = n.width + "px"; div.style.height = n.height + "px";
  div.style.zIndex = n.z;

  if (n.style === "pin") { const p = document.createElement("div"); p.className = "pin-head"; div.appendChild(p); }

  const content = document.createElement("div");
  content.className = "content"; content.textContent = n.text;
  // Editable inline: escribes directamente en la nota.
  content.contentEditable = true;
  content.spellcheck = false;
  content.addEventListener("input", () => { n.text = content.textContent; saveNote(n); });
  content.addEventListener("pointerdown", e => e.stopPropagation());
  div.appendChild(content);

  if (n.tags.trim()) {
    const tags = document.createElement("div"); tags.className = "tags-row";
    n.tags.split(",").map(t => t.trim()).filter(Boolean).forEach(t => {
      const c = document.createElement("span"); c.className = "tag-chip"; c.textContent = t; tags.appendChild(c);
    });
    div.appendChild(tags);
  }
  if (n.private) { const p = document.createElement("span"); p.className = "note-priv"; p.textContent = "🙈"; div.appendChild(p); }
  if (n.group_id) { const a = document.createElement("span"); a.className = "note-anchored"; a.textContent = "📌"; div.appendChild(a); }

  // Puntos de anclaje
  for (const pos of ["top", "right", "bottom", "left"]) {
    const a = document.createElement("div");
    a.className = `anchor anchor-${pos}`;
    a.dataset.noteId = n.id; a.dataset.anchor = pos;
    a.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); startAnchorDrag(n, pos, e); });
    div.appendChild(a);
  }

  // Botón anclar a grupo
  const anchorBtn = document.createElement("button");
  anchorBtn.className = "anchor-group-btn hidden";
  // Botón toggle: ancla la nota al grupo bajo ella, o la desancla si ya está en él.
  anchorBtn.addEventListener("click", e => {
    e.stopPropagation();
    const g = groupUnder(n);
    if (!g) return;
    if (n.group_id === g.id) { unanchor(n); }
    else { anchorToGroup(n, g.id); }
  });
  div.appendChild(anchorBtn);

  attachNoteEvents(div, n, anchorBtn);
  return div;
}
function groupUnder(n) {
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2;
  return state.groups.find(g => cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height) || null;
}
async function anchorToGroup(n, gid) {
  // Una nota no puede estar en 2 grupos a la vez.
  if (n.group_id && n.group_id !== gid) {
    const old = state.groups.find(g => g.id === n.group_id);
    const ok = confirm(
      `Esta nota ya pertenece al grupo "${old ? old.title : "otro"}". ` +
      `Se moverá de grupo. ¿Estás seguro?`
    );
    if (!ok) return false;
  }
  n.group_id = gid;
  await api(`/api/notes/${n.id}`, "PATCH", { group_id: gid });
  renderAll(); applyFilter(); applyPrivacy();
  return true;
}
async function unanchor(n) { n.group_id = null; await api(`/api/notes/${n.id}`, "PATCH", { group_id: null }); renderAll(); applyFilter(); applyPrivacy(); }

function attachNoteEvents(div, n, anchorBtn) {
  div.addEventListener("pointerdown", e => {
    if (e.target.classList.contains("anchor")) return;
    state.selectedGroupId = null; state.selectedNoteId = n.id; setSelections();
    startNoteDrag(e, n, div);
  });
  div.addEventListener("click", e => {
    if (e.target.classList.contains("anchor")) return;
    if (noteJustDragged) { noteJustDragged = false; return; }
    openInspector(n);
  });
  div.addEventListener("pointerup", () => {
    const g = groupUnder(n);
    // Solo muestra el botón si la nota está seleccionada. Si está en un grupo,
    // es un botón "Desanclar"; si no, permite anclar.
    if (state.selectedNoteId === n.id && g) {
      anchorBtn.classList.remove("hidden");
      anchorBtn.textContent = n.group_id === g.id ? "📌 Desanclar" : "📌 Anclar a " + (g.title || "grupo");
    } else {
      anchorBtn.classList.add("hidden");
    }
  });
}
let noteJustDragged = false;

function startNoteDrag(e, note, div) {
  const startW = screenToWorld(e.clientX, e.clientY);
  const offX = startW.x - note.x, offY = startW.y - note.y;
  state.drag = { kind: "note", id: note.id, offX, offY, moved: false };
  div.classList.add("dragging");
  const onMove = ev => {
    if (!state.drag) return;
    state.drag.moved = true;
    const w = screenToWorld(ev.clientX, ev.clientY);
    let nx = w.x - offX, ny = w.y - offY;
    // Si la nota está anclada a un grupo, queda recluida dentro de sus límites
    // (no puede salir del grupo a no ser que la desancles).
    if (note.group_id) {
      const g = state.groups.find(x => x.id === note.group_id);
      if (g) {
        nx = Math.max(g.x, Math.min(nx, g.x + g.width - note.width));
        ny = Math.max(g.y, Math.min(ny, g.y + g.height - note.height));
      }
    }
    note.x = nx; note.y = ny;
    div.style.left = note.x + "px"; div.style.top = note.y + "px";
    const g = groupUnder(note);
    el.world.querySelectorAll(".group-box").forEach(x => x.classList.toggle("drop-target", !!g && x.dataset.groupId == g.id));
    drawConnections();
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    const moved = state.drag && state.drag.moved;
    state.drag = null; div.classList.remove("dragging");
    el.world.querySelectorAll(".group-box").forEach(x => x.classList.remove("drop-target"));
    if (moved) { noteJustDragged = true; saveNote(note); dropAnim(div); }
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
}
function dropAnim(d) { d.classList.remove("drop-anim"); void d.offsetWidth; d.classList.add("drop-anim"); }

// ============================ CONEXIONES (orgánicas, solo anchor→anchor) ============================
function anchorOffset(a) {
  switch (a) {
    case "top": return { fx: 0.5, fy: 0 };
    case "right": return { fx: 1, fy: 0.5 };
    case "bottom": return { fx: 0.5, fy: 1 };
    case "left": return { fx: 0, fy: 0.5 };
    default: return { fx: 0.5, fy: 0.5 };
  }
}
function startAnchorDrag(n, anchor, e) {
  state.connectAnchorFrom = { noteId: n.id, anchor };
  const off = anchorOffset(anchor);
  const r = el.board.getBoundingClientRect();
  state.connecting = {
    fromX: state.cam.x + (n.x + n.width * off.fx) * state.cam.zoom,
    fromY: state.cam.y + (n.y + n.height * off.fy) * state.cam.zoom,
    toX: e.clientX - r.left, toY: e.clientY - r.top,
  };
  const onMove = ev => { const r2 = el.board.getBoundingClientRect(); state.connecting.toX = ev.clientX - r2.left; state.connecting.toY = ev.clientY - r2.top; drawConnecting(); };
  const onUp = ev => {
    window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
    state.connecting = null;
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = t ? t.closest(".anchor") : null;
    // Solo de anchor a anchor: ignorar si no se soltó sobre otro ancla.
    if (target && Number(target.dataset.noteId) !== n.id) {
      createConnection(n.id, anchor, Number(target.dataset.noteId), target.dataset.anchor);
      setConnectMode(false); // termina el modo unir tras conectar
    }
    state.connectAnchorFrom = null;
    drawConnecting();
  };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
}
function createConnection(fromId, fromA, toId, toA) {
  api(`/api/boards/${state.currentBoardId}/connections`, "POST", {
    from_id: fromId, to_id: toId, from_anchor: fromA, to_anchor: toA, label: "",
  }).then(c => { state.connections.push(c); drawConnections(); }).catch(err => alert(err.message));
}
// Dibuja flechas orgánicas, estilo dibujado a mano (curva suave con wiggle).
function drawConnections() {
  el.connectionsLayer.innerHTML = "";
  for (const c of state.connections) {
    const from = state.notes.find(n => n.id === c.from_id);
    const to = state.notes.find(n => n.id === c.to_id);
    if (!from || !to) continue;
    const fo = anchorOffset(c.from_anchor || "center"), toff = anchorOffset(c.to_anchor || "center");
    const fx = state.cam.x + (from.x + from.width * fo.fx) * state.cam.zoom;
    const fy = state.cam.y + (from.y + from.height * fo.fy) * state.cam.zoom;
    const tx = state.cam.x + (to.x + to.width * toff.fx) * state.cam.zoom;
    const ty = state.cam.y + (to.y + to.height * toff.fy) * state.cam.zoom;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "conn");
    // Curva bezier orgánica con un ligero desplazamiento aleatorio (estilo mano).
    const mx = (fx + tx) / 2, my = (fy + ty) / 2;
    const wiggle = (Math.random() - 0.5) * 14;
    const d = `M ${fx} ${fy} Q ${mx + wiggle} ${my + wiggle * 0.6} ${tx} ${ty}`;
    path.setAttribute("d", d);
    // Puntera
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.id = "arrow"; marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7");
    marker.setAttribute("refX", "6"); marker.setAttribute("refY", "3"); marker.setAttribute("orient", "auto");
    marker.innerHTML = '<path d="M0,0 L7,3 L0,6 z" fill="var(--accent-strong)"/>';
    if (!el.connectionsLayer.querySelector("#arrow")) el.connectionsLayer.appendChild(marker);
    path.setAttribute("marker-end", "url(#arrow)");
    el.connectionsLayer.appendChild(path);
  }
}
function drawConnecting() {
  let line = document.getElementById("connecting-line");
  if (!state.connecting) { if (line) line.remove(); return; }
  if (!line) {
    line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.id = "connecting-line"; line.setAttribute("class", "conn connecting");
    el.connectionsLayer.appendChild(line);
  }
  const { fromX, fromY, toX, toY } = state.connecting;
  const mx = (fromX + toX) / 2, my = (fromY + toY) / 2;
  line.setAttribute("d", `M ${fromX} ${fromY} Q ${mx} ${my} ${toX} ${toY}`);
}

// ============================ PAN / ZOOM ============================
el.board.addEventListener("pointerdown", e => {
  if (e.button !== 0 || e.target !== el.board) return;
  // Si hay un tipo pendiente, crea en ese punto y desactiva el modo.
  if (state.pendingType) {
    const w = screenToWorld(e.clientX, e.clientY);
    if (state.pendingType === "group") createGroup(w.x, w.y);
    else createNoteAt(w.x, w.y);
    return;
  }
  state.panning = true; el.board.classList.add("panning");
  const scx = state.cam.x, scy = state.cam.y, sx = e.clientX, sy = e.clientY;
  const onMove = ev => { state.cam.x = scx + (ev.clientX - sx); state.cam.y = scy + (ev.clientY - sy); applyCamera(); };
  const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); state.panning = false; el.board.classList.remove("panning"); };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
});
el.board.addEventListener("wheel", e => {
  e.preventDefault();
  const r = el.board.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const before = { x: (sx - state.cam.x) / state.cam.zoom, y: (sy - state.cam.y) / state.cam.zoom };
  const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  state.cam.zoom = Math.min(3, Math.max(0.25, state.cam.zoom * f));
  state.cam.x = sx - before.x * state.cam.zoom; state.cam.y = sy - before.y * state.cam.zoom;
  applyCamera();
});

// ============================ CREAR ============================
async function createNoteAt(x, y) {
  const style = state.pendingType === "pin" ? "pin" : "postit";
  const isPrivate = state.pendingType === "private";
  const note = await api(`/api/boards/${state.currentBoardId}/notes`, "POST", {
    x, y, style, color: state.activeColor,
  });
  if (isPrivate) { note.private = true; await api(`/api/notes/${note.id}`, "PATCH", { private: true }); }
  state.notes.push(note);
  state.pendingType = null; closeCreateMenu();
  renderAll(); applyFilter(); applyPrivacy();
  openNoteDetail(note);
}
async function createGroup(x, y) {
  const g = await api(`/api/boards/${state.currentBoardId}/groups`, "POST", { x, y });
  state.groups.push(g);
  state.selectedGroupId = g.id; state.selectedNoteId = null;
  state.pendingType = null; closeCreateMenu();
  renderAll(); setSelections();
}
function openNoteDetail(note) {
  const noteEl = el.world.querySelector(`.note[data-id="${note.id}"]`);
  if (!noteEl) return;
  const wx = note.x + note.width / 2, wy = note.y + note.height / 2;
  const r = el.board.getBoundingClientRect();
  state.cam.x = r.width / 2 - wx * state.cam.zoom;
  state.cam.y = r.height / 2 - wy * state.cam.zoom;
  applyCamera();
  noteEl.classList.add("detail");
  openInspector(note);
}

// ============================ MENÚ CREAR (botón ＋) ============================
function openCreateMenu() {
  el.createMenu.classList.toggle("hidden");
}
function closeCreateMenu() {
  el.createMenu.classList.add("hidden");
  if (state.pendingType === "connect") { /* modo conectar se activa por su opción */ }
}
document.getElementById("new-note-btn").addEventListener("click", e => {
  e.stopPropagation();
  openCreateMenu();
});
// Opciones del menú
el.createMenu.querySelectorAll(".create-item").forEach(item => {
  item.addEventListener("click", () => {
    state.pendingType = item.dataset.type;
    el.toolHint.classList.remove("hidden");
    el.toolHint.textContent = "Clic en el lienzo para crear · Esc cancela";
    closeCreateMenu();
  });
});
// Esc cancela
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    state.pendingType = null; state.connecting = null; state.connectAnchorFrom = null;
    setConnectMode(false); closeCreateMenu(); hideInspector();
  }
});

// ============================ PERSISTENCIA ============================
function saveNote(n) {
  api(`/api/notes/${n.id}`, "PATCH", {
    x: n.x, y: n.y, width: n.width, height: n.height, text: n.text,
    style: n.style, color: n.color, tags: n.tags, private: n.private, group_id: n.group_id,
  }).catch(err => console.error(err));
}
async function deleteNote(n) {
  await api(`/api/notes/${n.id}`, "DELETE");
  state.notes = state.notes.filter(x => x.id !== n.id);
  state.connections = state.connections.filter(c => c.from_id !== n.id && c.to_id !== n.id);
  if (state.selectedNoteId === n.id) hideInspector();
  renderAll(); applyFilter(); applyPrivacy();
}
async function deleteGroup(g) {
  await api(`/api/groups/${g.id}`, "DELETE");
  state.groups = state.groups.filter(x => x.id !== g.id);
  state.notes.forEach(n => { if (n.group_id === g.id) n.group_id = null; });
  state.selectedGroupId = null;
  renderAll();
}

// ============================ SELECCIÓN ============================
function setSelections() {
  el.world.querySelectorAll(".note").forEach(d => d.classList.toggle("selected", Number(d.dataset.id) === state.selectedNoteId));
  el.world.querySelectorAll(".group-box").forEach(d => d.classList.toggle("selected", Number(d.dataset.groupId) === state.selectedGroupId));
}

// ============================ INSPECTOR (flotante) ============================
let editingNote = null;
// Modo unir: activado desde el detalle de la nota. Muestra los puntos de anclaje
// de todas las notas para arrastrar de un ancla a otro.
let connectMode = false;
function setConnectMode(on) {
  connectMode = on;
  el.world.querySelectorAll(".note").forEach(d => d.classList.toggle("anchor-mode", on));
  el.connectHint.classList.toggle("hidden", !on);
  if (on) {
    el.connectHint.textContent = "Arrastra de un ancla de esta nota a un ancla de otra · Esc cancela";
  }
}
function openInspector(n) {
  editingNote = n;
  state.selectedNoteId = n.id; setSelections();
  el.inspTags.value = n.tags;
  el.inspStylePostit.classList.toggle("active", n.style !== "pin");
  el.inspStylePin.classList.toggle("active", n.style === "pin");
  el.inspector.querySelectorAll(".insp-colors .swatch").forEach(s => s.classList.toggle("active", s.dataset.color === n.color));
  const priv = document.getElementById("insp-private");
  priv.classList.toggle("active", n.private);
  const grpBtn = document.getElementById("insp-group");
  const g = state.groups.find(x => x.id === n.group_id);
  grpBtn.classList.toggle("active", !!g);
  positionInspector(n);
  el.inspector.classList.remove("hidden");
}
// Coloca el popup contextual justo junto a la nota seleccionada.
function positionInspector(n) {
  const noteEl = el.world.querySelector(`.note[data-id="${n.id}"]`);
  if (!noteEl) return;
  const br = el.board.getBoundingClientRect();
  const nr = noteEl.getBoundingClientRect();
  const pad = 14;
  let left = nr.right - br.left + pad;
  let top = nr.top - br.top;
  const inspW = 220;
  // Si se sale por la derecha, ponlo a la izquierda de la nota.
  if (left + inspW > br.width) left = nr.left - br.left - inspW - pad;
  el.inspector.style.left = left + "px";
  el.inspector.style.top = Math.max(8, top) + "px";
}
function hideInspector() { el.inspector.classList.add("hidden"); editingNote = null; }
el.inspClose.addEventListener("click", hideInspector);

// ============================ MENÚ CONTEXTUAL DE GRUPO ============================
let editingGroup = null;
const groupMenu = document.getElementById("group-menu");
const groupMenuTitle = document.getElementById("group-menu-title");
const groupMenuClose = document.getElementById("group-menu-close");

function openGroupMenu(g, div) {
  editingGroup = g;
  state.selectedNoteId = null; state.selectedGroupId = g.id; setSelections();
  groupMenuTitle.value = g.title || "";
  groupMenu.querySelectorAll(".group-colors .swatch").forEach(s => s.classList.toggle("active", s.dataset.color === (g.color || "lavender")));
  positionGroupMenu(div);
  groupMenu.classList.remove("hidden");
}
function positionGroupMenu(div) {
  const br = el.board.getBoundingClientRect();
  const gr = div.getBoundingClientRect();
  const pad = 14;
  let left = gr.right - br.left + pad;
  let top = gr.top - br.top;
  const w = 200;
  if (left + w > br.width) left = gr.left - br.left - w - pad;
  groupMenu.style.left = left + "px";
  groupMenu.style.top = Math.max(8, top) + "px";
}
function hideGroupMenu() { groupMenu.classList.add("hidden"); editingGroup = null; }
groupMenuClose.addEventListener("click", hideGroupMenu);
groupMenuTitle.addEventListener("input", () => {
  if (!editingGroup) return;
  editingGroup.title = groupMenuTitle.value;
  api(`/api/groups/${editingGroup.id}`, "PATCH", { title: editingGroup.title }).catch(() => {});
  renderAll(); // actualiza el título en el grupo
});
groupMenu.querySelectorAll(".group-colors .swatch").forEach(s => {
  s.addEventListener("click", () => {
    if (!editingGroup) return;
    editingGroup.color = s.dataset.color;
    groupMenu.querySelectorAll(".group-colors .swatch").forEach(x => x.classList.remove("active"));
    s.classList.add("active");
    api(`/api/groups/${editingGroup.id}`, "PATCH", { color: editingGroup.color }).catch(() => {});
    renderAll();
  });
});
// Cerrar el menú de grupo al hacer clic fuera.
document.addEventListener("pointerdown", (e) => {
  if (!groupMenu.classList.contains("hidden")) {
    if (!groupMenu.contains(e.target)) hideGroupMenu();
  }
});

// Cierra el detalle al perder el foco de la nota seleccionada:
// cualquier clic fuera de la nota y fuera del popup cierra el inspector.
document.addEventListener("pointerdown", (e) => {
  if (state.selectedNoteId === null) return;
  const noteEl = el.world.querySelector(`.note[data-id="${state.selectedNoteId}"]`);
  const inNote = noteEl && noteEl.contains(e.target);
  const inInsp = el.inspector.contains(e.target);
  // Si el clic no está ni en la nota ni en el popup (ni en sus controles), cierra.
  if (!inNote && !inInsp) hideInspector();
});

el.inspTags.addEventListener("input", () => {
  if (!editingNote) return; editingNote.tags = el.inspTags.value.trim(); saveNote(editingNote);
  renderAll(); applyFilter(); applyPrivacy();
});
el.inspStylePostit.addEventListener("click", () => { if (!editingNote) return; editingNote.style = "postit"; renderAll(); applyFilter(); applyPrivacy(); saveNote(editingNote); });
el.inspStylePin.addEventListener("click", () => { if (!editingNote) return; editingNote.style = "pin"; renderAll(); applyFilter(); applyPrivacy(); saveNote(editingNote); });
el.inspector.querySelectorAll(".insp-colors .swatch").forEach(s => {
  s.addEventListener("click", () => {
    if (!editingNote) return; editingNote.color = s.dataset.color;
    el.inspector.querySelectorAll(".insp-colors .swatch").forEach(x => x.classList.remove("active"));
    s.classList.add("active");
    renderAll(); applyFilter(); applyPrivacy(); saveNote(editingNote);
  });
});
el.inspDelete.addEventListener("click", () => { if (editingNote) deleteNote(editingNote); });
const inspPrivate = document.getElementById("insp-private");
inspPrivate.addEventListener("click", () => {
  if (!editingNote) return;
  editingNote.private = !editingNote.private;
  inspPrivate.classList.toggle("active", editingNote.private);
  inspPrivate.textContent = editingNote.private ? "🙈 Quitar" : "👁️ Privada";
  renderAll(); applyFilter(); applyPrivacy(); saveNote(editingNote);
});
const inspGroup = document.getElementById("insp-group");
inspGroup.addEventListener("click", () => {
  if (!editingNote) return;
  if (editingNote.group_id) { unanchor(editingNote); openInspector(editingNote); }
  else { const g = groupUnder(editingNote); if (g) { anchorToGroup(editingNote, g.id); openInspector(editingNote); } }
});
// Botón "Unir": entra en modo anchor desde el detalle de la nota.
const inspConnect = document.getElementById("insp-connect");
inspConnect.addEventListener("click", () => {
  if (!editingNote) return;
  setConnectMode(true);
});

// ============================ BÚSQUEDA / PRIVACIDAD ============================
el.noteSearch.addEventListener("input", () => { state.search = el.noteSearch.value.trim().toLowerCase(); el.searchClear.classList.toggle("hidden", !state.search); applyFilter(); });
el.searchClear.addEventListener("click", () => { el.noteSearch.value = ""; state.search = ""; el.searchClear.classList.add("hidden"); applyFilter(); });
function applyFilter() {
  el.world.querySelectorAll(".note").forEach(d => {
    const n = state.notes.find(x => x.id === Number(d.dataset.id));
    if (!n) return;
    const hay = (n.text + " " + n.tags).toLowerCase();
    d.classList.toggle("dimmed", !!state.search && !hay.includes(state.search));
  });
}
function applyPrivacy() {
  el.world.querySelectorAll(".note").forEach(d => {
    const n = state.notes.find(x => x.id === Number(d.dataset.id));
    if (!n) return;
    d.classList.toggle("blurred", n.private && !state.privacyOn);
  });
}

// ============================ ZOOM BOTONES ============================
document.getElementById("zoom-in").addEventListener("click", () => { state.cam.zoom = Math.min(3, state.cam.zoom * 1.2); applyCamera(); });
document.getElementById("zoom-out").addEventListener("click", () => { state.cam.zoom = Math.max(0.25, state.cam.zoom / 1.2); applyCamera(); });
document.getElementById("reset-view").addEventListener("click", () => { state.cam = { x: 0, y: 0, zoom: 1 }; applyCamera(); });
document.querySelectorAll("#color-picker .swatch").forEach(s => {
  s.addEventListener("click", () => {
    state.activeColor = s.dataset.color;
    document.querySelectorAll("#color-picker .swatch").forEach(x => x.classList.remove("active"));
    s.classList.add("active");
  });
});

// ============================ MODAL / BOARDS ============================
function openModal(placeholder, onSubmit) {
  el.modal.classList.remove("hidden");
  el.modalInput.value = ""; el.modalInput.placeholder = placeholder; el.modalInput.focus();
  const ok = () => { const v = el.modalInput.value.trim(); if (v) onSubmit(v); el.modal.classList.add("hidden"); };
  el.modalOk = el.modalOk || document.getElementById("modal-ok");
  el.modalCancel = el.modalCancel || document.getElementById("modal-cancel");
  el.modalOk.onclick = ok;
  el.modalCancel.onclick = () => el.modal.classList.add("hidden");
  el.modalInput.onkeydown = e => { if (e.key === "Enter") ok(); if (e.key === "Escape") el.modal.classList.add("hidden"); };
}
document.getElementById("new-board-btn").addEventListener("click", () => {
  openModal("Nombre del nuevo board", async name => {
    const b = await api("/api/boards", "POST", { name });
    state.boards.push(b);
    await loadBoard(b.id);
  });
});
el.boardList.addEventListener("dblclick", e => {
  const item = e.target.closest(".board-item");
  if (!item || e.target.classList.contains("del")) return;
  const board = state.boards.find(b => el.boardList.querySelectorAll(".board-item")[state.boards.indexOf(b)] === item);
  openModal("Renombrar board", async name => { await api(`/api/boards/${board.id}`, "PATCH", { name }); board.name = name; renderBoardList(); });
});
document.getElementById("export-btn").addEventListener("click", () => {
  if (!state.currentBoardId) return;
  window.open(`/api/boards/${state.currentBoardId}/export.md`, "_blank");
});

// ============================ LLM ============================
async function loadLlmStatus() {
  try {
    const s = await api("/api/llm/status");
    if (s.enabled) el.llmDot.classList.add("on");
    el.llmDot.title = s.enabled ? `Inferencia: ${s.model}` : "Inferencia desactivada";
  } catch { }
}

// ============================ BOOKMARKS (lista estilo Raindrop) ============================
const bmState = { collections: [], bookmarks: [], currentCollection: null, search: "", favsOnly: false };
const bmEl = {
  tabBoards: document.getElementById("tab-boards"), tabBookmarks: document.getElementById("tab-bookmarks"),
  boardList: document.getElementById("board-list"), bmCollections: document.getElementById("bm-collections"),
  view: document.getElementById("bookmarks-view"), boardView: document.getElementById("board"),
  title: document.getElementById("bm-collection-title"), search: document.getElementById("bm-search-input"),
  list: document.getElementById("bm-list"), empty: document.getElementById("bm-empty"),
  modal: document.getElementById("bm-modal"), url: document.getElementById("bm-url"),
  titleInput: document.getElementById("bm-title"), tags: document.getElementById("bm-tags"),
  collection: document.getElementById("bm-collection"), fetchBtn: document.getElementById("bm-fetch-btn"),
  fetchStatus: document.getElementById("bm-fetch-status"), save: document.getElementById("bm-save"),
  cancel: document.getElementById("bm-cancel"), addBtn: document.getElementById("bm-add-btn"),
  newCollectionBtn: document.getElementById("new-collection-btn"), favBtn: document.getElementById("bm-fav-btn"),
};
function switchTab(tab) {
  const isBm = tab === "bookmarks";
  bmEl.tabBoards.classList.toggle("active", !isBm); bmEl.tabBookmarks.classList.toggle("active", isBm);
  bmEl.boardList.classList.toggle("hidden", isBm); bmEl.bmCollections.classList.toggle("hidden", !isBm);
  bmEl.boardView.classList.toggle("hidden", isBm); bmEl.view.classList.toggle("hidden", !isBm);
  if (isBm) loadCollections();
}
bmEl.tabBoards.addEventListener("click", () => switchTab("boards"));
bmEl.tabBookmarks.addEventListener("click", () => switchTab("bookmarks"));
// Favoritas en lateral
bmEl.favBtn.addEventListener("click", () => {
  bmState.favsOnly = !bmState.favsOnly;
  bmEl.favBtn.classList.toggle("active", bmState.favsOnly);
  bmEl.favBtn.textContent = bmState.favsOnly ? "★ Favoritas ✓" : "★ Favoritas";
  loadBookmarks();
});
async function loadCollections() {
  bmState.collections = await api("/api/collections");
  renderCollections(); loadBookmarks();
}
function renderCollections() {
  const c = bmEl.bmCollections;
  c.querySelectorAll(".collections-item").forEach(n => n.remove());
  const all = document.createElement("div");
  all.className = "collections-item" + (bmState.currentCollection === null ? " active" : "");
  all.textContent = "🗂️ Todos";
  all.addEventListener("click", () => { bmState.currentCollection = null; renderCollections(); loadBookmarks(); });
  c.appendChild(all);
  for (const col of bmState.collections) {
    const item = document.createElement("div");
    item.className = "collections-item" + (bmState.currentCollection === col.id ? " active" : "");
    item.textContent = col.name;
    const del = document.createElement("button"); del.className = "del"; del.textContent = "✕";
    del.addEventListener("click", async e => { e.stopPropagation(); await api(`/api/collections/${col.id}`, "DELETE"); if (bmState.currentCollection === col.id) bmState.currentCollection = null; loadCollections(); });
    item.appendChild(del);
    item.addEventListener("click", () => { bmState.currentCollection = col.id; renderCollections(); loadBookmarks(); });
    c.appendChild(item);
  }
}
async function loadBookmarks() {
  const p = new URLSearchParams();
  if (bmState.currentCollection !== null) p.set("collection", bmState.currentCollection);
  if (bmState.search) p.set("q", bmState.search);
  if (bmState.favsOnly) p.set("favs", "true");
  bmState.bookmarks = await api("/api/bookmarks?" + p.toString());
  renderBookmarks();
}
function renderBookmarks() {
  bmEl.list.innerHTML = "";
  bmEl.empty.classList.toggle("hidden", bmState.bookmarks.length > 0);
  bmEl.title.textContent = bmState.favsOnly ? "★ Favoritas" : (bmState.currentCollection === null ? "Todos los bookmarks" : (bmState.collections.find(c => c.id === bmState.currentCollection)?.name || "Bookmarks"));
  for (const b of bmState.bookmarks) bmEl.list.appendChild(createBookmarkRow(b));
}
function hostOf(url) { try { return new URL(url).hostname; } catch { return url; } }
function createBookmarkRow(b) {
  const row = document.createElement("div"); row.className = "bm-row";

  // Miniatura visual (favicon o imagen) — como Raindrop.
  const thumb = document.createElement("div"); thumb.className = "bm-thumb";
  if (b.thumbnail) {
    const img = document.createElement("img"); img.src = b.thumbnail; img.alt = ""; img.loading = "lazy";
    img.onerror = () => img.remove(); thumb.appendChild(img);
  } else if (b.favicon) {
    const f = document.createElement("img"); f.className = "bm-favicon"; f.src = b.favicon; f.alt = "";
    f.onerror = () => f.remove(); thumb.appendChild(f);
  }
  row.appendChild(thumb);

  // Cuerpo con detalle.
  const body = document.createElement("div"); body.className = "bm-body";
  const title = document.createElement("div"); title.className = "bm-title";
  const a = document.createElement("a"); a.href = b.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = b.title || hostOf(b.url);
  title.appendChild(a); body.appendChild(title);
  if (b.excerpt) { const ex = document.createElement("div"); ex.className = "bm-excerpt"; ex.textContent = b.excerpt; body.appendChild(ex); }
  const meta = document.createElement("div"); meta.className = "bm-meta";
  const host = document.createElement("span"); host.textContent = hostOf(b.url); meta.appendChild(host);
  if (b.tags.trim()) {
    const tags = document.createElement("div"); tags.className = "bm-tags";
    b.tags.split(",").map(t => t.trim()).filter(Boolean).slice(0, 3).forEach(t => { const s = document.createElement("span"); s.className = "bm-tag"; s.textContent = t; tags.appendChild(s); });
    meta.appendChild(tags);
  }
  body.appendChild(meta);
  row.appendChild(body);

  const star = document.createElement("button"); star.className = "bm-star" + (b.favorite ? " fav" : ""); star.textContent = b.favorite ? "★" : "☆"; star.title = "Favorito";
  star.addEventListener("click", async () => { const u = await api(`/api/bookmarks/${b.id}/fav`, "POST"); b.favorite = u.favorite; star.classList.toggle("fav", b.favorite); star.textContent = b.favorite ? "★" : "☆"; });
  row.appendChild(star);

  const del = document.createElement("button"); del.className = "bm-del"; del.textContent = "✕";
  del.addEventListener("click", async () => { await api(`/api/bookmarks/${b.id}`, "DELETE"); loadBookmarks(); });
  row.appendChild(del);
  return row;
}
let bmSearchTimer = null;
bmEl.search.addEventListener("input", () => { clearTimeout(bmSearchTimer); bmSearchTimer = setTimeout(() => { bmState.search = bmEl.search.value.trim(); loadBookmarks(); }, 250); });
function openBmModal() {
  bmEl.modal.classList.remove("hidden");
  bmEl.url.value = ""; bmEl.titleInput.value = ""; bmEl.tags.value = ""; bmEl.fetchStatus.textContent = "";
  bmEl.collection.innerHTML = "";
  const opt = document.createElement("option"); opt.value = ""; opt.textContent = "Sin colección"; bmEl.collection.appendChild(opt);
  for (const c of bmState.collections) { const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; o.selected = c.id === bmState.currentCollection; bmEl.collection.appendChild(o); }
  bmEl.url.focus();
}
bmEl.addBtn.addEventListener("click", openBmModal);
bmEl.cancel.addEventListener("click", () => bmEl.modal.classList.add("hidden"));
bmEl.fetchBtn.addEventListener("click", async () => {
  const url = bmEl.url.value.trim(); if (!url) return;
  bmEl.fetchStatus.textContent = "Descubriendo…";
  try { const m = await api("/api/bookmarks/fetch", "POST", { url }); if (!bmEl.titleInput.value) bmEl.titleInput.value = m.title; bmEl.fetchStatus.textContent = "✓"; }
  catch (e) { bmEl.fetchStatus.textContent = "No se pudo: " + e.message; }
});
bmEl.save.addEventListener("click", async () => {
  const url = bmEl.url.value.trim(); if (!url) return;
  const cid = bmEl.collection.value ? Number(bmEl.collection.value) : null;
  try {
    await api("/api/bookmarks", "POST", { url, collection_id: cid, title: bmEl.titleInput.value.trim(), tags: bmEl.tags.value.trim() });
    bmEl.modal.classList.add("hidden"); await loadBookmarks();
  } catch (e) { alert("Error: " + e.message); }
});

// ============================ EXTRAS UI ============================
function addPrivacyToggle() {
  const t = document.createElement("button");
  t.className = "privacy-toggle"; t.innerHTML = "🙈"; t.title = "Revelar contenido de notas privadas";
  t.addEventListener("click", () => {
    state.privacyOn = !state.privacyOn;
    t.classList.toggle("on", state.privacyOn);
    t.innerHTML = state.privacyOn ? "👁️" : "🙈";
    applyPrivacy();
  });
  document.querySelector(".search-box").appendChild(t);
}
function initBookmarks() {
  bmEl.newCollectionBtn.addEventListener("click", () => {
    openModal("Nombre de la colección", async name => { const c = await api("/api/collections", "POST", { name }); bmState.collections.push(c); renderCollections(); });
  });
}

// ============================ MODO OSCURO ============================
function applyTheme(force) {
  const dark = force !== undefined ? force : !document.body.classList.contains("dark");
  document.body.classList.toggle("dark", dark);
  const b = document.getElementById("dark-toggle"); if (b) b.textContent = dark ? "☀️" : "🌙";
  localStorage.setItem("gesipan-theme", dark ? "dark" : "light");
}

// ============================ PAPELERA ============================
async function openTrash() {
  const trash = await api("/api/trash");
  const nEl = document.getElementById("trash-notes"), bEl = document.getElementById("trash-bookmarks");
  const eEl = document.getElementById("trash-empty");
  nEl.innerHTML = ""; bEl.innerHTML = "";
  eEl.classList.toggle("hidden", trash.notes.length + trash.bookmarks.length > 0);
  if (trash.notes.length) { nEl.appendChild(trashHeader("Notas")); for (const n of trash.notes) nEl.appendChild(trashRow(n.text || "(sin texto)", () => restoreNote(n), () => purgeNote(n))); }
  if (trash.bookmarks.length) { bEl.appendChild(trashHeader("Bookmarks")); for (const b of trash.bookmarks) bEl.appendChild(trashRow(b.title || b.url, () => restoreBookmark(b), () => purgeBookmark(b))); }
  document.getElementById("trash-modal").classList.remove("hidden");
}
function trashHeader(t) { const h = document.createElement("div"); h.className = "trash-header"; h.textContent = t; return h; }
function trashRow(label, onRestore, onPurge) {
  const row = document.createElement("div"); row.className = "trash-row";
  const span = document.createElement("span"); span.className = "trash-label"; span.textContent = label;
  const restore = document.createElement("button"); restore.className = "ghost-btn small"; restore.textContent = "↩";
  restore.addEventListener("click", async () => { await onRestore(); openTrash(); });
  const purge = document.createElement("button"); purge.className = "danger-btn small"; purge.textContent = "🗑";
  purge.addEventListener("click", async () => { await onPurge(); openTrash(); });
  row.append(span, restore, purge); return row;
}
async function restoreNote(n) { await api(`/api/trash/notes/${n.id}/restore`, "POST"); loadBoard(state.currentBoardId); }
async function purgeNote(n) { await api(`/api/trash/notes/${n.id}`, "DELETE"); }
async function restoreBookmark(b) { await api(`/api/trash/bookmarks/${b.id}/restore`, "POST"); }
async function purgeBookmark(b) { await api(`/api/trash/bookmarks/${b.id}`, "DELETE"); }

document.addEventListener("DOMContentLoaded", () => {
  const savedT = localStorage.getItem("gesipan-theme"); if (savedT === "dark") applyTheme(true);
  document.getElementById("dark-toggle").addEventListener("click", () => applyTheme());
  document.getElementById("trash-btn").addEventListener("click", openTrash);
  document.getElementById("trash-close").addEventListener("click", () => document.getElementById("trash-modal").classList.add("hidden"));
  let bmSortAsc = true;
  document.getElementById("bm-sort-btn").addEventListener("click", () => {
    bmSortAsc = !bmSortAsc;
    bmState.bookmarks = [...bmState.bookmarks].sort((a, b) => bmSortAsc ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at));
    renderBookmarks();
  });
  document.getElementById("bm-export-btn").addEventListener("click", () => window.open("/api/bookmarks/export.md", "_blank"));
});

// ============================ ARRANQUE ============================
async function init() {
  applyCamera();
  await loadBoards();
  loadLlmStatus();
  initBookmarks();
  addPrivacyToggle();
  applyPrivacy();
}
init();
