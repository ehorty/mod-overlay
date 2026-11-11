import { SceneView } from '../shared/scene.js';
import { WIDGET_META, WIDGET_TYPES, fmtDuration, timerRemaining } from '../shared/widgets.js';

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
  queue: 'modoverlay.soundQueue',
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
  editingWidgetId: null,
  voices: [],
  monitor: localStorage.getItem(KEYS.monitor) === '1',
  sounds: [],
  soundVolume: clamp(storedVolume, 0, 1),
  soundQueueMode: localStorage.getItem(KEYS.queue) !== '0',
  soundSearch: '',
  soundCategory: '',
  soundFavOnly: false,
  editingSoundId: null,
  perms: [],
  permLabels: [],
  permsTarget: null,
  feed: [],
  feedFilter: 'all',
  feedSearch: '',
};

const scene = new SceneView($('#scene'), { onChange: scheduleLists });
const stage = $('#stage');
const stageFrame = $('.stage-frame');
const selectionBox = $('#selection');
const brushCursor = $('#brush-cursor');
const toastEl = $('#toast');
const modal = $('#modal');
const profileModal = $('#profile-modal');
const soundModal = $('#sound-modal');
const permsModal = $('#perms-modal');

/** Эффективное право текущего пользователя (админ всегда может всё). */
function hasPerm(perm) {
  return state.isAdmin || state.perms.includes(perm);
}

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
  applyPermissions();
  fitStage();
}

async function boot() {
  try {
    const data = await api('/api/bootstrap');
    state.me = data.user;
    state.room = data.room;
    state.isAdmin = data.user.role === 'admin';
    state.perms = Array.isArray(data.user.perms) ? data.user.perms : [];
    state.permLabels = Array.isArray(data.permLabels) ? data.permLabels : [];
    state.users = data.users || [];
    state.sounds = Array.isArray(data.sounds) ? data.sounds : [];
    scene.setState(data.state);
    showApp();
    renderUsers();
    renderSoundboard();
    renderWidgetPicker();
    renderWidgetList();
    initNotifyForm();
    renderFeedFilters();
    connectWs();
    loadVoices();
    loadEvents();
    migrateLocalSounds();
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
      if (msg.me && Array.isArray(msg.me.perms)) {
        state.perms = msg.me.perms;
        applyPermissions();
      }
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
    case 'widget.add':
    case 'widget.update':
      scene.upsertWidget(msg.item);
      if (!state.drag) scheduleLists();
      if (state.editingWidgetId === msg.item.id) syncWidgetEditor(msg.item);
      break;
    case 'widget.remove':
      scene.removeWidget(msg.id);
      if (state.editingWidgetId === msg.id) closeWidgetEditor();
      scheduleLists();
      break;
    case 'scene.clear':
      scene.clearAll();
      closeWidgetEditor();
      scheduleLists();
      break;
    case 'event':
      addFeedEntry(msg.entry);
      break;
    case 'events.clear':
      state.feed = [];
      renderFeed();
      break;
    case 'perms':
      if (Array.isArray(msg.perms)) {
        state.perms = msg.perms;
        applyPermissions();
        toast('Ваши права обновлены');
      }
      break;
    case 'notify':
    case 'sound.stop':
    case 'sound.clearQueue':
    case 'tts.stop':
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
  if (target?.kind === 'widget') {
    const item = scene.getItem('widget', target.id);
    if (item) openWidgetEditor(item);
    else closeWidgetEditor();
  } else {
    closeWidgetEditor();
  }
}

function updateSelectionBox() {
  const selected = state.selected;
  if (!selected) {
    selectionBox.hidden = true;
    return;
  }
  const node = scene.itemEl(selected.kind, selected.id);
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
  const node = scene.itemEl(selected.kind, selected.id);
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
      selected.kind === 'text'
        ? { x: item.x, y: item.y, size: item.size }
        : { x: item.x, y: item.y, w: item.w, h: item.h },
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
  } else if (drag.kind === 'text') {
    patch = { size: clamp(drag.orig.size + (dx + dy) * 0.35, 0.01, 0.25) };
  } else {
    patch = { w: clamp(drag.orig.w + dx, 0.02, 2), h: clamp(drag.orig.h + dy, 0.02, 2) };
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

  const itemNode = event.target.closest?.('[data-media-id],[data-text-id],[data-widget-id]');
  if (!itemNode) {
    selectItem(null);
    return;
  }

  const kind = itemNode.dataset.mediaId ? 'media' : itemNode.dataset.widgetId ? 'widget' : 'text';
  const id = itemNode.dataset.mediaId || itemNode.dataset.widgetId || itemNode.dataset.textId;
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
    renderWidgetList();
    updateUndoButton();
    updateSelectionBox();
    if (state.selected) {
      const exists = scene.getItem(state.selected.kind, state.selected.id);
      if (!exists) selectItem(null);
    }
    if (state.editingTextId && !scene.getItem('text', state.editingTextId)) resetTextForm();
    if (state.editingWidgetId && !scene.getItem('widget', state.editingWidgetId)) closeWidgetEditor();
  }, 0);
}

function updateUndoButton() {
  $('#btn-undo').disabled = !hasPerm('draw') || scene.state.strokes.length === 0;
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
  if (tool !== 'cursor' && !hasPerm('draw')) {
    toast('Рисование недоступно для вашего аккаунта');
    return;
  }
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
      if (hasPerm('sound')) {
        await addSoundToServer({ name: file.name, url: result.url });
        toast('Аудио добавлено в библиотеку звуков');
      } else {
        toast('Аудио загружено, но нет прав на библиотеку звуков');
      }
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

/* ================================ soundboard ================================ */

const HOTKEY_RE = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/;

function cleanHotkey(value) {
  const s = String(value || '').trim().toLowerCase();
  return HOTKEY_RE.test(s) ? s : '';
}

function soundCategories() {
  const set = new Set(state.sounds.map((s) => s.category || 'Общее'));
  return [...set].sort((a, b) => (a === 'Общее' ? -1 : b === 'Общее' ? 1 : a.localeCompare(b, 'ru')));
}

function filteredSounds() {
  const query = state.soundSearch.trim().toLowerCase();
  return state.sounds.filter((s) => {
    if (state.soundFavOnly && !s.favorite) return false;
    if (state.soundCategory && (s.category || 'Общее') !== state.soundCategory) return false;
    if (query && !`${s.name} ${s.category}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

function upsertSound(sound) {
  const index = state.sounds.findIndex((s) => s.id === sound.id);
  if (index >= 0) state.sounds[index] = sound;
  else state.sounds.push(sound);
}

function renderSoundboard() {
  $('#sound-count').textContent = String(state.sounds.length);
  const cats = $('#sound-cats');
  cats.replaceChildren();
  const all = document.createElement('button');
  all.className = `cat-chip${state.soundCategory === '' ? ' active' : ''}`;
  all.dataset.cat = '';
  all.textContent = 'Все';
  cats.append(all);
  for (const category of soundCategories()) {
    const chip = document.createElement('button');
    chip.className = `cat-chip${state.soundCategory === category ? ' active' : ''}`;
    chip.dataset.cat = category;
    chip.textContent = category;
    cats.append(chip);
  }
  const datalist = $('#sound-cat-list');
  datalist.replaceChildren();
  for (const category of soundCategories()) {
    const option = document.createElement('option');
    option.value = category;
    datalist.append(option);
  }
  renderSoundGrid();
}

function renderSoundGrid() {
  const grid = $('#sound-grid');
  const sounds = filteredSounds();
  grid.replaceChildren();
  if (!sounds.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.sounds.length ? 'Ничего не найдено' : 'Библиотека пуста — загрузите первый звук';
    grid.append(empty);
    return;
  }
  for (const sound of sounds) {
    const pad = document.createElement('div');
    pad.className = `sound-pad${sound.favorite ? ' fav' : ''}`;
    pad.dataset.id = sound.id;
    pad.draggable = true;
    pad.title = `${sound.name} — клик для воспроизведения`;
    pad.innerHTML = `
      <button class="pad-fav" data-act="fav" title="${sound.favorite ? 'Убрать из избранного' : 'В избранное'}">${sound.favorite ? '★' : '☆'}</button>
      <button class="pad-edit" data-act="edit" title="Настроить">✎</button>
      <span class="pad-icon">♪</span>
      <span class="pad-name">${esc(sound.name)}</span>
      <span class="pad-cat">${esc(sound.category || 'Общее')}</span>
      ${sound.hotkey ? `<span class="pad-key">${esc(sound.hotkey.toUpperCase())}</span>` : ''}`;
    grid.append(pad);
  }
}

function playSound(sound) {
  if (!sound) return;
  send({ t: 'sound', url: sound.url, volume: state.soundVolume, queue: state.soundQueueMode });
  playLocal(sound.url, state.soundVolume);
  const pad = $(`.sound-pad[data-id="${sound.id}"]`);
  if (pad) {
    pad.classList.remove('playing');
    void pad.offsetWidth;
    pad.classList.add('playing');
  }
}

async function addSoundToServer(input, silent = false) {
  const result = await api('/api/sounds', { method: 'POST', body: input });
  upsertSound(result.sound);
  if (!silent) {
    renderSoundboard();
    toast(result.created ? 'Звук добавлен в библиотеку' : 'Такой звук уже есть');
  }
  return result.sound;
}

async function toggleSoundFav(sound) {
  const favorite = !sound.favorite;
  sound.favorite = favorite;
  renderSoundGrid();
  try {
    const result = await api(`/api/sounds/${encodeURIComponent(sound.id)}`, { method: 'PATCH', body: { favorite } });
    upsertSound(result.sound);
    renderSoundGrid();
  } catch {
    sound.favorite = !favorite;
    renderSoundGrid();
    toast('Не удалось изменить избранное');
  }
}

$('#sound-grid').addEventListener('click', (event) => {
  const pad = event.target.closest('.sound-pad');
  if (!pad) return;
  const sound = state.sounds.find((s) => s.id === pad.dataset.id);
  if (!sound) return;
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (action === 'fav') {
    toggleSoundFav(sound);
    return;
  }
  if (action === 'edit') {
    openSoundModal(sound);
    return;
  }
  playSound(sound);
});

let dragSoundId = null;

$('#sound-grid').addEventListener('dragstart', (event) => {
  const pad = event.target.closest('.sound-pad');
  if (!pad) return;
  dragSoundId = pad.dataset.id;
  pad.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  try {
    event.dataTransfer.setData('text/plain', dragSoundId);
  } catch {
    /* ignore */
  }
});

$('#sound-grid').addEventListener('dragend', (event) => {
  event.target.closest('.sound-pad')?.classList.remove('dragging');
  $$('.sound-pad.drag-over').forEach((p) => p.classList.remove('drag-over'));
  dragSoundId = null;
});

$('#sound-grid').addEventListener('dragover', (event) => {
  if (!dragSoundId) return;
  event.preventDefault();
  const pad = event.target.closest('.sound-pad');
  $$('.sound-pad.drag-over').forEach((p) => p.classList.remove('drag-over'));
  if (pad && pad.dataset.id !== dragSoundId) pad.classList.add('drag-over');
});

$('#sound-grid').addEventListener('drop', async (event) => {
  if (!dragSoundId) return;
  event.preventDefault();
  const pad = event.target.closest('.sound-pad');
  $$('.sound-pad.drag-over').forEach((p) => p.classList.remove('drag-over'));
  const targetId = pad?.dataset.id;
  const from = state.sounds.findIndex((s) => s.id === dragSoundId);
  if (from < 0 || !targetId || targetId === dragSoundId) return;
  const to = state.sounds.findIndex((s) => s.id === targetId);
  if (to < 0) return;
  const [moved] = state.sounds.splice(from, 1);
  state.sounds.splice(to, 0, moved);
  renderSoundGrid();
  try {
    const result = await api('/api/sounds/reorder', { method: 'POST', body: { ids: state.sounds.map((s) => s.id) } });
    state.sounds = result.sounds || state.sounds;
    renderSoundboard();
  } catch {
    toast('Не удалось сохранить порядок');
  }
});

$('#sound-search').addEventListener('input', (event) => {
  state.soundSearch = event.target.value;
  renderSoundGrid();
});

$('#sound-cats').addEventListener('click', (event) => {
  const chip = event.target.closest('.cat-chip');
  if (!chip) return;
  state.soundCategory = chip.dataset.cat;
  renderSoundboard();
});

$('#sound-fav-filter').addEventListener('change', (event) => {
  state.soundFavOnly = event.target.checked;
  renderSoundGrid();
});

$('#sound-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    toast('Файл больше 25 МБ');
    return;
  }
  toast('Загружаю звук…', 60000);
  try {
    const form = new FormData();
    form.append('file', file);
    const result = await api('/api/upload', { method: 'POST', body: form });
    if (result.kind !== 'audio') {
      toast('Это не аудиофайл');
      return;
    }
    await addSoundToServer({ name: file.name, url: result.url });
  } catch (err) {
    if (err.status === 413) toast('Файл больше 25 МБ');
    else if (err.status === 403) toast('Нет прав на загрузку звуков');
    else toast('Не удалось загрузить звук');
  }
});

$('#sound-url-add').addEventListener('click', async () => {
  const url = $('#sound-url').value.trim();
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/media/')) {
    toast('Нужна ссылка http(s)://…');
    return;
  }
  try {
    await addSoundToServer({ name: nameFromUrl(url), url });
    $('#sound-url').value = '';
  } catch (err) {
    toast(err.data?.error === 'sound_limit' ? 'Достигнут лимит звуков (200)' : 'Не удалось добавить звук');
  }
});

$('#sound-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('#sound-url-add').click();
  }
});

$('#sound-presets').addEventListener('click', (event) => {
  const button = event.target.closest('[data-preset]');
  if (!button) return;
  send({ t: 'sound', preset: button.dataset.preset, volume: state.soundVolume, queue: state.soundQueueMode });
});

$('#sound-stop').addEventListener('click', () => send({ t: 'sound.stop' }));
$('#sound-clear-queue').addEventListener('click', () => send({ t: 'sound.clearQueue' }));

$('#sound-queue').addEventListener('change', (event) => {
  state.soundQueueMode = event.target.checked;
  localStorage.setItem(KEYS.queue, state.soundQueueMode ? '1' : '0');
});

$('#sound-volume').value = String(Math.round(state.soundVolume * 100));
$('#sound-volume-label').textContent = `${Math.round(state.soundVolume * 100)}%`;
$('#sound-volume').addEventListener('input', (event) => {
  state.soundVolume = Number(event.target.value) / 100;
  localStorage.setItem(KEYS.volume, String(state.soundVolume));
  $('#sound-volume-label').textContent = `${event.target.value}%`;
});

/* ---------------------------- модалка звука ---------------------------- */

function openSoundModal(sound) {
  state.editingSoundId = sound.id;
  $('#sound-edit-name').value = sound.name;
  $('#sound-edit-category').value = sound.category || '';
  $('#sound-edit-hotkey').value = sound.hotkey || '';
  $('#sound-edit-fav').checked = Boolean(sound.favorite);
  $('#sound-edit-error').textContent = '';
  soundModal.hidden = false;
  setTimeout(() => $('#sound-edit-name').focus(), 30);
}

function closeSoundModal() {
  soundModal.hidden = true;
  state.editingSoundId = null;
  $('#sound-edit-error').textContent = '';
}

$('#sound-edit-cancel').addEventListener('click', closeSoundModal);
soundModal.addEventListener('click', (event) => {
  if (event.target === soundModal) closeSoundModal();
});

$('#sound-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = state.editingSoundId;
  if (!id) return;
  const hotkeyRaw = $('#sound-edit-hotkey').value;
  const hotkey = cleanHotkey(hotkeyRaw);
  const error = $('#sound-edit-error');
  if (hotkeyRaw.trim() && !hotkey) {
    error.textContent = 'Клавиша: одна буква/цифра или F1–F12.';
    return;
  }
  const button = $('button[type=submit]', $('#sound-form'));
  button.disabled = true;
  try {
    const result = await api(`/api/sounds/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        name: $('#sound-edit-name').value,
        category: $('#sound-edit-category').value,
        hotkey,
        favorite: $('#sound-edit-fav').checked,
      },
    });
    upsertSound(result.sound);
    renderSoundboard();
    closeSoundModal();
    toast('Звук обновлён');
  } catch {
    error.textContent = 'Не удалось сохранить звук.';
  } finally {
    button.disabled = false;
  }
});

$('#sound-edit-delete').addEventListener('click', async () => {
  const id = state.editingSoundId;
  if (!id) return;
  const sound = state.sounds.find((s) => s.id === id);
  if (!confirm(`Удалить звук «${sound?.name ?? ''}»?`)) return;
  try {
    await api(`/api/sounds/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.sounds = state.sounds.filter((s) => s.id !== id);
    renderSoundboard();
    closeSoundModal();
    toast('Звук удалён');
  } catch {
    toast('Не удалось удалить звук');
  }
});

/** Переносит старые локальные звуки (localStorage) в серверную библиотеку. */
async function migrateLocalSounds() {
  const legacy = readJson(KEYS.sounds, []);
  if (!Array.isArray(legacy) || !legacy.length) return;
  const known = new Set(state.sounds.map((s) => s.url));
  let moved = 0;
  for (const item of legacy.slice(0, 40)) {
    if (!item || typeof item.url !== 'string') continue;
    if (known.has(item.url)) continue;
    try {
      await addSoundToServer({ name: item.name || nameFromUrl(item.url), url: item.url }, true);
      known.add(item.url);
      moved++;
    } catch {
      /* пропускаем недоступные */
    }
  }
  localStorage.removeItem(KEYS.sounds);
  if (moved) {
    renderSoundboard();
    toast(`Перенесено звуков в библиотеку: ${moved}`);
  }
}

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
    const permCount = Array.isArray(user.perms) ? user.perms.length : 0;
    const permHint = user.role === 'admin' ? 'полный доступ' : permCount ? `прав: ${permCount}` : 'полный доступ';
    row.innerHTML = `
      <div class="thumb">${user.role === 'admin' ? '★' : '◆'}</div>
      <div class="row-main">
        <div class="row-name">${esc(user.login)}${isMe ? ' <span class="row-sub">(вы)</span>' : ''}</div>
        <div class="row-sub">${user.role === 'admin' ? 'администратор' : 'модератор'} · ${permHint}</div>
      </div>
      <div class="row-actions">
        ${!isMe && user.role === 'mod' ? '<button class="icon-btn" data-act="perms" title="Права доступа">🛡</button>' : ''}
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

  if (action === 'perms') {
    openPermsModal(user);
    return;
  }

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

/* ---------------------------- права модератора ---------------------------- */

function openPermsModal(user) {
  state.permsTarget = user;
  $('#perms-user').textContent = user.login;
  const full = !Array.isArray(user.perms);
  $('#perms-full').checked = full;
  const grid = $('#perms-grid');
  grid.replaceChildren();
  const labels = state.permLabels.length ? state.permLabels : PERM_FALLBACK;
  const active = new Set(Array.isArray(user.perms) ? user.perms : labels.map((p) => p.id));
  for (const perm of labels) {
    const label = document.createElement('label');
    label.className = 'check perm-check';
    label.innerHTML = `<input type="checkbox" value="${esc(perm.id)}" ${active.has(perm.id) ? 'checked' : ''} /> ${esc(perm.label)}`;
    grid.append(label);
  }
  grid.classList.toggle('disabled', full);
  permsModal.hidden = false;
}

const PERM_FALLBACK = [
  { id: 'draw', label: 'Рисование' },
  { id: 'media', label: 'Медиа' },
  { id: 'text', label: 'Текст' },
  { id: 'tts', label: 'Озвучка (TTS)' },
  { id: 'sound', label: 'Звуки' },
  { id: 'fx', label: 'Эффекты' },
  { id: 'widgets', label: 'Виджеты' },
  { id: 'notify', label: 'Уведомления' },
  { id: 'clear', label: 'Очистка экрана' },
];

function closePermsModal() {
  permsModal.hidden = true;
  state.permsTarget = null;
}

$('#perms-full').addEventListener('change', (event) => {
  $('#perms-grid').classList.toggle('disabled', event.target.checked);
});

$('#perms-cancel').addEventListener('click', closePermsModal);
permsModal.addEventListener('click', (event) => {
  if (event.target === permsModal) closePermsModal();
});

$('#perms-save').addEventListener('click', async () => {
  const user = state.permsTarget;
  if (!user) return;
  const full = $('#perms-full').checked;
  const perms = $$('#perms-grid input[type=checkbox]').filter((c) => c.checked).map((c) => c.value);
  const button = $('#perms-save');
  button.disabled = true;
  try {
    const result = await api(`/api/users/${encodeURIComponent(user.id)}/perms`, {
      method: 'POST',
      body: full ? { full: true } : { perms },
    });
    if (result.user) {
      const index = state.users.findIndex((u) => u.id === user.id);
      if (index >= 0) state.users[index] = result.user;
    }
    renderUsers();
    closePermsModal();
    toast(full ? 'Полный доступ выдан' : 'Права обновлены');
  } catch (err) {
    toast(err.data?.error === 'admin_has_all' ? 'Администратор всегда имеет все права' : 'Не удалось сохранить права');
  } finally {
    button.disabled = false;
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

/* ================================ права доступа ================================ */

function applyPermissions() {
  const tabPerm = { media: 'media', text: 'text', tts: 'tts', sound: 'sound', widgets: 'widgets', notify: 'notify' };
  let firstVisible = null;
  $$('#tabs button[data-tab]').forEach((button) => {
    const name = button.dataset.tab;
    let visible;
    if (name === 'admin') visible = state.isAdmin;
    else if (name === 'feed') visible = true;
    else if (name === 'fx') visible = hasPerm('fx') || hasPerm('clear');
    else visible = hasPerm(tabPerm[name]);
    button.hidden = !visible;
    if (visible && !firstVisible) firstVisible = name;
  });
  const active = $('#tabs button.active');
  if (active && active.hidden && firstVisible) setTab(firstVisible);

  const canDraw = hasPerm('draw');
  $$('.tool-btn[data-tool]').forEach((button) => {
    if (button.dataset.tool !== 'cursor') button.disabled = !canDraw;
  });
  if (!canDraw && state.tool !== 'cursor') setTool('cursor');
  $('#btn-clear-draw').disabled = !canDraw;
  updateUndoButton();

  const canClear = hasPerm('clear');
  $('#btn-clear-all').disabled = !canClear;
  const canFx = hasPerm('fx');
  $$('[data-fx]').forEach((button) => {
    button.disabled = !canFx;
  });
  $('#fx-clear-draw').disabled = !canDraw;
  $('#fx-clear-all').disabled = !canClear;
  $('#feed-clear').hidden = !state.isAdmin;
}

/* ================================= виджеты ================================= */

const DEFAULT_WIDGET_DATA = {
  clock: { format24: true, seconds: true, date: false },
  timer: { mode: 'countdown', duration: 300, running: false, remaining: 300, endsAt: 0, startedAt: 0, accumulated: 0, label: 'Таймер' },
  counter: { label: 'Счётчик', value: 0, step: 1 },
  progress: { label: 'Прогресс', value: 0, max: 100 },
  goal: { label: 'Цель сбора', current: 0, target: 1000, currency: '₽' },
  random: { title: 'Случайный выбор', items: [], result: '', pickedAt: 0 },
  leaderboard: { title: 'Таблица лидеров', entries: [] },
};

function defaultWidgetData(type) {
  return JSON.parse(JSON.stringify(DEFAULT_WIDGET_DATA[type] || {}));
}

function widgetTitle(item) {
  const d = item.data || {};
  return d.label || d.title || WIDGET_META[item.type]?.label || 'Виджет';
}

function renderWidgetPicker() {
  const picker = $('#widget-picker');
  picker.replaceChildren();
  for (const type of WIDGET_TYPES) {
    const meta = WIDGET_META[type];
    const button = document.createElement('button');
    button.className = 'widget-pick';
    button.dataset.type = type;
    button.innerHTML = `<span class="wp-icon">${meta.icon}</span><span class="wp-label">${esc(meta.label)}</span>`;
    picker.append(button);
  }
}

$('#widget-picker').addEventListener('click', (event) => {
  const button = event.target.closest('.widget-pick');
  if (button) addWidget(button.dataset.type);
});

function addWidget(type) {
  if (!hasPerm('widgets')) {
    toast('Нет прав на управление виджетами');
    return;
  }
  const meta = WIDGET_META[type] || WIDGET_META.clock;
  const id = `w_${uid()}`;
  const item = {
    id,
    type,
    x: clamp(0.5 - meta.w / 2, 0, 1),
    y: 0.08,
    w: meta.w,
    h: meta.h,
    opacity: 1,
    hidden: false,
    color: '#7c6eff',
    bg: 'rgba(12,15,22,0.82)',
    data: defaultWidgetData(type),
  };
  scene.upsertWidget(item);
  send({ t: 'widget.add', item });
  setTab('widgets');
  selectItem({ kind: 'widget', id });
  scheduleLists();
}

function renderWidgetList() {
  const list = $('#widget-list');
  const items = scene.state.widgets;
  $('#widget-count').textContent = String(items.length);
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Виджетов на экране нет';
    list.append(empty);
    return;
  }
  for (const item of [...items].reverse()) {
    const meta = WIDGET_META[item.type] || { icon: '🧩', label: 'Виджет' };
    const row = document.createElement('div');
    row.className = 'item-row';
    row.dataset.id = item.id;
    if (state.selected?.kind === 'widget' && state.selected.id === item.id) row.classList.add('selected');
    row.innerHTML = `
      <div class="thumb">${meta.icon}</div>
      <div class="row-main">
        <div class="row-name" title="${esc(widgetTitle(item))}">${esc(widgetTitle(item))}</div>
        <div class="row-sub">${esc(meta.label)}</div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-act="edit" title="Настроить">✎</button>
        <button class="icon-btn" data-act="hide" title="${item.hidden ? 'Показать' : 'Скрыть'}">${item.hidden ? '◌' : '◉'}</button>
        <button class="icon-btn danger" data-act="remove" title="Удалить">✕</button>
      </div>`;
    list.append(row);
  }
}

$('#widget-list').addEventListener('click', (event) => {
  const row = event.target.closest('.item-row');
  if (!row) return;
  const id = row.dataset.id;
  const item = scene.getItem('widget', id);
  if (!item) return;
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (action === 'remove') {
    send({ t: 'widget.remove', id });
    if (state.editingWidgetId === id) closeWidgetEditor();
    return;
  }
  if (action === 'hide') {
    send({ t: 'widget.update', id, patch: { hidden: !item.hidden } });
    return;
  }
  setTab('widgets');
  selectItem({ kind: 'widget', id });
});

function updateWidgetData(id, patchData) {
  const item = scene.getItem('widget', id);
  if (!item) return;
  const data = { ...item.data, ...patchData };
  scene.updateItemLocal('widget', id, { data });
  send({ t: 'widget.update', id, patch: { data } });
}

function updateWidgetStyle(id, patch) {
  scene.updateItemLocal('widget', id, patch);
  send({ t: 'widget.update', id, patch });
}

function controlWidget(id, op, extra = {}) {
  send({ t: 'widget.control', id, op, ...extra });
}

function openWidgetEditor(item) {
  state.editingWidgetId = item.id;
  $('#widget-editor-block').hidden = false;
  $('#widget-editor-type').textContent = WIDGET_META[item.type]?.label || 'виджет';
  renderWidgetEditor(item);
}

function closeWidgetEditor() {
  state.editingWidgetId = null;
  $('#widget-editor-block').hidden = true;
  $('#widget-editor').replaceChildren();
}

function lbRowsHtml(entries, color) {
  if (!entries.length) return '<p class="empty">Пока пусто — добавьте первого участника</p>';
  return entries
    .map((e, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
      return `<div class="lb-row">
        <span class="lb-rank">${medal}</span>
        <span class="lb-name">${esc(e.name)}</span>
        <b class="lb-score" style="color:${esc(color)}">${esc(String(e.score))}</b>
        <button class="icon-btn" data-lb-act="bump" data-name="${esc(e.name)}" title="+1 очко">＋</button>
        <button class="icon-btn danger" data-lb-act="remove" data-name="${esc(e.name)}" title="Убрать">✕</button>
      </div>`;
    })
    .join('');
}

function renderWidgetEditor(item) {
  const editor = $('#widget-editor');
  const d = item.data || {};
  const id = item.id;
  const style = `
    <div class="we-style">
      <label class="field"><span>Акцент</span><input type="color" data-style="color" value="${esc(item.color || '#7c6eff')}" /></label>
      <label class="field grow"><span>Прозрачность</span><input type="range" data-style="opacity" min="10" max="100" value="${Math.round((item.opacity ?? 1) * 100)}" /></label>
    </div>`;
  let body = '';

  switch (item.type) {
    case 'clock':
      body = `
        <label class="check"><input type="checkbox" data-cfg="format24" ${d.format24 !== false ? 'checked' : ''} /> 24-часовой формат</label>
        <label class="check"><input type="checkbox" data-cfg="seconds" ${d.seconds ? 'checked' : ''} /> показывать секунды</label>
        <label class="check"><input type="checkbox" data-cfg="date" ${d.date ? 'checked' : ''} /> показывать дату</label>`;
      break;
    case 'timer':
      body = `
        <div class="we-live"><span class="we-big" data-live="timer-time">${esc(fmtDuration(timerRemaining(d)))}</span><span class="we-run" data-live="timer-run">${d.running ? '● идёт' : '○ пауза'}</span></div>
        <label class="field"><span>Подпись</span><input data-cfg="label" maxlength="40" value="${esc(d.label || '')}" /></label>
        <label class="field"><span>Режим</span><select data-cfg="mode"><option value="countdown">обратный отсчёт</option><option value="stopwatch">секундомер</option></select></label>
        <label class="field"><span>Длительность, сек</span><input type="number" data-cfg="duration" min="1" max="86400" value="${Number(d.duration) || 300}" /></label>
        <div class="row"><button class="btn primary grow" data-act="toggle">${d.running ? 'Пауза' : 'Старт'}</button><button class="btn ghost" data-act="reset">Сброс</button></div>`;
      break;
    case 'counter':
      body = `
        <div class="we-live"><span class="we-big" data-live="counter-value" style="color:${esc(item.color || '#7c6eff')}">${esc(String(d.value ?? 0))}</span></div>
        <label class="field"><span>Подпись</span><input data-cfg="label" maxlength="40" value="${esc(d.label || '')}" /></label>
        <label class="field"><span>Шаг</span><input type="number" data-cfg="step" min="1" max="1000" value="${Number(d.step) || 1}" /></label>
        <div class="row"><button class="btn secondary" data-act="dec">−</button><button class="btn primary grow" data-act="inc">＋</button><button class="btn ghost" data-act="reset">Сброс</button></div>
        <div class="row"><input type="number" data-role="set-value" placeholder="точное значение" /><button class="btn ghost" data-act="set">Задать</button></div>`;
      break;
    case 'progress': {
      const max = Number(d.max) || 100;
      const value = Number(d.value) || 0;
      body = `
        <label class="field"><span>Подпись</span><input data-cfg="label" maxlength="40" value="${esc(d.label || '')}" /></label>
        <label class="field"><span>Максимум</span><input type="number" data-cfg="max" min="1" max="1000000" value="${max}" /></label>
        <div class="row between"><span class="muted">Значение</span><output data-live="progress-out">${value} / ${max}</output></div>
        <input type="range" data-role="value" min="0" max="${max}" value="${value}" />
        <div class="row"><button class="btn ghost" data-act="zero">Сброс</button><button class="btn ghost" data-act="add10">+10%</button><button class="btn ghost" data-act="fill">Заполнить</button></div>`;
      break;
    }
    case 'goal': {
      const target = Number(d.target) || 1000;
      const current = Number(d.current) || 0;
      body = `
        <label class="field"><span>Подпись</span><input data-cfg="label" maxlength="40" value="${esc(d.label || '')}" /></label>
        <div class="row"><label class="field grow"><span>Цель</span><input type="number" data-cfg="target" min="1" value="${target}" /></label><label class="field" style="width:90px;flex:none"><span>Валюта</span><input data-cfg="currency" maxlength="6" value="${esc(d.currency || '₽')}" /></label></div>
        <div class="row between"><span class="muted">Собрано</span><output data-live="goal-out">${current} / ${target}</output></div>
        <input type="range" data-role="value" min="0" max="${target}" value="${current}" />
        <div class="row"><input type="number" data-role="add-amount" placeholder="сумма" /><button class="btn primary" data-act="add">Добавить</button><button class="btn ghost" data-act="zero">Сброс</button></div>`;
      break;
    }
    case 'random':
      body = `
        <label class="field"><span>Заголовок</span><input data-cfg="title" maxlength="40" value="${esc(d.title || '')}" /></label>
        <label class="field"><span>Варианты — по одному на строку</span><textarea data-cfg="items" rows="5">${esc((Array.isArray(d.items) ? d.items : []).join('\n'))}</textarea></label>
        <div class="we-live"><span class="we-big" data-live="random-result">${d.result ? esc(d.result) : '—'}</span></div>
        <button class="btn primary full" data-act="pick">🎲 Выбрать случайный</button>`;
      break;
    case 'leaderboard':
      body = `
        <label class="field"><span>Заголовок</span><input data-cfg="title" maxlength="40" value="${esc(d.title || '')}" /></label>
        <div class="row"><input class="grow" data-role="lb-name" placeholder="имя" maxlength="40" /><input type="number" data-role="lb-score" placeholder="очки" style="width:90px;flex:none" /><button class="btn primary" data-act="upsert" title="Добавить / обновить">＋</button></div>
        <div class="we-lb" data-live="lb-rows">${lbRowsHtml(Array.isArray(d.entries) ? d.entries : [], item.color || '#7c6eff')}</div>
        <button class="btn ghost full" data-act="clear">Очистить таблицу</button>`;
      break;
  }

  editor.innerHTML = style + body;
  bindWidgetEditor(editor, item);
}

function bindWidgetEditor(editor, item) {
  const id = item.id;
  const type = item.type;

  const color = $('[data-style="color"]', editor);
  color?.addEventListener('change', () => updateWidgetStyle(id, { color: color.value }));
  const opacity = $('[data-style="opacity"]', editor);
  opacity?.addEventListener('input', () => scene.updateItemLocal('widget', id, { opacity: Number(opacity.value) / 100 }));
  opacity?.addEventListener('change', () => updateWidgetStyle(id, { opacity: Number(opacity.value) / 100 }));

  const cfg = (key) => $(`[data-cfg="${key}"]`, editor);
  const onCfg = (key, handler) => cfg(key)?.addEventListener('change', handler);

  if (type === 'clock') {
    const commit = () => updateWidgetData(id, { format24: cfg('format24').checked, seconds: cfg('seconds').checked, date: cfg('date').checked });
    ['format24', 'seconds', 'date'].forEach((key) => onCfg(key, commit));
    return;
  }

  if (type === 'timer') {
    cfg('mode').value = item.data.mode === 'stopwatch' ? 'stopwatch' : 'countdown';
    onCfg('label', () => updateWidgetData(id, { label: cfg('label').value }));
    onCfg('mode', () => {
      const duration = Number(cfg('duration').value) || 300;
      updateWidgetData(id, { mode: cfg('mode').value, running: false, remaining: duration, endsAt: 0, startedAt: 0, accumulated: 0 });
    });
    onCfg('duration', () => {
      const duration = clamp(Number(cfg('duration').value) || 300, 1, 86400);
      updateWidgetData(id, { duration, remaining: duration, running: false, endsAt: 0, startedAt: 0, accumulated: 0 });
    });
    $('[data-act="toggle"]', editor)?.addEventListener('click', () => {
      const current = scene.getItem('widget', id);
      controlWidget(id, current?.data?.running ? 'pause' : 'start');
    });
    $('[data-act="reset"]', editor)?.addEventListener('click', () => controlWidget(id, 'reset'));
    return;
  }

  if (type === 'counter') {
    onCfg('label', () => updateWidgetData(id, { label: cfg('label').value }));
    onCfg('step', () => updateWidgetData(id, { step: clamp(Number(cfg('step').value) || 1, 1, 1000) }));
    $('[data-act="inc"]', editor)?.addEventListener('click', () => controlWidget(id, 'inc'));
    $('[data-act="dec"]', editor)?.addEventListener('click', () => controlWidget(id, 'dec'));
    $('[data-act="reset"]', editor)?.addEventListener('click', () => controlWidget(id, 'reset'));
    $('[data-act="set"]', editor)?.addEventListener('click', () => {
      const input = $('[data-role="set-value"]', editor);
      controlWidget(id, 'set', { value: Number(input.value) || 0 });
    });
    return;
  }

  if (type === 'progress' || type === 'goal') {
    const isGoal = type === 'goal';
    onCfg('label', () => updateWidgetData(id, { label: cfg('label').value }));
    if (isGoal) {
      onCfg('target', () => updateWidgetData(id, { target: clamp(Number(cfg('target').value) || 1000, 1, 1000000000) }));
      onCfg('currency', () => updateWidgetData(id, { currency: cfg('currency').value }));
    } else {
      onCfg('max', () => updateWidgetData(id, { max: clamp(Number(cfg('max').value) || 100, 1, 1000000) }));
    }
    const range = $('[data-role="value"]', editor);
    const out = $(isGoal ? '[data-live="goal-out"]' : '[data-live="progress-out"]', editor);
    const limit = () => {
      const data = scene.getItem('widget', id)?.data || {};
      return isGoal ? Number(data.target) || 1000 : Number(data.max) || 100;
    };
    range?.addEventListener('input', () => {
      const value = Number(range.value);
      if (out) out.textContent = `${value} / ${limit()}`;
      scene.updateItemLocal('widget', id, { data: { ...scene.getItem('widget', id).data, [isGoal ? 'current' : 'value']: value } });
    });
    range?.addEventListener('change', () => controlWidget(id, 'set', { value: Number(range.value) }));
    $('[data-act="zero"]', editor)?.addEventListener('click', () => controlWidget(id, 'set', { value: 0 }));
    if (isGoal) {
      $('[data-act="add"]', editor)?.addEventListener('click', () => {
        const amount = Number($('[data-role="add-amount"]', editor).value) || 0;
        controlWidget(id, 'add', { amount });
      });
    } else {
      $('[data-act="add10"]', editor)?.addEventListener('click', () => controlWidget(id, 'add', { amount: Math.round(limit() * 0.1) }));
      $('[data-act="fill"]', editor)?.addEventListener('click', () => controlWidget(id, 'set', { value: limit() }));
    }
    return;
  }

  if (type === 'random') {
    onCfg('title', () => updateWidgetData(id, { title: cfg('title').value }));
    onCfg('items', () => {
      const items = cfg('items').value.split('\n').map((s) => s.trim().slice(0, 60)).filter(Boolean).slice(0, 60);
      updateWidgetData(id, { items });
    });
    $('[data-act="pick"]', editor)?.addEventListener('click', () => {
      const data = scene.getItem('widget', id)?.data || {};
      if (!Array.isArray(data.items) || !data.items.length) {
        toast('Добавьте хотя бы один вариант');
        return;
      }
      controlWidget(id, 'pick');
    });
    return;
  }

  if (type === 'leaderboard') {
    onCfg('title', () => updateWidgetData(id, { title: cfg('title').value }));
    $('[data-act="upsert"]', editor)?.addEventListener('click', () => {
      const name = $('[data-role="lb-name"]', editor).value.trim();
      const score = Number($('[data-role="lb-score"]', editor).value) || 0;
      if (!name) {
        toast('Введите имя участника');
        return;
      }
      controlWidget(id, 'upsert', { name, score });
      $('[data-role="lb-name"]', editor).value = '';
      $('[data-role="lb-score"]', editor).value = '';
    });
    $('[data-act="clear"]', editor)?.addEventListener('click', () => {
      if (confirm('Очистить таблицу лидеров?')) controlWidget(id, 'clear');
    });
  }
}

$('#widget-editor').addEventListener('click', (event) => {
  const button = event.target.closest('[data-lb-act]');
  if (!button) return;
  const id = state.editingWidgetId;
  if (!id) return;
  const name = button.dataset.name;
  if (button.dataset.lbAct === 'bump') controlWidget(id, 'bump', { name, score: 1 });
  else if (button.dataset.lbAct === 'remove') controlWidget(id, 'remove', { name });
});

/** Лёгкое обновление живых значений редактора без пересборки полей. */
function syncWidgetEditor(item) {
  if (state.editingWidgetId !== item.id) return;
  const editor = $('#widget-editor');
  const d = item.data || {};
  const setLive = (name, text) => {
    const node = $(`[data-live="${name}"]`, editor);
    if (node) node.textContent = text;
  };

  if (item.type === 'timer') {
    setLive('timer-time', fmtDuration(timerRemaining(d)));
    setLive('timer-run', d.running ? '● идёт' : '○ пауза');
    const toggle = $('[data-act="toggle"]', editor);
    if (toggle) toggle.textContent = d.running ? 'Пауза' : 'Старт';
  } else if (item.type === 'counter') {
    setLive('counter-value', String(d.value ?? 0));
    const node = $('[data-live="counter-value"]', editor);
    if (node) node.style.color = item.color || '#7c6eff';
  } else if (item.type === 'progress') {
    const max = Number(d.max) || 100;
    const value = Number(d.value) || 0;
    setLive('progress-out', `${value} / ${max}`);
    const range = $('[data-role="value"]', editor);
    if (range && document.activeElement !== range) {
      range.max = String(max);
      range.value = String(value);
    }
  } else if (item.type === 'goal') {
    const target = Number(d.target) || 1000;
    const current = Number(d.current) || 0;
    setLive('goal-out', `${current} / ${target}`);
    const range = $('[data-role="value"]', editor);
    if (range && document.activeElement !== range) {
      range.max = String(target);
      range.value = String(current);
    }
  } else if (item.type === 'random') {
    setLive('random-result', d.result || '—');
  } else if (item.type === 'leaderboard') {
    const node = $('[data-live="lb-rows"]', editor);
    if (node) node.innerHTML = lbRowsHtml(Array.isArray(d.entries) ? d.entries : [], item.color || '#7c6eff');
  }

  for (const el of $$('[data-cfg]', editor)) {
    if (document.activeElement === el) continue;
    const key = el.dataset.cfg;
    if (!(key in d)) continue;
    if (key === 'items') {
      el.value = (Array.isArray(d.items) ? d.items : []).join('\n');
    } else if (el.type === 'checkbox') {
      el.checked = Boolean(d[key]);
    } else {
      el.value = String(d[key] ?? '');
    }
  }
  const color = $('[data-style="color"]', editor);
  if (color && document.activeElement !== color) color.value = item.color || '#7c6eff';
}

/* ================================ уведомления ================================ */

const NOTIFY_TEMPLATES = {
  default: { label: 'Обычное', accent: '#7c6eff', icon: '🔔' },
  success: { label: 'Успех', accent: '#3ddc97', icon: '✅' },
  warning: { label: 'Внимание', accent: '#ffcc00', icon: '⚠️' },
  error: { label: 'Ошибка', accent: '#ff5c5c', icon: '⛔' },
  info: { label: 'Инфо', accent: '#2fb6ff', icon: 'ℹ️' },
  donation: { label: 'Донат', accent: '#ffb020', icon: '💰' },
  follower: { label: 'Фолловер', accent: '#ff5cae', icon: '❤️' },
  sub: { label: 'Подписка', accent: '#bf5af2', icon: '⭐' },
};

const NOTIFY_POSITIONS = [
  ['top-left', 'Сверху слева'],
  ['top-center', 'Сверху по центру'],
  ['top-right', 'Сверху справа'],
  ['bottom-left', 'Снизу слева'],
  ['bottom-center', 'Снизу по центру'],
  ['bottom-right', 'Снизу справа'],
];

const NOTIFY_ANIMATIONS = [
  ['slide', 'Слайд'],
  ['fade', 'Появление'],
  ['pop', 'Поп'],
  ['bounce', 'Прыжок'],
];

function fillSelect(select, pairs, value) {
  select.replaceChildren();
  for (const [val, label] of pairs) {
    const option = document.createElement('option');
    option.value = val;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
}

function initNotifyForm() {
  fillSelect($('#notify-template'), Object.entries(NOTIFY_TEMPLATES).map(([id, t]) => [id, t.label]), 'default');
  fillSelect($('#notify-position'), NOTIFY_POSITIONS, 'top-right');
  fillSelect($('#notify-animation'), NOTIFY_ANIMATIONS, 'slide');
  $('#notify-duration-label').textContent = `${$('#notify-duration').value} с`;

  $('#notify-template').addEventListener('change', (event) => {
    const template = NOTIFY_TEMPLATES[event.target.value] || NOTIFY_TEMPLATES.default;
    $('#notify-accent').value = template.accent;
    $('#notify-icon').value = template.icon;
    renderNotifyPreview();
  });
  for (const sel of ['#notify-title', '#notify-message', '#notify-position', '#notify-animation', '#notify-accent', '#notify-icon']) {
    $(sel).addEventListener('input', renderNotifyPreview);
    $(sel).addEventListener('change', renderNotifyPreview);
  }
  $('#notify-duration').addEventListener('input', (event) => {
    $('#notify-duration-label').textContent = `${event.target.value} с`;
    renderNotifyPreview();
  });
  $('#notify-preview-btn').addEventListener('click', renderNotifyPreview);
  $('#notify-send').addEventListener('click', sendNotify);
  renderNotifyPreview();
}

function buildNotifyItem() {
  const accent = $('#notify-accent').value;
  return {
    id: `n_${uid()}`,
    title: $('#notify-title').value.trim().slice(0, 80),
    message: $('#notify-message').value.trim().slice(0, 200),
    template: $('#notify-template').value,
    position: $('#notify-position').value,
    animation: $('#notify-animation').value,
    duration: clamp(Number($('#notify-duration').value) * 1000, 1000, 20000),
    accent: HEX_RE.test(accent) ? accent : '#7c6eff',
    icon: $('#notify-icon').value.slice(0, 8),
  };
}

function sendNotify() {
  if (!hasPerm('notify')) {
    toast('Нет прав на отправку уведомлений');
    return;
  }
  const item = buildNotifyItem();
  if (!item.title && !item.message) {
    toast('Введите заголовок или текст');
    return;
  }
  if (send({ t: 'notify', item })) toast('Уведомление отправлено в эфир');
}

function renderNotifyPreview() {
  const stage = $('#notify-preview');
  const item = buildNotifyItem();
  const template = NOTIFY_TEMPLATES[item.template] || NOTIFY_TEMPLATES.default;
  const icon = item.icon || template.icon;
  stage.dataset.pos = item.position;
  stage.replaceChildren();
  const card = document.createElement('div');
  card.className = `np-card np-anim-${item.animation}`;
  card.style.setProperty('--naccent', item.accent);
  card.innerHTML = `
    <div class="np-icon">${esc(icon)}</div>
    <div class="np-content">
      <div class="np-title">${esc(item.title || 'Заголовок уведомления')}</div>
      <div class="np-message">${esc(item.message || 'Так будет выглядеть текст уведомления в эфире.')}</div>
    </div>`;
  stage.append(card);
}

/* ================================ лента событий ================================ */

const FEED_FILTERS = [
  ['all', 'Все'],
  ['draw', 'Рисование'],
  ['media', 'Медиа'],
  ['text', 'Текст'],
  ['tts', 'TTS'],
  ['sound', 'Звуки'],
  ['fx', 'Эффекты'],
  ['widgets', 'Виджеты'],
  ['notify', 'Уведомления'],
  ['clear', 'Очистка'],
];

const FEED_ICONS = {
  draw: '✏️',
  media: '🖼️',
  text: '💬',
  tts: '🔊',
  sound: '🎵',
  fx: '✨',
  widgets: '🧩',
  notify: '🔔',
  clear: '🧹',
};

async function loadEvents() {
  try {
    const data = await api('/api/events?limit=200');
    state.feed = Array.isArray(data.events) ? data.events.reverse() : [];
  } catch {
    state.feed = [];
  }
  renderFeed();
}

function renderFeedFilters() {
  const box = $('#feed-filters');
  box.replaceChildren();
  for (const [id, label] of FEED_FILTERS) {
    const chip = document.createElement('button');
    chip.className = `cat-chip${state.feedFilter === id ? ' active' : ''}`;
    chip.dataset.filter = id;
    chip.textContent = label;
    box.append(chip);
  }
  $('#feed-clear').hidden = !state.isAdmin;
}

$('#feed-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('.cat-chip');
  if (!chip) return;
  state.feedFilter = chip.dataset.filter;
  renderFeedFilters();
  renderFeed();
});

$('#feed-search').addEventListener('input', (event) => {
  state.feedSearch = event.target.value;
  renderFeed();
});

$('#feed-clear').addEventListener('click', async () => {
  if (!confirm('Очистить ленту событий для всех модераторов?')) return;
  try {
    await api('/api/events', { method: 'DELETE' });
    state.feed = [];
    renderFeed();
    toast('Лента очищена');
  } catch {
    toast('Не удалось очистить ленту');
  }
});

function addFeedEntry(entry) {
  if (!entry || !entry.id) return;
  if (state.feed.some((e) => e.id === entry.id)) return;
  state.feed.unshift(entry);
  if (state.feed.length > 400) state.feed.length = 400;
  renderFeed();
}

function feedTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function renderFeed() {
  const list = $('#feed-list');
  const query = state.feedSearch.trim().toLowerCase();
  const items = state.feed.filter((e) => {
    if (state.feedFilter !== 'all' && e.action !== state.feedFilter) return false;
    if (query && !`${e.login} ${e.detail}`.toLowerCase().includes(query)) return false;
    return true;
  });
  $('#feed-count').textContent = `${items.length} ${pluralEvents(items.length)}`;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.feed.length ? 'Нет событий по фильтру' : 'События появятся, когда модераторы начнут действовать';
    list.append(empty);
    return;
  }
  for (const entry of items) {
    const row = document.createElement('div');
    row.className = `feed-entry act-${esc(entry.action)}`;
    row.innerHTML = `
      <span class="feed-icon">${FEED_ICONS[entry.action] || '•'}</span>
      <div class="feed-main">
        <div class="feed-line"><b class="feed-login">${esc(entry.login || 'server')}</b><span class="feed-time">${feedTime(entry.ts)}</span></div>
        <div class="feed-detail">${esc(entry.detail || '')}</div>
      </div>`;
    list.append(row);
  }
}

function pluralEvents(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'событий';
  if (b === 1) return 'событие';
  if (b > 1 && b < 5) return 'события';
  return 'событий';
}

/* ================================= вкладки ================================= */

function setTab(name) {
  const button = $(`#tabs button[data-tab="${name}"]`);
  if (button && button.hidden) return;
  $$('#tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
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

  if (event.key === 'Escape') {
    if (!profileModal.hidden) {
      event.preventDefault();
      closeProfile();
      return;
    }
    if (!soundModal.hidden) {
      event.preventDefault();
      closeSoundModal();
      return;
    }
    if (!permsModal.hidden) {
      event.preventDefault();
      closePermsModal();
      return;
    }
  }

  if (event.ctrlKey && event.key.toLowerCase() === 'z' && !typing) {
    event.preventDefault();
    if (hasPerm('draw')) send({ t: 'stroke.undo' });
    return;
  }
  if (!profileModal.hidden || !modal.hidden || !soundModal.hidden || !permsModal.hidden) return;
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

  if (!event.ctrlKey && !event.metaKey && !event.altKey && hasPerm('sound')) {
    const key = event.key.toLowerCase();
    if (HOTKEY_RE.test(key)) {
      const sound = state.sounds.find((s) => s.hotkey === key);
      if (sound) {
        event.preventDefault();
        playSound(sound);
        return;
      }
    }
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
  $('#sound-queue').checked = state.soundQueueMode;

  boundRange('#tts-rate', '#tts-rate-label', (value) => `${Number(value) > 0 ? '+' : ''}${value}%`);
  boundRange('#tts-pitch', '#tts-pitch-label', (value) => (Number(value) > 0 ? `+${value}` : String(value)));
  boundRange('#tts-volume', '#tts-volume-label', (value) => `${value}%`);
  $('#text-size-label').textContent = $('#text-size').value;

  renderRecent();
  renderWidgetPicker();
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
