import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  openWs,
  sleep,
  startTestServer,
  wsUrl,
} from './helpers.mjs';

let ts;
let counter = 0;
const nextLogin = (prefix = 'ws') => `${prefix}${++counter}`;

before(async () => {
  ts = await startTestServer({ adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });
});

after(async () => {
  if (ts) await ts.cleanup();
});

async function token() {
  return ts.adminToken();
}

async function currentKey(adminTok) {
  const boot = await ts.request('/api/bootstrap', { token: adminTok ?? (await token()) });
  return boot.data.room.overlayKey;
}

async function connectMod(t, options = {}) {
  const login = options.login ?? ADMIN_LOGIN;
  const password = options.password ?? ADMIN_PASSWORD;
  const auth = await ts.request('/api/login', { method: 'POST', body: { login, password } });
  assert.equal(auth.status, 200, JSON.stringify(auth.data));
  const ws = await openWs(
    wsUrl(ts.url, `?role=mod&room=${options.room ?? 'main'}&token=${encodeURIComponent(auth.data.token)}`),
  );
  t.after(() => ws.close());
  return { ws, token: auth.data.token, user: auth.data.user };
}

async function connectOverlay(t, key, room = 'main') {
  const ws = await openWs(wsUrl(ts.url, `?role=overlay&room=${room}&key=${encodeURIComponent(key)}`));
  t.after(() => ws.close());
  return ws;
}

async function createMod(adminTok) {
  const login = nextLogin();
  const created = await ts.request('/api/users', {
    method: 'POST',
    token: adminTok,
    body: { login, password: 'mod-pass-123', role: 'mod' },
  });
  assert.equal(created.status, 201);
  return { id: created.data.user.id, login, password: 'mod-pass-123' };
}

test('неверный ключ, токен и комната закрывают соединение', async (t) => {
  const badKey = await openWs(wsUrl(ts.url, '?role=overlay&room=main&key=nope'));
  assert.equal((await badKey.waitClose()).code, 4401);

  const badToken = await openWs(wsUrl(ts.url, '?role=mod&room=main&token=nope'));
  assert.equal((await badToken.waitClose()).code, 4401);

  const noToken = await openWs(wsUrl(ts.url, '?role=mod&room=main'));
  assert.equal((await noToken.waitClose()).code, 4401);

  const badName = await openWs(wsUrl(ts.url, '?role=mod&room=other&token=nope'));
  assert.equal((await badName.waitClose()).code, 4404);

  const badRole = await openWs(wsUrl(ts.url, '?role=unknown&room=main'));
  assert.equal((await badRole.waitClose()).code, 4401);
});

test('модератор получает hello с состоянием и собой', async (t) => {
  const { ws, user } = await connectMod(t);
  const hello = await ws.waitFor((msg) => msg.t === 'hello');
  assert.equal(hello.role, 'mod');
  assert.equal(hello.roomId, 'main');
  assert.equal(typeof hello.clientId, 'string');
  assert.equal(typeof hello.serverTime, 'number');
  assert.equal(hello.me.id, user.id);
  assert.equal(hello.me.login, ADMIN_LOGIN);
  assert.equal(hello.me.role, 'admin');
  assert.ok(hello.state);
  assert.ok(Array.isArray(hello.state.strokes));
});

test('оверлей получает hello без пользователя', async (t) => {
  const ws = await connectOverlay(t, await currentKey());
  const hello = await ws.waitFor((msg) => msg.t === 'hello');
  assert.equal(hello.role, 'overlay');
  assert.equal(hello.me, null);
  assert.ok(hello.state);
});

test('presence учитывает модераторов и оверлеи', async (t) => {
  const { ws: mod } = await connectMod(t);
  await mod.waitFor((msg) => msg.t === 'presence');
  const overlay = await connectOverlay(t, await currentKey());
  const presence = await overlay.waitFor((msg) => msg.t === 'presence' && msg.overlays >= 1);
  assert.ok(presence.mods >= 1);
  assert.ok(presence.overlays >= 1);
});

test('рисование рассылается оверлею и нормализуется', async (t) => {
  const { ws: mod } = await connectMod(t);
  const overlay = await connectOverlay(t, await currentKey());

  mod.send({
    t: 'stroke.start',
    stroke: {
      id: 'ws-stroke',
      tool: 'pen',
      color: '#00ff00',
      size: 0.01,
      points: [
        [2, -1],
        [0.5, 0.5],
      ],
    },
  });

  const event = await overlay.waitFor((msg) => msg.t === 'stroke.start');
  assert.equal(event.stroke.id, 'ws-stroke');
  assert.deepEqual(event.stroke.points, [
    [1, 0],
    [0.5, 0.5],
  ]);
  assert.equal(typeof event.by, 'string');
  assert.equal(typeof event.ts, 'number');

  mod.send({ t: 'stroke.points', id: 'ws-stroke', points: [[0.25, 0.75]] });
  const points = await overlay.waitFor((msg) => msg.t === 'stroke.points');
  assert.deepEqual(points.points, [[0.25, 0.75]]);

  mod.send({ t: 'stroke.end', id: 'ws-stroke' });
  await overlay.waitFor((msg) => msg.t === 'stroke.end');

  mod.send({ t: 'state.request' });
  const state = await mod.waitFor((msg) => msg.t === 'state');
  assert.equal(state.state.strokes[0].id, 'ws-stroke');
});

test('оверлей не может менять сцену', async (t) => {
  const { ws: mod } = await connectMod(t);
  const overlay = await connectOverlay(t, await currentKey());
  await overlay.waitFor((msg) => msg.t === 'hello');
  await sleep(80);

  const baseline = mod.messages.length;
  overlay.send({ t: 'stroke.start', stroke: { id: 'hack', points: [[0.1, 0.1]] } });
  overlay.send({ t: 'scene.clear' });
  await sleep(150);

  const added = mod.messages.slice(baseline).filter((msg) => msg.t === 'stroke.start' || msg.t === 'scene.clear');
  assert.deepEqual(added, []);
});

test('звуки и FX рассылаются с проверкой значений', async (t) => {
  const { ws: mod } = await connectMod(t);
  const overlay = await connectOverlay(t, await currentKey());

  mod.send({ t: 'sound', preset: 'beep', volume: 5 });
  const sound = await overlay.waitFor((msg) => msg.t === 'sound');
  assert.equal(sound.preset, 'beep');
  assert.equal(sound.volume, 1);

  mod.send({ t: 'sound', url: 'javascript:alert(1)' });
  const badSound = await mod.waitFor((msg) => msg.t === 'error' && msg.code === 'bad_sound');
  assert.equal(badSound.code, 'bad_sound');

  mod.send({ t: 'fx', kind: 'confetti' });
  assert.equal((await overlay.waitFor((msg) => msg.t === 'fx')).kind, 'confetti');

  mod.send({ t: 'fx', kind: 'nuke' });
  assert.equal((await mod.waitFor((msg) => msg.t === 'error' && msg.code === 'bad_fx')).code, 'bad_fx');
});

test('tts.fallback обрезает текст и громкость', async (t) => {
  const { ws: mod } = await connectMod(t);
  const overlay = await connectOverlay(t, await currentKey());

  mod.send({ t: 'tts.fallback', text: '  авария  ', volume: -2 });
  const event = await overlay.waitFor((msg) => msg.t === 'tts.fallback');
  assert.equal(event.text, 'авария');
  assert.equal(event.volume, 0);
  assert.equal(typeof event.by, 'string');
});

test('ping и ошибки событий', async (t) => {
  const { ws: mod } = await connectMod(t);

  mod.send({ t: 'ping' });
  const pong = await mod.waitFor((msg) => msg.t === 'pong');
  assert.equal(typeof pong.ts, 'number');

  mod.send({ t: 'text.add', item: { id: 'x', text: '   ' } });
  const error = await mod.waitFor((msg) => msg.t === 'error');
  assert.equal(error.code, 'bad_text');

  mod.send({ t: 'unknown.event' });
  const unknown = await mod.waitFor((msg) => msg.t === 'error' && msg.code === 'unknown_event');
  assert.equal(unknown.code, 'unknown_event');
});

test('ротация ключа закрывает старый оверлей и не пускает с ним новый', async (t) => {
  const adminTok = await token();
  const oldKey = await currentKey(adminTok);
  const overlay = await connectOverlay(t, oldKey);
  await overlay.waitFor((msg) => msg.t === 'hello');
  await sleep(80);

  const rotated = await ts.request('/api/room/rotate-key', { method: 'POST', token: adminTok });
  assert.equal(rotated.status, 200);
  const newKey = rotated.data.overlayKey;

  overlay.send({ t: 'ping' });
  assert.equal((await overlay.waitClose()).code, 4401);

  const stale = await openWs(wsUrl(ts.url, `?role=overlay&room=main&key=${encodeURIComponent(oldKey)}`));
  assert.equal((await stale.waitClose()).code, 4401);

  const fresh = await connectOverlay(t, newKey);
  const hello = await fresh.waitFor((msg) => msg.t === 'hello');
  assert.equal(hello.role, 'overlay');
});

test('смена пароля модератора закрывает его сокет', async (t) => {
  const adminTok = await token();
  const mod = await createMod(adminTok);
  const { ws } = await connectMod(t, { login: mod.login, password: mod.password });
  await ws.waitFor((msg) => msg.t === 'hello');

  const reset = await ts.request(`/api/users/${mod.id}/password`, {
    method: 'POST',
    token: adminTok,
    body: { password: 'new-mod-pass-123' },
  });
  assert.equal(reset.status, 200);

  ws.send({ t: 'ping' });
  assert.equal((await ws.waitClose()).code, 4401);
});

test('удаление модератора закрывает его сокет', async (t) => {
  const adminTok = await token();
  const mod = await createMod(adminTok);
  const { ws } = await connectMod(t, { login: mod.login, password: mod.password });
  await ws.waitFor((msg) => msg.t === 'hello');

  const removed = await ts.request(`/api/users/${mod.id}`, { method: 'DELETE', token: adminTok });
  assert.equal(removed.status, 200);

  ws.send({ t: 'ping' });
  assert.equal((await ws.waitClose()).code, 4401);
});
