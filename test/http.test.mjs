import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createConfig } from '../dist/config.js';
import { Db } from '../dist/db.js';
import { AuthService } from '../dist/auth.js';
import { RoomStore } from '../dist/state.js';
import { createApp } from '../dist/http.js';
import { Hub } from '../dist/hub.js';
import {
  ADMIN_LOGIN,
  ADMIN_PASSWORD,
  PUBLIC_DIR,
  makeTempDir,
  openWs,
  removeDir,
  request,
  startTestServer,
  wsUrl,
} from './helpers.mjs';

let ts;
let counter = 0;
const nextLogin = (prefix = 'mod') => `${prefix}${++counter}`;

before(async () => {
  ts = await startTestServer({ adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });
});

after(async () => {
  await ts.cleanup();
});

async function adminToken() {
  return ts.adminToken();
}

async function createUser(token, over = {}) {
  const login = over.login ?? nextLogin();
  const password = over.password ?? 'mod-pass-123';
  const role = over.role ?? 'mod';
  const result = await ts.request('/api/users', {
    method: 'POST',
    token,
    body: { login, password, role },
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { id: result.data.user.id, login, password, role };
}

async function login(loginValue, password) {
  return ts.request('/api/login', {
    method: 'POST',
    body: { login: loginValue, password },
  });
}

test('health, статика и заголовки безопасности', async () => {
  const health = await ts.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.version, '0.1.0');
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(health.headers.get('x-powered-by'), null);

  const root = await fetch(`${ts.url}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/panel/');

  const panel = await fetch(`${ts.url}/panel/`);
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /Mod Overlay/);

  const overlay = await fetch(`${ts.url}/overlay/`);
  assert.equal(overlay.status, 200);
  const shared = await fetch(`${ts.url}/shared/scene.js`);
  assert.equal(shared.status, 200);
});

test('вход и /api/me', async () => {
  const noToken = await ts.request('/api/me');
  assert.equal(noToken.status, 401);
  assert.deepEqual(noToken.data, { error: 'unauthorized' });

  const badHeader = await ts.request('/api/me', { headers: { Authorization: 'Token abc' } });
  assert.equal(badHeader.status, 401);

  const wrong = await login(ADMIN_LOGIN, 'wrong-pass');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, 'invalid_credentials');

  const missing = await ts.request('/api/login', { method: 'POST', body: {} });
  assert.equal(missing.status, 401);

  const ok = await login(ADMIN_LOGIN, ADMIN_PASSWORD);
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.user.login, ADMIN_LOGIN);
  assert.equal(ok.data.user.role, 'admin');
  assert.equal(ok.data.user.passwordHash, undefined);

  const me = await ts.request('/api/me', { token: ok.data.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.user, ok.data.user);
});

test('bootstrap отдаёт комнату, состояние и список пользователей только админу', async () => {
  const token = await adminToken();
  const admin = await ts.request('/api/bootstrap', { token });
  assert.equal(admin.status, 200);
  assert.equal(admin.data.room.id, 'main');
  assert.ok(admin.data.room.overlayKey);
  assert.equal(
    admin.data.room.overlayUrl,
    `https://overlay.test/overlay/?room=main&key=${encodeURIComponent(admin.data.room.overlayKey)}`,
  );
  assert.equal(admin.data.state.revision, 1);
  assert.ok(Array.isArray(admin.data.users));
  assert.equal(admin.data.version, '0.1.0');

  const mod = await createUser(token, { login: nextLogin('boot') });
  const modLogin = await login(mod.login, mod.password);
  assert.equal(modLogin.status, 200);
  const modBoot = await ts.request('/api/bootstrap', { token: modLogin.data.token });
  assert.equal(modBoot.status, 200);
  assert.equal(modBoot.data.user.role, 'mod');
  assert.equal(modBoot.data.users, undefined);
  assert.ok(modBoot.data.room.overlayKey);
});

test('создание модератора и валидация', async () => {
  const token = await adminToken();

  for (const body of [
    { login: 'ab', password: 'good-pass-123' },
    { login: 'bad login', password: 'good-pass-123' },
    { login: 'oklogin', password: 'short' },
    { login: 'x'.repeat(33), password: 'good-pass-123' },
  ]) {
    const result = await ts.request('/api/users', { method: 'POST', token, body });
    assert.equal(result.status, 400, JSON.stringify(body));
  }

  const loginValue = nextLogin('new');
  const created = await ts.request('/api/users', {
    method: 'POST',
    token,
    body: { login: loginValue.toUpperCase(), password: 'good-pass-123', role: 'unknown' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.login, loginValue, 'логин приводится к нижнему регистру');
  assert.equal(created.data.user.role, 'mod');
  assert.equal(created.data.user.passwordHash, undefined);

  const duplicate = await ts.request('/api/users', {
    method: 'POST',
    token,
    body: { login: loginValue, password: 'good-pass-123' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error, 'login_exists');

  const auth = await login(loginValue, 'good-pass-123');
  assert.equal(auth.status, 200);
  assert.equal(auth.data.user.role, 'mod');
});

test('модератор не управляет пользователями и ключом', async () => {
  const token = await adminToken();
  const mod = await createUser(token);
  const auth = await login(mod.login, mod.password);
  const modToken = auth.data.token;

  for (const [method, url, body] of [
    ['GET', '/api/users'],
    ['POST', '/api/users', { login: 'hacker1', password: 'good-pass-123' }],
    ['DELETE', `/api/users/${mod.id}`],
    ['POST', `/api/users/${mod.id}/password`, { password: 'other-pass-123' }],
    ['POST', '/api/room/rotate-key'],
  ]) {
    const result = await ts.request(url, { method, token: modToken, body });
    assert.equal(result.status, 403, `${method} ${url}`);
    assert.equal(result.data.error, 'forbidden');
  }

  const anonymous = await ts.request('/api/users');
  assert.equal(anonymous.status, 401);
});

test('смена своего пароля отзывает старый токен и возвращает новый', async () => {
  const token = await adminToken();
  const mod = await createUser(token);
  const auth = await login(mod.login, mod.password);
  const oldToken = auth.data.token;

  const weak = await ts.request('/api/me/password', {
    method: 'POST',
    token: oldToken,
    body: { current: mod.password, next: 'short' },
  });
  assert.equal(weak.status, 400);

  const wrong = await ts.request('/api/me/password', {
    method: 'POST',
    token: oldToken,
    body: { current: 'not-the-password', next: 'new-pass-123' },
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.data.error, 'wrong_password');

  const changed = await ts.request('/api/me/password', {
    method: 'POST',
    token: oldToken,
    body: { current: mod.password, next: 'new-pass-123' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.ok, true);
  assert.ok(changed.data.token);

  const stale = await ts.request('/api/me', { token: oldToken });
  assert.equal(stale.status, 401);

  const fresh = await ts.request('/api/me', { token: changed.data.token });
  assert.equal(fresh.status, 200);

  assert.equal((await login(mod.login, mod.password)).status, 401);
  assert.equal((await login(mod.login, 'new-pass-123')).status, 200);
});

test('сброс пароля админом отзывает сессию модератора', async () => {
  const token = await adminToken();
  const mod = await createUser(token);
  const auth = await login(mod.login, mod.password);
  const modToken = auth.data.token;
  assert.equal((await ts.request('/api/me', { token: modToken })).status, 200);

  const weak = await ts.request(`/api/users/${mod.id}/password`, {
    method: 'POST',
    token,
    body: { password: 'short' },
  });
  assert.equal(weak.status, 400);

  const missing = await ts.request('/api/users/u_missing/password', {
    method: 'POST',
    token,
    body: { password: 'valid-pass-123' },
  });
  assert.equal(missing.status, 404);

  const reset = await ts.request(`/api/users/${mod.id}/password`, {
    method: 'POST',
    token,
    body: { password: 'reset-pass-123' },
  });
  assert.equal(reset.status, 200);

  assert.equal((await ts.request('/api/me', { token: modToken })).status, 401);
  assert.equal((await login(mod.login, mod.password)).status, 401);
  assert.equal((await login(mod.login, 'reset-pass-123')).status, 200);
});

test('удаление пользователя отзывает сессию и защищает от самоблокировки', async () => {
  const token = await adminToken();
  const mod = await createUser(token);
  const auth = await login(mod.login, mod.password);
  const modToken = auth.data.token;
  assert.equal((await ts.request('/api/me', { token: modToken })).status, 200);

  const remove = await ts.request(`/api/users/${mod.id}`, { method: 'DELETE', token });
  assert.equal(remove.status, 200);
  assert.equal((await ts.request('/api/me', { token: modToken })).status, 401);
  assert.equal((await login(mod.login, mod.password)).status, 401);

  const again = await ts.request(`/api/users/${mod.id}`, { method: 'DELETE', token });
  assert.equal(again.status, 404);

  const admin = await ts.request('/api/me', { token });
  const self = await ts.request(`/api/users/${admin.data.user.id}`, { method: 'DELETE', token });
  assert.equal(self.status, 400);
  assert.equal(self.data.error, 'cannot_delete_self');
});

test('ротация ключа оверлея меняет ссылку', async () => {
  const token = await adminToken();
  const before = await ts.request('/api/bootstrap', { token });
  const oldKey = before.data.room.overlayKey;

  const rotated = await ts.request('/api/room/rotate-key', { method: 'POST', token });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.overlayKey, oldKey);
  assert.match(rotated.data.overlayUrl, /^https:\/\/overlay\.test\/overlay\/\?room=main&key=/);

  const after = await ts.request('/api/bootstrap', { token });
  assert.equal(after.data.room.overlayKey, rotated.data.overlayKey);
  assert.equal(
    after.data.room.overlayUrl,
    `https://overlay.test/overlay/?room=main&key=${encodeURIComponent(rotated.data.overlayKey)}`,
  );
});

test('загрузка файлов, раздача и отклонение типов', async () => {
  const token = await adminToken();

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const form = new FormData();
  form.append('file', new File([png], 'dot.png', { type: 'image/png' }));
  const uploaded = await ts.request('/api/upload', { method: 'POST', token, body: form });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.kind, 'image');
  assert.equal(uploaded.data.name, 'dot.png');
  assert.equal(uploaded.data.size, png.length);
  assert.match(uploaded.data.url, /^\/media\/uploads\/[a-z0-9]+-[0-9a-f]+\.png$/);

  const served = await fetch(`${ts.url}${uploaded.data.url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.match(served.headers.get('cache-control'), /immutable/);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png);

  const audioForm = new FormData();
  audioForm.append('file', new File([new Uint8Array([1, 2])], 'beep.wav', { type: 'audio/wav' }));
  const audio = await ts.request('/api/upload', { method: 'POST', token, body: audioForm });
  assert.equal(audio.status, 200);
  assert.equal(audio.data.kind, 'audio');

  const videoForm = new FormData();
  videoForm.append('file', new File([new Uint8Array([1, 2])], 'clip.mp4', { type: 'video/mp4' }));
  const video = await ts.request('/api/upload', { method: 'POST', token, body: videoForm });
  assert.equal(video.status, 200);
  assert.equal(video.data.kind, 'video');

  const badForm = new FormData();
  badForm.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
  const bad = await ts.request('/api/upload', { method: 'POST', token, body: badForm });
  assert.equal(bad.status, 415);
  assert.equal(bad.data.error, 'bad_file_type');

  const emptyForm = new FormData();
  const empty = await ts.request('/api/upload', { method: 'POST', token, body: emptyForm });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error, 'no_file');

  const anonymousForm = new FormData();
  anonymousForm.append('file', new File([png], 'dot.png', { type: 'image/png' }));
  const anonymous = await ts.request('/api/upload', { method: 'POST', body: anonymousForm });
  assert.equal(anonymous.status, 401);
});

test('TTS валидирует вход до обращения к сети', async () => {
  const token = await adminToken();

  const empty = await ts.request('/api/tts', { method: 'POST', token, body: { text: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error, 'empty_text');

  const long = await ts.request('/api/tts', { method: 'POST', token, body: { text: 'а'.repeat(501) } });
  assert.equal(long.status, 400);
  assert.equal(long.data.error, 'text_too_long');

  const anonymous = await ts.request('/api/tts', { method: 'POST', body: { text: 'привет' } });
  assert.equal(anonymous.status, 401);
});

test('неизвестные API и статика отдают 404', async () => {
  const api = await ts.request('/api/does-not-exist');
  assert.equal(api.status, 404);
  assert.deepEqual(api.data, { error: 'not_found' });

  const page = await fetch(`${ts.url}/nope.html`);
  assert.equal(page.status, 404);
});

test('после 15 неудачных входов API отвечает 429', async (t) => {
  const local = await startTestServer({ adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });
  t.after(() => local.cleanup());

  for (let i = 0; i < 15; i += 1) {
    const result = await local.request('/api/login', {
      method: 'POST',
      body: { login: ADMIN_LOGIN, password: `wrong-${i}` },
    });
    assert.equal(result.status, 401, `попытка ${i + 1}`);
  }
  const blocked = await local.request('/api/login', {
    method: 'POST',
    body: { login: ADMIN_LOGIN, password: ADMIN_PASSWORD },
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.data.error, 'rate_limited');
});

test('TTS-маршрут рассылает озвучку оверлею', async (t) => {
  const dir = makeTempDir('mod-overlay-http-tts-');
  const config = createConfig({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    publicDir: PUBLIC_DIR,
    jwtSecret: 'test-secret',
    adminLogin: ADMIN_LOGIN,
    adminPassword: ADMIN_PASSWORD,
    publicUrl: 'https://overlay.test',
  });
  const db = new Db(dir);
  const auth = new AuthService(db, config.jwtSecret, {
    adminLogin: ADMIN_LOGIN,
    adminPassword: ADMIN_PASSWORD,
  });
  const rooms = new RoomStore(dir);
  const calls = [];
  let pending = null;
  const tts = {
    async listVoices() {
      return [{ id: 'ru-RU-DmitryNeural', name: 'Dmitry', locale: 'ru-RU', gender: 'Male' }];
    },
    async say(text, voice, rate, pitch) {
      calls.push({ text, voice, rate, pitch });
      if (text === 'fail') throw new Error('engine down');
      if (pending) await pending.promise;
      return { url: '/media/tts/fake.mp3', file: path.join(dir, 'tts', 'fake.mp3'), duration: 1.25 };
    },
  };

  const server = http.createServer();
  const hub = new Hub({ server, config, db, auth, rooms });
  server.on('request', createApp({ config, db, auth, rooms, tts, hub }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => server.close(resolve));
    removeDir(dir);
  });

  const loginResult = await request(base, '/api/login', {
    method: 'POST',
    body: { login: ADMIN_LOGIN, password: ADMIN_PASSWORD },
  });
  const token = loginResult.data.token;
  const boot = await request(base, '/api/bootstrap', { token });
  const key = boot.data.room.overlayKey;

  const overlay = await openWs(wsUrl(base, `?role=overlay&room=main&key=${encodeURIComponent(key)}`));
  t.after(() => overlay.close());
  await overlay.waitFor((msg) => msg.t === 'hello');

  const voices = await request(base, '/api/voices', { token });
  assert.equal(voices.status, 200);
  assert.equal(voices.data.voices[0].id, 'ru-RU-DmitryNeural');

  const ok = await request(base, '/api/tts', {
    method: 'POST',
    token,
    body: { text: '  привет  ', voice: 'ru-RU-DmitryNeural', rate: 10, pitch: -5, volume: 5 },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { url: '/media/tts/fake.mp3', duration: 1.25 });
  assert.deepEqual(calls[0], { text: 'привет', voice: 'ru-RU-DmitryNeural', rate: 10, pitch: -5 });

  const broadcast = await overlay.waitFor((msg) => msg.t === 'tts');
  assert.equal(broadcast.text, 'привет');
  assert.equal(broadcast.url, '/media/tts/fake.mp3');
  assert.equal(broadcast.volume, 1, 'громкость зажимается до 1');
  assert.equal(broadcast.by, boot.data.user.id);
  assert.equal(typeof broadcast.ts, 'number');

  const preview = await request(base, '/api/tts', {
    method: 'POST',
    token,
    body: { text: 'пример', preview: true },
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data, { url: '/media/tts/fake.mp3', duration: 1.25 });
  assert.equal(calls[1].text, 'пример');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    overlay.messages.some((msg) => msg.t === 'tts' && msg.text === 'пример'),
    false,
    'прослушивание не уходит в эфир',
  );

  const stopped = await request(base, '/api/tts/stop', { method: 'POST', token });
  assert.equal(stopped.status, 200);
  const stopMsg = await overlay.waitFor((msg) => msg.t === 'tts.stop');
  assert.equal(stopMsg.by, boot.data.user.id);

  const failed = await request(base, '/api/tts', {
    method: 'POST',
    token,
    body: { text: 'fail' },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.data.error, 'tts_failed');

  pending = (() => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  })();
  const first = request(base, '/api/tts', { method: 'POST', token, body: { text: 'долго' } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await request(base, '/api/tts', { method: 'POST', token, body: { text: 'ещё' } });
  assert.equal(second.status, 429);
  assert.equal(second.data.error, 'tts_busy');
  pending.resolve();
  pending = null;
  assert.equal((await first).status, 200);
});
