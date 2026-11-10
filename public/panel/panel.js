import { SceneView } from '../shared/scene.js';

/* =============================== утилиты =============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `x${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function nameFromUrl(url) {
  try {
    const clean = url.split(/[?#]/)[0];
    const parts = clean.split('/');
    return decodeURIComponent(parts[parts.length - 1] || 'файл');
  } catch {
    return 'файл';
  }
}

const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)([?#]|$)/i;

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* приватный режим */
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* нет clipboard API (http в локальной сети) */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* =============================== состояние =============================== */

const KEYS = {
  token: 'modoverlay.token',
  color: 'modoverlay.color',
  size: 'modoverlay.size',
  voice: 'modoverlay.voice',
  recent: 'modoverlay.recent',
  sounds: 'modoverlay.sounds',
  monitor: 'modoverlay.monitor',
  volume: 'modoverlay.soundVolume',
};

const COLORS = ['#ff3b30', '#ff9f0a', '#ffcc00', '#34c759', '#00e5ff', '#0a84ff', '#bf5af2', '#ff5cae', '#ffffff', '#000000'];

const HEX_RE = /^#[0-9a-f]{6}$/i;

function storedNumber(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const storedColor = localStorage.getItem(KEYS.color) || '';
const storedSize = storedNumber(KEYS.size, 6);
const storedVolume = storedNumber(KEYS.volume, 0.8);
const storedSounds = readJson(KEYS.sounds, []);

const state = {
  token: localStorage.getItem(KEYS.token) || '',
  me: null,
  room: null,
  users: [],
  isAdmin: false,
  myClientId: '',
  ws: null,
  wsReady: false,
  wsRetry: 0,
  wsTimer: 0,
  tool: 'cursor',
  color: HEX_RE.test(storedColor) ? storedColor.toLowerCase() : '#ff3b30',
  brushPx: clamp(storedSize, 1, 48),
  current: null,
  selected: null,
  drag: null,
  editingTextId: null,
  voices: [],
  monitor: localStorage.getItem(KEYS.monitor) === '1',
  sounds: Array.isArray(storedSounds)
    ? storedSounds.filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.name === 'string' &&
          typeof item.url === 'string' &&
          (item.url.startsWith('/media/') || /^https?:\/\//i.test(item.url)),
      )
    : [],
  soundVolume: clamp(storedVolume, 0, 1),
};

const scene = new SceneView($('#scene'), { onChange: scheduleLists });
const stage = $('#stage');
const stageFrame = $('.stage-frame');
const selectionBox = $('#selection');
const brushCursor = $('#brush-cursor');
const toastEl = $('#toast');
const modal = $('#modal');
const profileModal = $('#profile-modal');

/* =============================== toast / modal =============================== */

let toastTimer = 0;

function toast(text, ms = 2600) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, ms);
}

function askPassword(title, text) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text || '';
    const input = $('#modal-input');
    input.value = '';
    modal.hidden = false;
    setTimeout(() => input.focus(), 30);

    const cleanup = () => {
      modal.hidden = true;
      $('#modal-ok').removeEventListener('click', onOk);
      $('#modal-cancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    };
    const close = (value) => {
      cleanup();
      resolve(value);
    };
    const onOk = () => {
      if (input.value.length < 8) {
        toast('Пароль минимум 8 символов');
        return;
      }
      close(input.value);
    };
    const onCancel = () => close(null);
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onOk();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    $('#modal-ok').addEventListener('click', onOk);
    $('#modal-cancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

/* ------------------------------- профиль ------------------------------- */

function openProfile() {
  if (!state.me) return;
  $('#profile-login').textContent = state.me.login;
  $('#profile-role').textContent = state.me.role === 'admin' ? 'администратор' : 'модератор';
  $('#profile-current').value = '';
  $('#profile-next').value = '';
  $('#profile-confirm').value = '';
  $('#profile-error').textContent = '';
  profileModal.hidden = false;
  setTimeout(() => $('#profile-current').focus(), 30);
}

function closeProfile() {
  profileModal.hidden = true;
  $('#profile-error').textContent = '';
}

/* ================================== API ================================= */

async function api(path, options = {}) {
  const { method = 'GET', body, auth = true } = options;
  const headers = {};
  if (auth && state.token) headers.Authorization = `Bearer ${state.token}`;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, { method, headers, body: payload });
  } catch {
    throw Object.assign(new Error('network'), { status: 0 });
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    /* пустой ответ */
  }

  if (response.status === 401 && auth) {
    logout();
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `http_${response.status}`), { status: response.status, data });
  }
  return data;
}

/* ================================ вход ================================= */

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#login-server').textContent = location.origin;
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#room-name').textContent = state.room?.name ?? 'Комната';
  $('#tab-admin').hidden = !state.isAdmin;
  $('#btn-copy-url').hidden = !state.isAdmin;
  const mePill = $('#me-pill');
  mePill.hidden = !state.me;
  if (state.me) {
    mePill.textContent = `${state.me.login} · ${state.me.role === 'admin' ? 'админ' : 'модератор'}`;
    mePill.title = `Вы вошли как ${state.me.login}`;
  }
  if (state.isAdmin && state.room) $('#overlay-url').value = state.room.overlayUrl;
  fitStage();
}

async function boot() {
  try {
    const data = await api('/api/bootstrap');
    state.me = data.user;
    state.room = data.room;
    state.isAdmin = data.user.role === 'admin';
    state.users = data.users || [];
    scene.setState(data.state);
    showApp();
    renderUsers();
    connectWs();
    loadVoices();
  } catch (err) {
    if (err.status === 401) return;
    showLogin();
    $('#login-error').textContent =
      err.status === 0 ? 'Сервер недоступен. Проверьте адрес и соединение.' : 'Не удалось загрузить данные.';
  }
}

function logout() {
  localStorage.removeItem(KEYS.token);
  state.token = '';
  try {
    state.ws?.close();
  } catch {
    /* ignore */
  }
  location.reload();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const login = String(data.get('login') || '').trim();
  const password = String(data.get('password') || '');
  const button = $('button[type=submit]', form);
  $('#login-error').textContent = '';
  button.disabled = true;
  button.textContent = 'Вход…';
  try {
    const result = await api('/api/login', { method: 'POST', body: { login, password }, auth: false });
    state.token = result.token;
    localStorage.setItem(KEYS.token, result.token);
    await boot();
  } catch (err) {
    $('#login-error').textContent =
      err.status === 429 ? 'Слишком много попыток. Подождите 10 минут.' : 'Неверный логин или пароль.';
  } finally {
    button.disabled = false;
    button.textContent = 'Войти';
  }
});

$('#btn-logout').addEventListener('click', () => {
  if (state.current) {
    toast('Сначала закончите рисование');
    return;
  }
  logout();
});

/* ============================== WebSocket ============================== */

function setConn(status) {
  const pill = $('#conn-pill');
  pill.classList.remove('online', 'offline');
  const label = $('span', pill);
  if (status === 'online') {
    pill.classList.add('online');
    label.textContent = 'В сети';
  } else if (status === 'offline') {
    pill.classList.add('offline');
    label.textContent = 'Нет связи';
  } else {
    label.textContent = 'Подключение…';
  }
}

function connectWs() {
  clearTimeout(state.wsTimer);
  if (!state.room) return;
  setConn('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=mod&room=${encodeURIComponent(state.room.id)}&token=${encodeURIComponent(state.token)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.wsRetry = 0;
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServer(msg);
  };

  ws.onclose = (event) => {
    if (state.ws !== ws) return;
    state.wsReady = false;
    setConn('offline');
    if (event.code === 4401) {
      toast('Сессия истекла — войдите заново');
      setTimeout(logout, 1400);
      return;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    /* onclose придёт следом */
  };
}

function scheduleReconnect() {
  clearTimeout(state.wsTimer);
  const delay = Math.min(10000, 700 * Math.pow(1.7, state.wsRetry++));
  state.wsTimer = setTimeout(connectWs, delay);
}

function reconnectWs() {
  clearTimeout(state.wsTimer);
  const old = state.ws;
  state.ws = null;
  try {
    old?.close();
  } catch {
    /* ignore */
  }
  connectWs();
}

function send(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    toast('Нет связи с сервером');
    return false;
  }
  state.ws.send(JSON.stringify(payload));
  return true;
}

function applySnapshot(snapshot) {
  // Если модератор рисует в момент полной синхронизации, не теряем текущий штрих.
  const current = state.current ? scene.state.strokes.find((stroke) => stroke.id === state.current.id) : null;
  scene.setState(snapshot);
  if (current) scene.startStroke(current);
  scheduleLists();
}

function handleServer(msg) {
  switch (msg.t) {
    case 'hello':
      state.myClientId = msg.clientId || '';
      state.wsReady = true;
      setConn('online');
      applySnapshot(msg.state);
      break;
    case 'state':
      applySnapshot(msg.state);
      break;
    case 'stroke.start':
      if (msg.by !== state.myClientId) scene.startStroke(msg.stroke);
      break;
    case 'stroke.points':
      if (msg.by !== state.myClientId) scene.addPoints(msg.id, msg.points);
      break;
    case 'stroke.end':
      scheduleLists();
      break;
    case 'stroke.undo':
      scene.removeStroke(msg.id);
      scheduleLists();
      break;
    case 'draw.clear':
      scene.clearStrokes();
      scheduleLists();
      break;
    case 'media.add':
    case 'media.update':
      scene.upsertMedia(msg.item);
      if (!state.drag) scheduleLists();
      break;
    case 'media.remove':
      scene.removeMedia(msg.id);
      scheduleLists();
      break;
    case 'text.add':
    case 'text.update':
      scene.upsertText(msg.item);
      if (!state.drag) scheduleLists();
      break;
    case 'text.remove':
      scene.removeText(msg.id);
      scheduleLists();
      break;
    case 'scene.clear':
      scene.clearAll();
      scheduleLists();
      break;
    case 'presence':
      updatePresence(msg);
      break;
    case 'tts':
      // Свою озвучку панель уже проиграла локально — не дублируем.
      if (state.monitor && msg.url && msg.by !== state.me?.id) playLocal(msg.url, msg.volume);
      break;
    case 'sound':
      break;
    case 'error':
      if (msg.code !== 'empty') toast(`Ошибка: ${msg.code}`);
      break;
    default:
      break;
  }
}

function updatePresence(msg) {
  const pill = $('#mods-pill');
  pill.textContent = `${msg.mods ?? 0} мод. · ${msg.overlays ?? 0} OBS`;
  pill.title = `Модераторов в сети: ${msg.mods ?? 0}\nПодключений оверлея: ${msg.overlays ?? 0}`;
}

/* ============================== отрисовка ============================== */

function fitStage() {
  const rect = stageFrame.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = 16 / 9;
  let width = rect.width;
  let height = width / ratio;
  if (height > rect.height) {
    height = rect.height;
    width = height * ratio;
  }
  stage.style.width = `${Math.floor(width)}px`;
  stage.style.height = `${Math.floor(height)}px`;
  updateBrushPreview();
  setTimeout(updateSelectionBox, 0);
}

function updateBrushPreview() {
  const px = Math.max(4, state.brushPx * (stage.clientHeight / 1080));
  brushCursor.style.width = `${px}px`;
  brushCursor.style.height = `${px}px`;
}

function normPoint(event, rect) {
  return [
    clamp((event.clientX - rect.left) / rect.width, 0, 1),
    clamp((event.clientY - rect.top) / rect.height, 0, 1),
  ];
}

function interpolate(from, to, rect) {
  const dx = (to[0] - from[0]) * rect.width;
  const dy = (to[1] - from[1]) * rect.height;
  const steps = Math.max(1, Math.min(140, Math.ceil(Math.hypot(dx, dy) / 2.5)));
  const points = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return points;
}

function onDrawStart(event) {
  if (state.tool === 'cursor') return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (!state.wsReady) {
    toast('Нет связи — рисование недоступно');
    return;
  }
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  const point = normPoint(event, rect);
  const id = `s_${uid()}`;
  const stroke = {
    id,
    tool: state.tool,
    color: state.color,
    size: state.brushPx / 1080,
    points: [point],
  };
  state.current = {
    id,
    pointerId: event.pointerId,
    last: point,
    rect,
    pending: [],
    lastFlush: performance.now(),
  };
  scene.startStroke(stroke);
  send({ t: 'stroke.start', stroke });
  try {
    scene.canvas.setPointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
}

function onDrawMove(event) {
  const current = state.current;
  if (!current || event.pointerId !== current.pointerId) return;
  event.preventDefault();
  moveBrushCursor(event);

  const rect = stage.getBoundingClientRect();
  const point = normPoint(event, rect);
  if (point[0] === current.last[0] && point[1] === current.last[1]) return;
  const points = interpolate(current.last, point, rect);
  current.last = point;
  current.pending.push(...points);
  scene.addPoints(current.id, points);

  if (current.pending.length > 400 || performance.now() - current.lastFlush > 45) flushStroke();
}

function flushStroke() {
  const current = state.current;
  if (!current) return;
  if (current.pending.length) {
    send({ t: 'stroke.points', id: current.id, points: current.pending });
    current.pending = [];
  }
  current.lastFlush = performance.now();
}

function onDrawEnd(event) {
  const current = state.current;
  if (!current || event.pointerId !== current.pointerId) return;
  flushStroke();
  send({ t: 'stroke.end', id: current.id });
  state.current = null;
  try {
    scene.canvas.releasePointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
}

function moveBrushCursor(event) {
  if (state.tool === 'cursor') return;
  const rect = stage.getBoundingClientRect();
  brushCursor.hidden = false;
  brushCursor.style.left = `${event.clientX - rect.left}px`;
  brushCursor.style.top = `${event.clientY - rect.top}px`;
}

scene.canvas.addEventListener('pointerdown', onDrawStart);
scene.canvas.addEventListener('pointermove', onDrawMove);
scene.canvas.addEventListener('pointerup', onDrawEnd);
scene.canvas.addEventListener('pointercancel', onDrawEnd);

stage.addEventListener('pointermove', (event) => {
  if (state.tool !== 'cursor') moveBrushCursor(event);
});
stage.addEventListener('pointerleave', () => {
  brushCursor.hidden = true;
});

/* ============================ выбор и перетаскивание ============================ */

function selectItem(target) {
  state.selected = target;
  updateSelectionBox();
  $$('.item-row.selected').forEach((row) => row.classList.remove('selected'));
  if (target) {
    const row = $(`.item-row[data-id="${target.id}"]`);
    row?.classList.add('selected');
  }
}

function updateSelectionBox() {
  const selected = state.selected;
  if (!selected) {
    selectionBox.hidden = true;
    return;
  }
  const node = selected.kind === 'media' ? scene.mediaEl(selected.id) : scene.textEl(selected.id);
  const item = scene.getItem(selected.kind, selected.id);
  if (!node || !item || item.hidden) {
    selectionBox.hidden = true;
    return;
  }
  const stageRect = stage.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  if (!nodeRect.width || !nodeRect.height) {
    selectionBox.hidden = true;
    return;
  }
  selectionBox.hidden = false;
  selectionBox.style.left = `${nodeRect.left - stageRect.left}px`;
  selectionBox.style.top = `${nodeRect.top - stageRect.top}px`;
  selectionBox.style.width = `${nodeRect.width}px`;
  selectionBox.style.height = `${nodeRect.height}px`;
}

function startDrag(event, mode) {
  const selected = state.selected;
  if (!selected) return;
  const item = scene.getItem(selected.kind, selected.id);
  const node = selected.kind === 'media' ? scene.mediaEl(selected.id) : scene.textEl(selected.id);
  if (!item || !node) return;

  event.preventDefault();
  event.stopPropagation();

  state.drag = {
    ...selected,
    mode,
    node,
    rect: stage.getBoundingClientRect(),
    startX: event.clientX,
    startY: event.clientY,
    orig:
      selected.kind === 'media'
        ? { x: item.x, y: item.y, w: item.w, h: item.h }
        : { x: item.x, y: item.y, size: item.size },
    patch: null,
    lastSent: 0,
    moved: false,
  };

  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(event) {
  const drag = state.drag;
  if (!drag) return;
  const dx = (event.clientX - drag.startX) / drag.rect.width;
  const dy = (event.clientY - drag.startY) / drag.rect.height;
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
  drag.moved = true;

  let patch;
  if (drag.mode === 'move') {
    patch = { x: clamp(drag.orig.x + dx, -0.5, 1.5), y: clamp(drag.orig.y + dy, -0.5, 1.5) };
  } else if (drag.kind === 'media') {
    patch = { w: clamp(drag.orig.w + dx, 0.02, 2), h: clamp(drag.orig.h + dy, 0.02, 2) };
  } else {
    patch = { size: clamp(drag.orig.size + (dx + dy) * 0.35, 0.01, 0.25) };
  }

  drag.patch = Object.assign(drag.patch || {}, patch);
  scene.updateItemLocal(drag.kind, drag.id, patch);
  updateSelectionBox();

  if (performance.now() - drag.lastSent > 45) flushDrag();
}

function flushDrag() {
  const drag = state.drag;
  if (!drag || !drag.patch) return;
  send({ t: `${drag.kind}.update`, id: drag.id, patch: drag.patch });
  drag.patch = null;
  drag.lastSent = performance.now();
}

function onDragEnd() {
  if (state.drag) flushDrag();
  state.drag = null;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  updateSelectionBox();
  scheduleLists();
}

stage.addEventListener('pointerdown', (event) => {
  if (state.tool !== 'cursor') return;
  if (event.button !== 0) return;

  const handle = event.target.closest?.('.sel-handle');
  if (handle) {
    startDrag(event, 'resize');
    return;
  }

  const itemNode = event.target.closest?.('[data-media-id],[data-text-id]');
  if (!itemNode) {
    selectItem(null);
    return;
  }

  const kind = itemNode.dataset.mediaId ? 'media' : 'text';
  const id = itemNode.dataset.mediaId || itemNode.dataset.textId;
  selectItem({ kind, id });
  startDrag(event, 'move');
});

function removeSelected() {
  if (!state.selected) return;
  const { kind, id } = state.selected;
  send({ t: `${kind}.remove`, id });
  selectItem(null);
}

/* ================================ списки ================================ */

let listsQueued = false;

function scheduleLists() {
  if (listsQueued) return;
  listsQueued = true;
  setTimeout(() => {
    listsQueued = false;
    renderMediaList();
    renderTextList();
    updateUndoButton();
    updateSelectionBox();
    if (state.selected) {
      const exists = scene.getItem(state.selected.kind, state.selected.id);
      if (!exists) selectItem(null);
    }
    if (state.editingTextId && !scene.getItem('text', state.editingTextId)) resetTextForm();
  }, 0);
}

function updateUndoButton() {
  $('#btn-undo').disabled = scene.state.strokes.length === 0;
}

function renderMediaList() {
  const list = $('#media-list');
  const items = scene.state.media;
  $('#media-count').textContent = items.length;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Пока ничего не добавлено';
    list.append(empty);
    return;
  }

  for (const item of [...items].reverse()) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.id = item.id;
    if (state.selected?.kind === 'media' && state.selected.id === item.id) row.classList.add('selected');
    const thumb = item.kind === 'video' ? '<div class="thumb">▶</div>' : `<div class="thumb"><img src="${esc(item.url)}" alt="" /></div>`;
    row.innerHTML = `
      ${thumb}
      <div class="row-main">
        <div class="row-name" title="${esc(nameFromUrl(item.url))}">${esc(nameFromUrl(item.url))}</div>
        <input class="opacity-range" type="range" min="5" max="100" value="${Math.round(item.opacity * 100)}" data-role="opacity" title="Прозрачность" />
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-act="hide" title="${item.hidden ? 'Показать' : 'Скрыть'}">${item.hidden ? '◌' : '◉'}</button>
        <button class="icon-btn" data-act="full" title="На весь экран">⤢</button>
        <button class="icon-btn danger" data-act="remove" title="Удалить">✕</button>
      </div>`;
    list.append(row);
  }
}

function renderTextList() {
  const list = $('#text-list');
  const items = scene.state.texts;
  $('#text-count').textContent = items.length;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Текстов на экране нет';
    list.append(empty);
    return;
  }

  for (const item of [...items].reverse()) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.id = item.id;
    if (state.selected?.kind === 'text' && state.selected.id === item.id) row.classList.add('selected');
    row.innerHTML = `
      <div class="thumb">T</div>
      <div class="row-main">
        <div class="row-name" title="${esc(item.text)}">${esc(item.text)}</div>
        <div class="row-sub">${Math.round(item.size * 100)}% высоты${item.expiresAt ? ' · автоскрытие' : ''}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-act="edit" title="Изменить">✎</button>
        <button class="icon-btn" data-act="hide" title="${item.hidden ? 'Показать' : 'Скрыть'}">${item.hidden ? '◌' : '◉'}</button>
        <button class="icon-btn danger" data-act="remove" title="Удалить">✕</button>
      </div>`;
    list.append(row);
  }
}

/* ============================== инструменты ============================== */

const TOOL_NAMES = { cursor: 'Выбор', pen: 'Ручка', marker: 'Маркер', eraser: 'Ластик' };

function setTool(tool) {
  state.tool = tool;
  $$('.tool-btn[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  stage.classList.toggle('draw-mode', tool !== 'cursor');
  stage.classList.toggle('select-mode', tool === 'cursor');
  brushCursor.hidden = tool === 'cursor';
  if (tool === 'cursor') selectItem(null);
  updateStageHint();
}

function updateStageHint() {
  $('#stage-hint').textContent =
    state.tool === 'cursor'
      ? 'Выберите инструмент, чтобы рисовать. Кликните по картинке или тексту, чтобы двигать.'
      : `${TOOL_NAMES[state.tool]} · ${state.brushPx} px`;
}

function renderColors() {
  const box = $('#color-swatches');
  box.replaceChildren();
  for (const color of COLORS) {
    const button = document.createElement('button');
    button.className = `swatch${color === state.color ? ' active' : ''}`;
    button.style.background = color;
    button.dataset.color = color;
    button.title = color;
    box.append(button);
  }
  $('#brush-color').value = state.color;
}

$('#color-swatches').addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch');
  if (!swatch) return;
  state.color = swatch.dataset.color;
  localStorage.setItem(KEYS.color, state.color);
  renderColors();
  if (state.tool === 'cursor') setTool('pen');
});

$('#brush-color').addEventListener('input', (event) => {
  state.color = event.target.value;
  localStorage.setItem(KEYS.color, state.color);
  renderColors();
  if (state.tool === 'cursor') setTool('pen');
});

$('#brush-size').addEventListener('input', (event) => {
  state.brushPx = Number(event.target.value);
  localStorage.setItem(KEYS.size, String(state.brushPx));
  $('#brush-size-label').textContent = String(state.brushPx);
  updateBrushPreview();
  updateStageHint();
});

$$('.tool-btn[data-tool]').forEach((button) => {
  button.addEventListener('click', () => setTool(button.dataset.tool));
});

$('#btn-undo').addEventListener('click', () => send({ t: 'stroke.undo' }));

$('#btn-clear-draw').addEventListener('click', () => {
  if (!scene.state.strokes.length) return;
  send({ t: 'draw.clear' });
});

$('#btn-clear-all').addEventListener('click', () => {
  if (!confirm('Очистить рисунок, картинки и тексты на экране?')) return;
  send({ t: 'scene.clear' });
});

/* ================================ медиа ================================ */

function mediaAspect(url, kind) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(Number.isFinite(value) && value > 0 ? value : 16 / 9);
    };
    if (kind === 'video') {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => done(video.videoWidth / video.videoHeight);
      video.onerror = () => done(16 / 9);
      video.src = url;
    } else {
      const image = new Image();
      image.onload = () => done(image.naturalWidth / image.naturalHeight);
      image.onerror = () => done(16 / 9);
      image.src = url;
    }
    setTimeout(() => done(16 / 9), 4000);
  });
}

async function addMedia(url, kind) {
  const aspect = await mediaAspect(url, kind);
  let height = 0.55;
  let width = (aspect * height) / (16 / 9);
  if (width > 0.9) {
    width = 0.9;
    height = (width * (16 / 9)) / aspect;
  }
  if (width < 0.05) {
    width = 0.05;
    height = (width * (16 / 9)) / aspect;
  }
  const hold = Number($('#media-hold').value) || 0;
  send({
    t: 'media.add',
    item: {
      id: `m_${uid()}`,
      kind,
      url,
      x: (1 - width) / 2,
      y: (1 - height) / 2,
      w: width,
      h: height,
      opacity: 1,
      rotation: 0,
      hidden: false,
      fit: 'contain',
      ...(hold ? { expiresAt: Date.now() + hold } : {}),
    },
  });
}

async function addMediaFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    toast('Файл больше 25 МБ');
    return;
  }
  toast('Загружаю файл…', 60000);
  try {
    const form = new FormData();
    form.append('file', file);
    const result = await api('/api/upload', { method: 'POST', body: form });
    if (result.kind === 'audio') {
      state.sounds.unshift({ name: file.name, url: result.url });
      saveSounds();
      renderSounds();
      toast('Аудио добавлено во вкладку «Звук»');
      return;
    }
    await addMedia(result.url, result.kind === 'video' ? 'video' : 'image');
    toast('Добавлено на экран');
  } catch (err) {
    if (err.status === 415) toast('Такой формат не поддерживается');
    else if (err.status === 413) toast('Файл больше 25 МБ');
    else if (err.status === 400) toast('Не удалось загрузить файл');
    else toast('Ошибка загрузки');
  }
}

$('#media-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  addMediaFile(file);
});

const dropZone = $('#media-drop');
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('over');
  const file = event.dataTransfer?.files?.[0];
  if (file) addMediaFile(file);
});

$('#media-url-add').addEventListener('click', () => {
  const url = $('#media-url').value.trim();
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/media/')) {
    toast('Нужна ссылка http(s)://…');
    return;
  }
  addMedia(url, VIDEO_RE.test(url) ? 'video' : 'image');
  $('#media-url').value = '';
});

$('#media-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('#media-url-add').click();
  }
});

/* перетаскивание файлов прямо на сцену */
stage.addEventListener('dragover', (event) => event.preventDefault());
stage.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) addMediaFile(file);
});

$('#media-list').addEventListener('click', (event) => {
  const row = event.target.closest('.item-row');
  if (!row) return;
  const id = row.dataset.id;
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (action === 'hide') {
    const item = scene.getItem('media', id);
    if (item) send({ t: 'media.update', id, patch: { hidden: !item.hidden } });
    return;
  }
  if (action === 'full') {
    send({ t: 'media.update', id, patch: { x: 0, y: 0, w: 1, h: 1, fit: 'contain' } });
    return;
  }
  if (action === 'remove') {
    send({ t: 'media.remove', id });
    return;
  }
  selectItem({ kind: 'media', id });
});

$('#media-list').addEventListener('input', (event) => {
  if (!event.target.matches('[data-role="opacity"]')) return;
  const row = event.target.closest('.item-row');
  if (!row) return;
  scene.updateItemLocal('media', row.dataset.id, { opacity: Number(event.target.value) / 100 });
});

$('#media-list').addEventListener('change', (event) => {
  if (!event.target.matches('[data-role="opacity"]')) return;
  const row = event.target.closest('.item-row');
  if (!row) return;
  send({ t: 'media.update', id: row.dataset.id, patch: { opacity: Number(event.target.value) / 100 } });
});

/* ================================= текст ================================= */

function submitText() {
  const text = $('#text-input').value.trim();
  if (!text) {
    toast('Введите текст');
    return;
  }
  const hold = Number($('#text-hold').value) || 0;
  const common = {
    text,
    size: Number($('#text-size').value) / 100,
    color: $('#text-color').value,
    bg: $('#text-bg').checked ? 'rgba(0,0,0,0.55)' : '',
    outline: $('#text-outline').checked,
    bold: $('#text-bold').checked,
    align: 'center',
    opacity: 1,
    ...(hold ? { expiresAt: Date.now() + hold } : {}),
  };

  if (state.editingTextId) {
    send({ t: 'text.update', id: state.editingTextId, patch: common });
    resetTextForm();
    toast('Текст обновлён');
  } else {
    send({ t: 'text.add', item: { id: `t_${uid()}`, x: 0.5, y: 0.85, hidden: false, ...common } });
    $('#text-input').value = '';
  }
}

function resetTextForm() {
  state.editingTextId = null;
  $('#text-add').textContent = 'Показать';
  $('#text-cancel').hidden = true;
  $('#text-input').value = '';
}

$('#text-add').addEventListener('click', submitText);
$('#text-cancel').addEventListener('click', resetTextForm);

$('#text-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitText();
  }
});

$('#text-size').addEventListener('input', (event) => {
  $('#text-size-label').textContent = event.target.value;
});

$('#text-list').addEventListener('click', (event) => {
  const row = event.target.closest('.item-row');
  if (!row) return;
  const id = row.dataset.id;
  const action = event.target.closest('[data-act]')?.dataset.act;
  const item = scene.getItem('text', id);
  if (!item) return;

  if (action === 'remove') {
    send({ t: 'text.remove', id });
    if (state.editingTextId === id) resetTextForm();
    return;
  }
  if (action === 'hide') {
    send({ t: 'text.update', id, patch: { hidden: !item.hidden } });
    return;
  }
  if (action === 'edit') {
    state.editingTextId = id;
    $('#text-input').value = item.text;
    $('#text-size').value = String(Math.round(item.size * 100 * 2) / 2);
    $('#text-size-label').textContent = $('#text-size').value;
    $('#text-color').value = item.color;
    $('#text-bg').checked = Boolean(item.bg);
    $('#text-outline').checked = item.outline !== false;
    $('#text-bold').checked = Boolean(item.bold);
    $('#text-add').textContent = 'Обновить';
    $('#text-cancel').hidden = false;
    setTab('text');
    $('#text-input').focus();
    return;
  }
  selectItem({ kind: 'text', id });
});

/* ================================== TTS ================================== */

function setTtsStatus(text, kind) {
  const node = $('#tts-status');
  node.textContent = text;
  node.style.color = kind === 'error' ? '#ff8a8a' : kind === 'ok' ? '#7ee2b0' : '';
}

function fillVoices() {
  const select = $('#tts-voice');
  const saved = localStorage.getItem(KEYS.voice) || 'ru-RU-DmitryNeural';
  select.replaceChildren();
  const groups = new Map();
  for (const voice of state.voices) {
    const label =
      voice.provider === 'steos'
        ? 'DonationAlerts · SteosVoice'
        : voice.provider === 'yandex'
          ? 'DonationAlerts · Яндекс'
          : voice.locale.startsWith('ru')
            ? 'Русские'
            : voice.locale.startsWith('en')
              ? 'English'
              : voice.locale;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(voice);
  }
  for (const [label, list] of groups) {
    const group = document.createElement('optgroup');
    group.label = label;
    for (const voice of list) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${voice.name} · ${voice.locale}`;
      group.append(option);
    }
    select.append(group);
  }
  if (Array.from(select.options).some((option) => option.value === saved)) select.value = saved;
  else if (select.options.length) select.selectedIndex = 0;
}

async function loadVoices() {
  try {
    const data = await api('/api/voices');
    state.voices = data.voices || [];
  } catch {
    state.voices = [
      { id: 'ru-RU-DmitryNeural', name: 'Дмитрий', locale: 'ru-RU', gender: 'Male' },
      { id: 'ru-RU-SvetlanaNeural', name: 'Светлана', locale: 'ru-RU', gender: 'Female' },
      { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female' },
    ];
  }
  fillVoices();
}

function playLocal(url, volume) {
  try {
    const audio = new Audio(url);
    audio.volume = clamp(Number(volume) || 1, 0, 1);
    audio.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

async function sendTts() {
  const text = $('#tts-text').value.trim();
  if (!text) {
    toast('Введите текст для озвучки');
    return;
  }
  const voice = $('#tts-voice').value;
  const rate = Number($('#tts-rate').value);
  const pitch = Number($('#tts-pitch').value);
  const volume = Number($('#tts-volume').value) / 100;
  const button = $('#tts-send');

  localStorage.setItem(KEYS.voice, voice);
  button.disabled = true;
  setTtsStatus('Генерирую озвучку…');
  try {
    const result = await api('/api/tts', { method: 'POST', body: { text, voice, rate, pitch, volume } });
    if (state.monitor) playLocal(result.url, volume);
    setTtsStatus('Отправлено в эфир', 'ok');
    addRecent(text);
    $('#tts-text').value = '';
  } catch (err) {
    if (err.data?.error === 'tts_failed') {
      send({ t: 'tts.fallback', text, volume });
      setTtsStatus('Edge TTS недоступен — озвучиваю системным голосом', 'error');
    } else if (err.status === 429) {
      setTtsStatus('Подождите: предыдущая озвучка ещё генерируется');
    } else if (err.status === 0) {
      setTtsStatus('Нет связи с сервером', 'error');
    } else {
      setTtsStatus('Ошибка озвучки', 'error');
    }
  } finally {
    button.disabled = false;
  }
}

$('#tts-send').addEventListener('click', sendTts);

const TTS_PRESETS = {
  plain: { rate: 0, pitch: 0 },
  narrator: { rate: -10, pitch: -5 },
  radio: { rate: 8, pitch: 2 },
  chipmunk: { rate: 40, pitch: 50 },
  demon: { rate: -25, pitch: -50 },
};

function applyTtsPreset(name) {
  const preset = TTS_PRESETS[name];
  if (!preset) return;
  for (const [selector, value] of [
    ['#tts-rate', preset.rate],
    ['#tts-pitch', preset.pitch],
  ]) {
    const input = $(selector);
    input.value = String(value);
    input.dispatchEvent(new Event('input'));
  }
}

async function previewVoice(button) {
  const voice = $('#tts-voice').value;
  const meta = state.voices.find((item) => item.id === voice);
  const sample =
    meta?.locale && !meta.locale.startsWith('ru')
      ? 'Hello! This is how I sound on stream.'
      : 'Привет! Так я звучу в эфире.';

  button.disabled = true;
  setTtsStatus('Генерирую пример голоса…');
  try {
    const result = await api('/api/tts', {
      method: 'POST',
      body: {
        text: sample,
        voice,
        rate: Number($('#tts-rate').value),
        pitch: Number($('#tts-pitch').value),
        preview: true,
      },
    });
    playLocal(result.url, 1);
    setTtsStatus('Это пример выбранного голоса', 'ok');
  } catch (err) {
    if (err.status === 429) setTtsStatus('Подождите: предыдущая озвучка ещё генерируется');
    else if (err.status === 0) setTtsStatus('Нет связи с сервером', 'error');
    else setTtsStatus('Не удалось получить пример', 'error');
  } finally {
    button.disabled = false;
  }
}

$('#tts-preview').addEventListener('click', (event) => previewVoice(event.currentTarget));

$('#tts-stop').addEventListener('click', async () => {
  try {
    await api('/api/tts/stop', { method: 'POST' });
    setTtsStatus('Озвучка остановлена', 'ok');
  } catch {
    setTtsStatus('Нет связи с сервером', 'error');
  }
});

$('#tts-presets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tts-preset]');
  if (button) applyTtsPreset(button.dataset.ttsPreset);
});


$('#tts-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendTts();
  }
});

$('#tts-refresh').addEventListener('click', () => {
  setTtsStatus('Обновляю список голосов…');
  loadVoices().then(() => setTtsStatus('Список обновлён', 'ok'));
});

$('#tts-monitor').addEventListener('change', (event) => {
  state.monitor = event.target.checked;
  localStorage.setItem(KEYS.monitor, state.monitor ? '1' : '0');
});

function recentList() {
  const list = readJson(KEYS.recent, []);
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [];
}

function addRecent(text) {
  const list = [text, ...recentList().filter((item) => item !== text)].slice(0, 8);
  writeJson(KEYS.recent, list);
  renderRecent();
}

function renderRecent() {
  const box = $('#tts-recent');
  const list = recentList();
  box.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Здесь появятся последние фразы';
    box.append(empty);
    return;
  }
  for (const text of list) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = text;
    chip.title = text;
    chip.addEventListener('click', () => {
      $('#tts-text').value = text;
      $('#tts-text').focus();
    });
    box.append(chip);
  }
}

/* ================================= звуки ================================= */

function saveSounds() {
  writeJson(KEYS.sounds, state.sounds.slice(0, 40));
}

function renderSounds() {
  const list = $('#sound-list');
  list.replaceChildren();
  if (!state.sounds.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Своих звуков пока нет';
    list.append(empty);
    return;
  }
  state.sounds.forEach((sound, index) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="thumb">♪</div>
      <div class="row-main"><div class="row-name" title="${esc(sound.name)}">${esc(sound.name)}</div></div>
      <div class="row-actions">
        <button class="icon-btn" data-act="play" title="Проиграть">▶</button>
        <button class="icon-btn danger" data-act="remove" title="Удалить">✕</button>
      </div>`;
    list.append(row);
  });
}

function playSoundUrl(url) {
  send({ t: 'sound', url, volume: state.soundVolume });
}

$('#sound-list').addEventListener('click', (event) => {
  const row = event.target.closest('.item-row');
  if (!row) return;
  const index = Number(row.dataset.index);
  const sound = state.sounds[index];
  if (!sound) return;
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (action === 'remove') {
    state.sounds.splice(index, 1);
    saveSounds();
    renderSounds();
    return;
  }
  playSoundUrl(sound.url);
});

$('#sound-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const form = new FormData();
    form.append('file', file);
    const result = await api('/api/upload', { method: 'POST', body: form });
    if (result.kind !== 'audio') {
      toast('Это не аудиофайл');
      return;
    }
    state.sounds.unshift({ name: file.name, url: result.url });
    saveSounds();
    renderSounds();
    toast('Звук загружен');
  } catch {
    toast('Не удалось загрузить звук');
  }
});

$('#sound-presets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-preset]');
  if (!button) return;
  send({ t: 'sound', preset: button.dataset.preset, volume: state.soundVolume });
});

$('#sound-volume').value = String(Math.round(state.soundVolume * 100));
$('#sound-volume-label').textContent = `${Math.round(state.soundVolume * 100)}%`;
$('#sound-volume').addEventListener('input', (event) => {
  state.soundVolume = Number(event.target.value) / 100;
  localStorage.setItem(KEYS.volume, String(state.soundVolume));
  $('#sound-volume-label').textContent = `${event.target.value}%`;
});

/* ================================ эффекты ================================ */

$$('[data-fx]').forEach((button) => {
  button.addEventListener('click', () => send({ t: 'fx', kind: button.dataset.fx }));
});

$('#fx-clear-draw').addEventListener('click', () => send({ t: 'draw.clear' }));
$('#fx-clear-all').addEventListener('click', () => {
  if (!confirm('Очистить всё на экране?')) return;
  send({ t: 'scene.clear' });
});

/* ================================= админ ================================= */

function renderUsers() {
  const list = $('#user-list');
  if (!state.isAdmin) return;
  list.replaceChildren();
  if (!state.users.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Нет пользователей';
    list.append(empty);
    return;
  }
  for (const user of state.users) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.id = user.id;
    const isMe = user.id === state.me?.id;
    row.innerHTML = `
      <div class="thumb">${user.role === 'admin' ? '★' : '◆'}</div>
      <div class="row-main">
        <div class="row-name">${esc(user.login)}${isMe ? ' <span class="row-sub">(вы)</span>' : ''}</div>
        <div class="row-sub">${user.role === 'admin' ? 'администратор' : 'модератор'}</div>
      </div>
      <div class="row-actions">
        ${isMe ? '' : '<button class="icon-btn" data-act="pass" title="Сменить пароль">⚿</button>'}
        ${isMe ? '' : '<button class="icon-btn danger" data-act="del" title="Удалить">✕</button>'}
      </div>`;
    list.append(row);
  }
}

async function refreshUsers() {
  try {
    const result = await api('/api/users');
    state.users = result.users || [];
    renderUsers();
  } catch {
    /* ignore */
  }
}

$('#user-list').addEventListener('click', async (event) => {
  const row = event.target.closest('.item-row');
  if (!row) return;
  const user = state.users.find((item) => item.id === row.dataset.id);
  if (!user) return;
  const action = event.target.closest('[data-act]')?.dataset.act;

  if (action === 'del') {
    if (!confirm(`Удалить пользователя ${user.login}?`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      toast('Пользователь удалён');
      refreshUsers();
    } catch (err) {
      toast(err.data?.error === 'last_admin' ? 'Нельзя удалить последнего администратора' : 'Не удалось удалить');
    }
    return;
  }

  if (action === 'pass') {
    if (user.id === state.me?.id) {
      openProfile();
      return;
    }
    const password = await askPassword('Новый пароль', `Пользователь: ${user.login}`);
    if (!password) return;
    try {
      await api(`/api/users/${encodeURIComponent(user.id)}/password`, { method: 'POST', body: { password } });
      toast('Пароль изменён');
    } catch {
      toast('Не удалось сменить пароль');
    }
  }
});

$('#user-add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const login = $('#user-login').value.trim().toLowerCase();
  const password = $('#user-password').value;
  const role = $('#user-role').value;
  if (!/^[a-z0-9_.-]{3,32}$/.test(login)) {
    toast('Логин: 3–32 символа, латиница, цифры, . _ -');
    return;
  }
  if (password.length < 8) {
    toast('Пароль минимум 8 символов');
    return;
  }
  try {
    const result = await api('/api/users', { method: 'POST', body: { login, password, role } });
    state.users.push(result.user);
    renderUsers();
    form.reset();
    toast('Пользователь добавлен');
  } catch (err) {
    if (err.data?.error === 'login_exists') toast('Такой логин уже занят');
    else toast('Не удалось создать пользователя');
  }
});

$('#btn-profile').addEventListener('click', openProfile);
$('#profile-cancel').addEventListener('click', closeProfile);
profileModal.addEventListener('click', (event) => {
  if (event.target === profileModal) closeProfile();
});

$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = $('#profile-current').value;
  const next = $('#profile-next').value;
  const confirm = $('#profile-confirm').value;
  const error = $('#profile-error');
  error.textContent = '';
  if (next.length < 8) {
    error.textContent = 'Новый пароль должен быть не короче 8 символов.';
    return;
  }
  if (next !== confirm) {
    error.textContent = 'Пароли не совпадают.';
    return;
  }
  const button = $('button[type=submit]', $('#profile-form'));
  button.disabled = true;
  button.textContent = 'Сохраняю…';
  try {
    const result = await api('/api/me/password', { method: 'POST', body: { current, next } });
    if (result.token) {
      state.token = result.token;
      localStorage.setItem(KEYS.token, result.token);
    }
    if (result.user) state.me = result.user;
    closeProfile();
    toast('Пароль изменён');
    // Сервер инвалидировал старый токен — переподключаемся с новым.
    reconnectWs();
  } catch (err) {
    error.textContent =
      err.data?.error === 'wrong_password'
        ? 'Неверный текущий пароль.'
        : err.data?.error === 'weak_password'
          ? 'Новый пароль слишком короткий.'
          : 'Не удалось сменить пароль.';
  } finally {
    button.disabled = false;
    button.textContent = 'Сохранить';
  }
});

$('#btn-copy-url').addEventListener('click', async () => {
  const ok = await copyText(state.room?.overlayUrl ?? '');
  toast(ok ? 'Ссылка для OBS скопирована' : 'Не удалось скопировать');
});

$('#copy-overlay').addEventListener('click', async () => {
  const ok = await copyText($('#overlay-url').value);
  toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать');
});

$('#rotate-key').addEventListener('click', async () => {
  if (!confirm('Старая ссылка перестанет работать. Сгенерировать новый ключ?')) return;
  try {
    const result = await api('/api/room/rotate-key', { method: 'POST' });
    if (state.room) {
      state.room.overlayKey = result.overlayKey;
      state.room.overlayUrl = result.overlayUrl;
    }
    $('#overlay-url').value = result.overlayUrl;
    toast('Ключ обновлён — замените ссылку в OBS');
  } catch {
    toast('Не удалось обновить ключ');
  }
});

/* ================================= вкладки ================================= */

function setTab(name) {
  $$('#tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === name));
}

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  setTab(button.dataset.tab);
});

/* ================================ горячие клавиши ================================ */

window.addEventListener('keydown', (event) => {
  const tag = (event.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

  if (event.ctrlKey && event.key.toLowerCase() === 'z' && !typing) {
    event.preventDefault();
    send({ t: 'stroke.undo' });
    return;
  }
  if (event.key === 'Escape' && !profileModal.hidden) {
    event.preventDefault();
    closeProfile();
    return;
  }
  if (!profileModal.hidden || !modal.hidden) return;
  if (typing) return;

  if (event.key === 'Escape') {
    selectItem(null);
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (state.selected) {
      event.preventDefault();
      removeSelected();
    }
    return;
  }

  const tools = { v: 'cursor', p: 'pen', m: 'marker', e: 'eraser' };
  const tool = tools[event.key.toLowerCase()];
  if (tool) setTool(tool);
});

/* ================================ инициализация ================================ */

function init() {
  renderColors();
  $('#brush-size').value = String(state.brushPx);
  $('#brush-size-label').textContent = String(state.brushPx);
  $('#brush-size').dispatchEvent(new Event('input'));

  $('#tts-monitor').checked = state.monitor;
  $('#sound-volume').value = String(Math.round(state.soundVolume * 100));
  $('#sound-volume-label').textContent = `${Math.round(state.soundVolume * 100)}%`;

  boundRange('#tts-rate', '#tts-rate-label', (value) => `${Number(value) > 0 ? '+' : ''}${value}%`);
  boundRange('#tts-pitch', '#tts-pitch-label', (value) => (Number(value) > 0 ? `+${value}` : String(value)));
  boundRange('#tts-volume', '#tts-volume-label', (value) => `${value}%`);
  $('#text-size-label').textContent = $('#text-size').value;

  renderRecent();
  renderSounds();
  updateStageHint();
  setTool('cursor');

  const resizeObserver = new ResizeObserver(() => fitStage());
  resizeObserver.observe(stageFrame);
  window.addEventListener('resize', () => {
    fitStage();
    updateSelectionBox();
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  if (state.token) {
    boot();
  } else {
    showLogin();
  }
}

function boundRange(inputSelector, outputSelector, format) {
  const input = $(inputSelector);
  const output = $(outputSelector);
  if (!input || !output) return;
  const update = () => {
    output.textContent = format(input.value);
  };
  input.addEventListener('input', update);
  update();
}

init();
