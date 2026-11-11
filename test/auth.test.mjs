import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../dist/db.js';
import { AuthService, hashPassword, publicUser } from '../dist/auth.js';
import { makeTempDir, removeDir } from './helpers.mjs';

const ADMIN_LOGIN = 'admin';
const ADMIN_PASSWORD = 'admin-pass-123';

function setup(t, options = {}) {
  const dir = makeTempDir('mod-overlay-auth-');
  t.after(() => removeDir(dir));
  const db = new Db(dir);
  const auth = new AuthService(db, 'test-secret', {
    adminLogin: ADMIN_LOGIN,
    adminPassword: ADMIN_PASSWORD,
    ...options,
  });
  return { dir, db, auth };
}

test('первый запуск создаёт администратора и файл с паролем', (t) => {
  const { dir, db, auth } = setup(t);
  assert.equal(auth.generatedPassword, ADMIN_PASSWORD, 'пароль первого входа доступен для показа');

  assert.equal(db.data.users.length, 1);
  const admin = db.data.users[0];
  assert.equal(admin.login, ADMIN_LOGIN);
  assert.equal(admin.role, 'admin');
  assert.match(admin.passwordHash, /^\$2[aby]\$/);

  const note = fs.readFileSync(path.join(dir, 'ADMIN_PASSWORD.txt'), 'utf8');
  assert.match(note, /admin/);
  assert.match(note, new RegExp(ADMIN_PASSWORD));
});

test('без пароля в настройках генерируется случайный пароль', (t) => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  t.after(() => {
    if (saved === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = saved;
  });

  const { auth } = setup(t, { adminPassword: '' });
  assert.ok(auth.generatedPassword);
  assert.ok(auth.generatedPassword.length >= 10);
});

test('повторный запуск не перезаписывает пользователей', (t) => {
  const { dir, db } = setup(t);
  db.addUser({
    id: 'u_test',
    login: 'helper',
    passwordHash: 'x',
    role: 'mod',
    createdAt: 1,
    updatedAt: 1,
  });
  db.saveNow();

  const second = new AuthService(new Db(dir), 'test-secret', {
    adminLogin: 'other',
    adminPassword: 'other-pass-123',
  });
  assert.equal(second.generatedPassword, undefined);
  const stored = new Db(dir);
  assert.equal(stored.data.users.length, 2);
  assert.ok(stored.findUserByLogin('helper'));
  assert.ok(stored.findUserByLogin('admin'));
});

test('вход: верные и неверные данные', async (t) => {
  const { auth } = setup(t);

  const ok = await auth.login(ADMIN_LOGIN, ADMIN_PASSWORD, '10.0.0.1');
  assert.equal(ok.ok, true);
  assert.ok(ok.token);
  assert.equal(ok.user.login, ADMIN_LOGIN);
  assert.equal(ok.user.role, 'admin');
  assert.equal('passwordHash' in ok.user, false);
  assert.ok(auth.verify(ok.token));

  const wrong = await auth.login(ADMIN_LOGIN, 'nope-nope', '10.0.0.2');
  assert.deepEqual(wrong, { ok: false, error: 'invalid_credentials' });

  const unknown = await auth.login('ghost', 'whatever-123', '10.0.0.3');
  assert.deepEqual(unknown, { ok: false, error: 'invalid_credentials' });

  const empty = await auth.login('', '', '10.0.0.4');
  assert.deepEqual(empty, { ok: false, error: 'invalid_credentials' });

  const spaced = await auth.login('  ADMIN  ', ADMIN_PASSWORD, '10.0.0.5');
  assert.equal(spaced.ok, true, 'логин сравнивается без регистра и пробелов');
});

test('после 15 неудач вход с IP блокируется', async (t) => {
  const { auth } = setup(t);
  const ip = '203.0.113.7';
  for (let i = 0; i < 15; i += 1) {
    const result = await auth.login(ADMIN_LOGIN, `wrong-${i}`, ip);
    assert.equal(result.error, 'invalid_credentials', `попытка ${i + 1}`);
  }
  const blocked = await auth.login(ADMIN_LOGIN, ADMIN_PASSWORD, ip);
  assert.deepEqual(blocked, { ok: false, error: 'rate_limited' });

  const otherIp = await auth.login(ADMIN_LOGIN, ADMIN_PASSWORD, '203.0.113.8');
  assert.equal(otherIp.ok, true, 'блокировка не затрагивает другие адреса');
});

test('токен перестаёт действовать после смены пароля', async (t) => {
  const { auth } = setup(t);
  const login = await auth.login(ADMIN_LOGIN, ADMIN_PASSWORD, '10.1.0.1');
  assert.equal(login.ok, true);
  const user = auth.verify(login.token);
  assert.ok(user);

  assert.equal(await auth.verifyPassword(user.id, ADMIN_PASSWORD), true);
  assert.equal(await auth.setPassword(user.id, 'new-admin-pass-456'), true);

  assert.equal(auth.verify(login.token), null, 'старый токен отозван');
  assert.equal(await auth.verifyPassword(user.id, ADMIN_PASSWORD), false);
  assert.equal(await auth.verifyPassword(user.id, 'new-admin-pass-456'), true);

  const again = await auth.login(ADMIN_LOGIN, 'new-admin-pass-456', '10.1.0.2');
  assert.equal(again.ok, true);
  assert.ok(auth.verify(again.token));
});

test('версия сессии меняется даже при двух сменах подряд', async (t) => {
  const { auth } = setup(t);
  const user = auth.verify((await auth.login(ADMIN_LOGIN, ADMIN_PASSWORD, '10.2.0.1')).token);
  await auth.setPassword(user.id, 'first-new-pass');
  const first = user.ver;
  await auth.setPassword(user.id, 'second-new-pass');
  const record = auth.verify((await auth.login(ADMIN_LOGIN, 'second-new-pass', '10.2.0.2')).token);
  assert.ok(record.ver > first);
});

test('удалённый пользователь теряет токен', async (t) => {
  const { db, auth } = setup(t);
  const login = await auth.login(ADMIN_LOGIN, ADMIN_PASSWORD, '10.3.0.1');
  const user = auth.verify(login.token);
  assert.ok(user);
  db.removeUser(user.id);
  assert.equal(auth.verify(login.token), null);
  assert.equal(await auth.setPassword(user.id, 'another-pass-1'), false);
  assert.equal(await auth.verifyPassword(user.id, ADMIN_PASSWORD), false);
});

test('поддельные и чужие токены отклоняются', async (t) => {
  const { auth } = setup(t);
  const login = await auth.login(ADMIN_LOGIN, ADMIN_PASSWORD, '10.4.0.1');
  assert.equal(auth.verify(''), null);
  assert.equal(auth.verify('not-a-jwt'), null);
  assert.equal(auth.verify(login.token.slice(0, -2) + 'xx'), null);

  const foreign = new AuthService(new Db(makeTempDir()), 'other-secret', {
    adminPassword: ADMIN_PASSWORD,
    adminLogin: ADMIN_LOGIN,
  });
  assert.equal(foreign.verify(login.token), null, 'токен подписан другим секретом');
});

test('publicUser не раскрывает хеш пароля', () => {
  const createdAt = 123456789;
  const view = publicUser({
    id: 'u_1',
    login: 'mod',
    passwordHash: '$2b$hash',
    role: 'mod',
    createdAt,
    updatedAt: createdAt,
  });
  assert.equal(view.passwordHash, undefined, 'хеш пароля не раскрывается');
  assert.equal(view.id, 'u_1');
  assert.equal(view.login, 'mod');
  assert.equal(view.role, 'mod');
  assert.equal(view.createdAt, createdAt);
  assert.ok(Array.isArray(view.perms) && view.perms.length > 0, 'legacy-модератор имеет полный доступ');

  const restricted = publicUser({
    id: 'u_2',
    login: 'textonly',
    passwordHash: '$2b$hash',
    role: 'mod',
    perms: ['text'],
    createdAt,
    updatedAt: createdAt,
  });
  assert.deepEqual(restricted.perms, ['text'], 'точные права сохраняются');

  const admin = publicUser({
    id: 'u_3',
    login: 'boss',
    passwordHash: '$2b$hash',
    role: 'admin',
    perms: ['text'],
    createdAt,
    updatedAt: createdAt,
  });
  assert.ok(admin.perms.includes('clear'), 'администратор всегда имеет все права');
});

test('hashPassword создаёт проверяемый хеш', async () => {
  const hash = await hashPassword('secret-pass');
  assert.notEqual(hash, 'secret-pass');
  const { default: bcrypt } = await import('bcryptjs');
  assert.equal(await bcrypt.compare('secret-pass', hash), true);
  assert.equal(await bcrypt.compare('other-pass', hash), false);
});
