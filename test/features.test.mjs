import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RoomStore, normNotification, WIDGET_TYPES } from '../dist/state.js';
import { SoundStore, cleanHotkey } from '../dist/sounds.js';
import { EventLog } from '../dist/events.js';
import { PERMS, ALL_PERMS, normalizePerms, resolvePerms, hasPerm, permForEvent } from '../dist/perms.js';
import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  makeTempDir,
  openWs,
  removeDir,
  startTestServer,
  wsUrl,
} from './helpers.mjs';

/* ============================ права (unit) ============================ */

test('права: нормализация и эффективные права', () => {
  assert.deepEqual(normalizePerms(['text', 'draw', 'bogus', 'text']), ['text', 'draw']);
  assert.deepEqual(normalizePerms([]), []);
  assert.equal(normalizePerms('nope'), undefined);
  assert.equal(normalizePerms(null), undefined);

  assert.deepEqual(resolvePerms({ role: 'admin' }), ALL_PERMS);
  assert.deepEqual(resolvePerms({ role: 'mod' }), ALL_PERMS, 'legacy без поля — полный доступ');
  assert.deepEqual(resolvePerms({ role: 'mod', perms: ['text'] }), ['text']);

  assert.equal(hasPerm({ role: 'admin' }, 'clear'), true);
  assert.equal(hasPerm({ role: 'mod', perms: ['text'] }, 'text'), true);
  assert.equal(hasPerm({ role: 'mod', perms: ['text'] }, 'draw'), false);
  assert.equal(PERMS.length, 9);
});

test('права: какое право нужно для события', () => {
  assert.equal(permForEvent('stroke.start'), 'draw');
  assert.equal(permForEvent('draw.clear'), 'draw');
  assert.equal(permForEvent('media.add'), 'media');
  assert.equal(permForEvent('text.add'), 'text');
  assert.equal(permForEvent('widget.add'), 'widgets');
  assert.equal(permForEvent('widget.control'), 'widgets');
  assert.equal(permForEvent('sound'), 'sound');
  assert.equal(permForEvent('sound.stop'), 'sound');
  assert.equal(permForEvent('sound.clearQueue'), 'sound');
  assert.equal(permForEvent('fx'), 'fx');
  assert.equal(permForEvent('tts.fallback'), 'tts');
  assert.equal(permForEvent('notify'), 'notify');
  assert.equal(permForEvent('scene.clear'), 'clear');
  assert.equal(permForEvent('ping'), null);
});

/* ========================= soundboard (unit) ========================== */

function soundStore(t) {
  const dir = makeTempDir('mod-overlay-sounds-');
  t.after(() => removeDir(dir));
  return { dir, sounds: new SoundStore(dir) };
}

test('звуки: горячие клавиши нормализуются', () => {
  assert.equal(cleanHotkey('Q'), 'q');
  assert.equal(cleanHotkey(' F5 '), 'f5');
  assert.equal(cleanHotkey('f12'), 'f12');
  assert.equal(cleanHotkey('f13'), '');
  assert.equal(cleanHotkey('shift'), '');
  assert.equal(cleanHotkey(5), '');
});

test('звуки: добавление, идемпотентность и конфликт хоткеев', (t) => {
  const { sounds } = soundStore(t);
  const a = sounds.add({ url: '/media/uploads/a.mp3', name: 'Аплодисменты', category: 'Реакции', hotkey: 'q' });
  assert.equal(a.created, true);
  assert.equal(a.sound.order, 0);
  assert.equal(a.sound.category, 'Реакции');

  const dup = sounds.add({ url: '/media/uploads/a.mp3', name: 'Другое имя' });
  assert.equal(dup.created, false, 'повторный url не создаёт дубликат');
  assert.equal(dup.sound.id, a.sound.id);

  assert.throws(() => sounds.add({ url: 'javascript:alert(1)' }), /bad_url/);
  assert.throws(() => sounds.add({ url: '' }), /bad_url/);

  const b = sounds.add({ url: 'https://example.com/b.mp3', hotkey: 'q' });
  assert.equal(b.created, true);
  assert.equal(sounds.get(a.sound.id).hotkey, '', 'хоткей освобождён у старого звука');
  assert.equal(sounds.get(b.sound.id).hotkey, 'q');
});

test('звуки: обновление, удаление, перестановка и сохранение', (t) => {
  const { dir, sounds } = soundStore(t);
  const a = sounds.add({ url: '/media/uploads/a.mp3', name: 'A' }).sound;
  const b = sounds.add({ url: '/media/uploads/b.mp3', name: 'B' }).sound;

  const updated = sounds.update(a.id, { name: 'A2', category: 'Мемы', favorite: true, hotkey: 'z' });
  assert.equal(updated.name, 'A2');
  assert.equal(updated.favorite, true);
  assert.equal(updated.hotkey, 'z');
  assert.equal(sounds.update('nope', { name: 'x' }), null);

  const reordered = sounds.reorder([b.id, a.id]);
  assert.deepEqual(reordered.map((s) => s.id), [b.id, a.id]);
  assert.deepEqual(sounds.reorder('nope').map((s) => s.id), [b.id, a.id], 'мусор не меняет порядок');

  assert.equal(sounds.remove(a.id), true);
  assert.equal(sounds.remove(a.id), false);

  sounds.flush();
  assert.ok(fs.existsSync(path.join(dir, 'sounds.json')));
  const loaded = new SoundStore(dir);
  assert.deepEqual(loaded.list().map((s) => s.id), [b.id]);
});

/* ========================= лента событий (unit) ======================= */

test('лента: запись, порядок, лимит и очистка', () => {
  const log = new EventLog();
  const seen = [];
  log.onRecord = (roomId, entry) => seen.push({ roomId, entry });

  const first = log.record('main', { by: 'u1', login: 'admin', action: 'text', detail: 'текст' });
  assert.equal(first.action, 'text');
  assert.equal(typeof first.id, 'string');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].roomId, 'main');

  log.record('main', { by: 'u1', login: 'admin', action: 'sound', detail: 'звук' });
  log.record('other', { by: 'u2', login: 'mod', action: 'draw', detail: 'рисует' });
  const list = log.list('main');
  assert.deepEqual(list.map((e) => e.action), ['text', 'sound'], 'от старых к новым, только своя комната');
  assert.equal(log.list('main', 1).length, 1);

  const long = log.record('main', { by: 'u1', login: 'admin', action: 'fx', detail: 'я'.repeat(300) });
  assert.equal(long.detail.length, 160, 'detail обрезается');

  log.clear('main');
  assert.deepEqual(log.list('main'), []);
  assert.equal(log.list('other').length, 1, 'чужая комната не затронута');
});

test('лента: кольцевой буфер на 400 записей', () => {
  const log = new EventLog();
  for (let i = 0; i < 405; i += 1) {
    log.record('main', { by: 'u1', login: 'admin', action: 'text', detail: `t${i}` });
  }
  const list = log.list('main', 1000);
  assert.equal(list.length, 400);
  assert.equal(list[0].detail, 't5', 'самые старые вытеснены');
  assert.equal(list.at(-1).detail, 't404');
});

/* ======================== уведомления (unit) ========================== */

test('уведомления: нормализация и отсечение мусора', () => {
  assert.equal(normNotification(null), null);
  assert.equal(normNotification({}), null);
  assert.equal(normNotification({ title: '   ' }), null);

  const n = normNotification({
    title: 'Донат',
    message: '100 ₽',
    template: 'donation',
    position: 'bottom-right',
    animation: 'pop',
    duration: 99_999,
    accent: '#3ddc97',
    icon: '💸',
  });
  assert.equal(n.template, 'donation');
  assert.equal(n.position, 'bottom-right');
  assert.equal(n.animation, 'pop');
  assert.equal(n.duration, 20_000);
  assert.equal(n.accent, '#3ddc97');
  assert.equal(n.icon, '💸');

  const bad = normNotification({ title: 'Hi', template: 'bogus', position: 'bogus', animation: 'bogus', duration: 10, accent: 'red' });
  assert.equal(bad.template, 'default');
  assert.equal(bad.position, 'top-right');
  assert.equal(bad.animation, 'slide');
  assert.equal(bad.duration, 1000);
  assert.equal(bad.accent, '#7c6eff');
});

/* =========================== виджеты (unit) =========================== */

function roomStore(t) {
  const dir = makeTempDir('mod-overlay-widgets-');
  t.after(() => removeDir(dir));
  return { dir, rooms: new RoomStore(dir) };
}

const addWidget = (rooms, type, over = {}) =>
  rooms.apply('main', { t: 'widget.add', item: { id: 'w1', type, ...over } }, 'u1');

test('виджеты: все типы добавляются с данными по умолчанию', (t) => {
  const { rooms } = roomStore(t);
  assert.equal(WIDGET_TYPES.length, 7);
  for (const type of WIDGET_TYPES) {
    const res = rooms.apply('main', { t: 'widget.add', item: { id: `w-${type}`, type } }, 'u1');
    assert.equal(res.ok, true, type);
    assert.equal(res.event.item.type, type);
    assert.ok(res.event.item.data && typeof res.event.item.data === 'object');
  }
  const fallback = rooms.apply('main', { t: 'widget.add', item: { id: 'w-bad', type: 'nope' } }, 'u1');
  assert.equal(fallback.event.item.type, 'clock', 'неизвестный тип заменяется часами');
  assert.deepEqual(rooms.apply('main', { t: 'widget.add', item: null }, 'u1'), { ok: false, error: 'bad_widget' });
});

test('виджеты: счётчик inc/dec/set/reset', (t) => {
  const { rooms } = roomStore(t);
  addWidget(rooms, 'counter');
  const control = (op, extra = {}) => rooms.apply('main', { t: 'widget.control', id: 'w1', op, ...extra }, 'u1');
  assert.equal(control('inc').event.item.data.value, 1);
  assert.equal(control('inc').event.item.data.value, 2);
  assert.equal(control('dec').event.item.data.value, 1);
  assert.equal(control('set', { value: 50 }).event.item.data.value, 50);
  assert.equal(control('reset').event.item.data.value, 0);
  assert.deepEqual(control('bogus'), { ok: false, error: 'bad_control' });
});

test('виджеты: таймер start/pause/reset', (t) => {
  const { rooms } = roomStore(t);
  addWidget(rooms, 'timer', { data: { duration: 120 } });
  const control = (op) => rooms.apply('main', { t: 'widget.control', id: 'w1', op }, 'u1');
  const started = control('start').event.item.data;
  assert.equal(started.running, true);
  assert.ok(started.endsAt > Date.now());
  const paused = control('pause').event.item.data;
  assert.equal(paused.running, false);
  assert.ok(paused.remaining > 0 && paused.remaining <= 120);
  const reset = control('reset').event.item.data;
  assert.equal(reset.running, false);
  assert.equal(reset.remaining, 120);
});

test('виджеты: прогресс и цель зажимаются', (t) => {
  const { rooms } = roomStore(t);
  addWidget(rooms, 'progress');
  const pc = (op, extra = {}) => rooms.apply('main', { t: 'widget.control', id: 'w1', op, ...extra }, 'u1');
  assert.equal(pc('add', { amount: 30 }).event.item.data.value, 30);
  assert.equal(pc('set', { value: 999 }).event.item.data.value, 100, 'не выше max');
  assert.equal(pc('add', { amount: -999 }).event.item.data.value, 0, 'не ниже нуля');

  rooms.apply('main', { t: 'widget.add', item: { id: 'g1', type: 'goal' } }, 'u1');
  const gc = (op, extra = {}) => rooms.apply('main', { t: 'widget.control', id: 'g1', op, ...extra }, 'u1');
  assert.equal(gc('add', { amount: 500 }).event.item.data.current, 500);
  assert.equal(gc('set', { value: 250 }).event.item.data.current, 250);
});

test('виджеты: случайный выбор и таблица лидеров', (t) => {
  const { rooms } = roomStore(t);
  addWidget(rooms, 'random', { data: { items: ['A', 'B', 'C'] } });
  const pick = rooms.apply('main', { t: 'widget.control', id: 'w1', op: 'pick' }, 'u1');
  assert.ok(['A', 'B', 'C'].includes(pick.event.item.data.result));
  assert.ok(pick.event.item.data.pickedAt > 0);

  rooms.apply('main', { t: 'widget.add', item: { id: 'r-empty', type: 'random' } }, 'u1');
  assert.deepEqual(
    rooms.apply('main', { t: 'widget.control', id: 'r-empty', op: 'pick' }, 'u1'),
    { ok: false, error: 'bad_control' },
    'пустой список не выбирает',
  );

  rooms.apply('main', { t: 'widget.add', item: { id: 'lb', type: 'leaderboard' } }, 'u1');
  const lc = (op, extra = {}) => rooms.apply('main', { t: 'widget.control', id: 'lb', op, ...extra }, 'u1');
  lc('upsert', { name: 'Ann', score: 10 });
  lc('upsert', { name: 'Bob', score: 20 });
  let entries = lc('bump', { name: 'Ann', score: 15 }).event.item.data.entries;
  assert.deepEqual(entries.map((e) => e.name), ['Ann', 'Bob'], 'сортировка по убыванию');
  assert.equal(entries[0].score, 25);
  entries = lc('remove', { name: 'Bob' }).event.item.data.entries;
  assert.deepEqual(entries.map((e) => e.name), ['Ann']);
  assert.deepEqual(lc('clear').event.item.data.entries, []);
  assert.deepEqual(lc('upsert', { name: '  ', score: 1 }), { ok: false, error: 'bad_control' });
});

test('виджеты: update заменяет data целиком, remove и лимит', (t) => {
  const { dir, rooms } = roomStore(t);
  addWidget(rooms, 'counter', { data: { label: 'Мой счётчик', value: 7, step: 5 } });
  const updated = rooms.apply('main', { t: 'widget.update', id: 'w1', patch: { data: { value: 9 } } }, 'u1');
  assert.equal(updated.event.item.data.value, 9);
  assert.equal(updated.event.item.data.label, 'Счётчик', 'data заменяется целиком, не сливается');
  assert.equal(updated.event.item.data.step, 1);

  assert.deepEqual(rooms.apply('main', { t: 'widget.update', id: 'nope', patch: {} }, 'u1'), { ok: false, error: 'no_widget' });
  assert.deepEqual(rooms.apply('main', { t: 'widget.control', id: 'nope', op: 'inc' }, 'u1'), { ok: false, error: 'no_widget' });
  assert.deepEqual(rooms.apply('main', { t: 'widget.remove', id: 'w1' }, 'u1').event, { t: 'widget.remove', id: 'w1' });
  assert.deepEqual(rooms.apply('main', { t: 'widget.remove', id: 'w1' }, 'u1'), { ok: false, error: 'no_widget' });

  for (let i = 0; i < 20; i += 1) {
    rooms.apply('main', { t: 'widget.add', item: { id: `lim-${i}`, type: 'clock' } }, 'u1');
  }
  const overflow = rooms.apply('main', { t: 'widget.add', item: { id: 'lim-new', type: 'clock' } }, 'u1');
  assert.equal(overflow.resync, true);
  const widgets = rooms.get('main').widgets;
  assert.equal(widgets.length, 20);
  assert.equal(widgets[0].id, 'lim-1');
  assert.equal(widgets.at(-1).id, 'lim-new');

  rooms.flush();
  const loaded = new RoomStore(dir);
  assert.equal(loaded.get('main').widgets.length, 20, 'виджеты переживают перезапуск');
});

/* ====================== интеграция: HTTP + WS ========================= */

let ts;
let counter = 0;
const nextLogin = (prefix = 'feat') => `${prefix}${++counter}`;

before(async () => {
  ts = await startTestServer({ adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });
});

after(async () => {
  if (ts) await ts.cleanup();
});

async function createUser(token, over = {}) {
  const login = over.login ?? nextLogin();
  const password = 'mod-pass-123';
  const res = await ts.request('/api/users', { method: 'POST', token, body: { login, password, role: 'mod' } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { id: res.data.user.id, login, password };
}

async function connectMod(t, login, password) {
  const auth = await ts.request('/api/login', { method: 'POST', body: { login, password } });
  assert.equal(auth.status, 200);
  const ws = await openWs(wsUrl(ts.url, `?role=mod&room=main&token=${encodeURIComponent(auth.data.token)}`));
  t.after(() => ws.close());
  await ws.waitFor((m) => m.t === 'hello');
  return { ws, token: auth.data.token, user: auth.data.user };
}

async function connectOverlay(t) {
  const boot = await ts.request('/api/bootstrap', { token: await ts.adminToken() });
  const ws = await openWs(wsUrl(ts.url, `?role=overlay&room=main&key=${encodeURIComponent(boot.data.room.overlayKey)}`));
  t.after(() => ws.close());
  await ws.waitFor((m) => m.t === 'hello');
  return ws;
}

test('HTTP: soundboard CRUD и проверка прав', async () => {
  const admin = await ts.adminToken();
  assert.deepEqual((await ts.request('/api/sounds', { token: admin })).data.sounds, []);

  const created = await ts.request('/api/sounds', {
    method: 'POST', token: admin,
    body: { url: '/media/uploads/applause.mp3', name: 'Аплодисменты', category: 'Реакции', hotkey: 'a' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.created, true);
  const id = created.data.sound.id;

  const dup = await ts.request('/api/sounds', { method: 'POST', token: admin, body: { url: '/media/uploads/applause.mp3' } });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.created, false);

  const bad = await ts.request('/api/sounds', { method: 'POST', token: admin, body: { url: 'ftp://x/y.mp3' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'bad_url');

  const patched = await ts.request(`/api/sounds/${id}`, { method: 'PATCH', token: admin, body: { favorite: true } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.sound.favorite, true);

  const mod = await createUser(admin);
  await ts.request(`/api/users/${mod.id}/perms`, { method: 'POST', token: admin, body: { perms: ['text'] } });
  const modTok = (await ts.login(mod.login, mod.password)).token;
  assert.equal((await ts.request('/api/sounds', { token: modTok })).status, 200, 'читать можно всем');
  const forbidden = await ts.request('/api/sounds', { method: 'POST', token: modTok, body: { url: 'https://x/y.mp3' } });
  assert.equal(forbidden.status, 403);
  assert.equal((await ts.request(`/api/sounds/${id}`, { method: 'DELETE', token: modTok })).status, 403);

  assert.equal((await ts.request(`/api/sounds/${id}`, { method: 'DELETE', token: admin })).status, 200);
  assert.equal((await ts.request(`/api/sounds/${id}`, { method: 'DELETE', token: admin })).status, 404);
});

test('HTTP: лента событий и очистка только админом', async (t) => {
  const admin = await ts.adminToken();
  const mod = await createUser(admin);
  const modTok = (await ts.login(mod.login, mod.password)).token;

  const { ws } = await connectMod(t, mod.login, mod.password);
  ws.send({ t: 'text.add', item: { id: 'feed-text', text: 'Привет чат', x: 0.5, y: 0.8, size: 0.05 } });
  await ws.waitFor((m) => m.t === 'text.add');

  const feed = await ts.request('/api/events?limit=200', { token: admin });
  assert.equal(feed.status, 200);
  assert.ok(feed.data.events.some((e) => e.action === 'text' && e.login === mod.login));

  assert.equal((await ts.request('/api/events', { method: 'DELETE', token: modTok })).status, 403);
  assert.equal((await ts.request('/api/events', { method: 'DELETE', token: admin })).status, 200);
  assert.deepEqual((await ts.request('/api/events', { token: admin })).data.events, []);
});

test('HTTP: назначение прав модератору', async () => {
  const admin = await ts.adminToken();
  const mod = await createUser(admin);

  const set = await ts.request(`/api/users/${mod.id}/perms`, {
    method: 'POST', token: admin, body: { perms: ['text', 'notify', 'bogus', 'text'] },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.user.perms, ['text', 'notify']);

  const full = await ts.request(`/api/users/${mod.id}/perms`, { method: 'POST', token: admin, body: { full: true } });
  assert.equal(full.status, 200);
  assert.deepEqual(full.data.user.perms, ALL_PERMS, 'full возвращает все права');

  const badPerms = await ts.request(`/api/users/${mod.id}/perms`, { method: 'POST', token: admin, body: { perms: 'nope' } });
  assert.equal(badPerms.status, 400);
  assert.equal(badPerms.data.error, 'bad_perms');

  const me = await ts.request('/api/me', { token: admin });
  const adminId = me.data.user.id;
  const adminTarget = await ts.request(`/api/users/${adminId}/perms`, { method: 'POST', token: admin, body: { perms: ['text'] } });
  assert.equal(adminTarget.status, 400);
  assert.equal(adminTarget.data.error, 'admin_has_all');

  const boot = await ts.request('/api/bootstrap', { token: admin });
  assert.ok(Array.isArray(boot.data.permLabels) && boot.data.permLabels.length === 9);
});

test('WS: ограниченный модератор получает forbidden и шлёт только разрешённое', async (t) => {
  const admin = await ts.adminToken();
  const mod = await createUser(admin);
  await ts.request(`/api/users/${mod.id}/perms`, { method: 'POST', token: admin, body: { perms: ['text'] } });
  const { ws } = await connectMod(t, mod.login, mod.password);

  ws.send({ t: 'widget.add', item: { id: 'nope', type: 'counter' } });
  const wErr = await ws.waitFor((m) => m.t === 'error' && m.perm === 'widgets');
  assert.equal(wErr.code, 'forbidden');

  ws.send({ t: 'notify', item: { title: 'x' } });
  assert.equal((await ws.waitFor((m) => m.t === 'error' && m.perm === 'notify')).code, 'forbidden');

  ws.send({ t: 'sound', url: '/media/uploads/x.mp3' });
  assert.equal((await ws.waitFor((m) => m.t === 'error' && m.perm === 'sound')).code, 'forbidden');

  ws.send({ t: 'text.add', item: { id: 'allowed-text', text: 'Можно', x: 0.5, y: 0.5, size: 0.05 } });
  const ok = await ws.waitFor((m) => m.t === 'text.add' && m.item.id === 'allowed-text');
  assert.equal(ok.item.text, 'Можно');
});

test('WS: смена прав приходит подключённому модератору', async (t) => {
  const admin = await ts.adminToken();
  const mod = await createUser(admin);
  const { ws } = await connectMod(t, mod.login, mod.password);
  await ts.request(`/api/users/${mod.id}/perms`, { method: 'POST', token: admin, body: { perms: ['draw', 'fx'] } });
  const msg = await ws.waitFor((m) => m.t === 'perms');
  assert.deepEqual(msg.perms, ['draw', 'fx']);
});

test('WS: уведомления доходят до оверлея и пишутся в ленту', async (t) => {
  const admin = await ts.adminToken();
  const { ws: mod } = await connectMod(t, ADMIN_LOGIN, ADMIN_PASSWORD);
  const overlay = await connectOverlay(t);

  mod.send({
    t: 'notify',
    item: { title: 'Новый донат', message: '100 ₽', template: 'donation', position: 'bottom-right', animation: 'pop', duration: 3000, accent: '#3ddc97', icon: '💸' },
  });
  const received = await overlay.waitFor((m) => m.t === 'notify');
  assert.equal(received.item.template, 'donation');
  assert.equal(received.item.position, 'bottom-right');
  assert.equal(received.item.animation, 'pop');
  assert.equal(received.item.duration, 3000);

  const entry = await mod.waitFor((m) => m.t === 'event' && m.entry.action === 'notify');
  assert.equal(entry.entry.login, ADMIN_LOGIN);
  assert.match(entry.entry.detail, /Новый донат/);
});

test('WS: виджеты добавляются и управляются на оверлее', async (t) => {
  const admin = await ts.adminToken();
  const { ws: mod } = await connectMod(t, ADMIN_LOGIN, ADMIN_PASSWORD);
  const overlay = await connectOverlay(t);

  mod.send({ t: 'widget.add', item: { id: 'live-counter', type: 'counter', x: 0.1, y: 0.1 } });
  const added = await overlay.waitFor((m) => m.t === 'widget.add' && m.item.id === 'live-counter');
  assert.equal(added.item.data.value, 0);

  mod.send({ t: 'widget.control', id: 'live-counter', op: 'inc' });
  const updated = await overlay.waitFor((m) => m.t === 'widget.update' && m.item.id === 'live-counter');
  assert.equal(updated.item.data.value, 1);

  const entry = await mod.waitFor((m) => m.t === 'event' && m.entry.action === 'widgets');
  assert.ok(entry.entry.detail.length > 0);

  mod.send({ t: 'widget.remove', id: 'live-counter' });
  await overlay.waitFor((m) => m.t === 'widget.remove' && m.id === 'live-counter');
});

test('WS: звук с очередью по умолчанию доходит до оверлея', async (t) => {
  const admin = await ts.adminToken();
  const { ws: mod } = await connectMod(t, ADMIN_LOGIN, ADMIN_PASSWORD);
  const overlay = await connectOverlay(t);

  mod.send({ t: 'sound', url: '/media/uploads/horn.mp3', volume: 2 });
  const sound = await overlay.waitFor((m) => m.t === 'sound');
  assert.equal(sound.url, '/media/uploads/horn.mp3');
  assert.equal(sound.volume, 1, 'громкость зажимается');
  assert.equal(sound.queue, true, 'очередь включена по умолчанию');

  const entry = await mod.waitFor((m) => m.t === 'event' && m.entry.action === 'sound');
  assert.ok(entry.entry.detail.length > 0);
});