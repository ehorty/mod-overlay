import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Db, newId, newOverlayKey } from '../dist/db.js';
import { makeTempDir, removeDir } from './helpers.mjs';

function tempDir(t) {
  const dir = makeTempDir('mod-overlay-db-');
  t.after(() => removeDir(dir));
  return dir;
}

const user = (over = {}) => ({
  id: 'u_1',
  login: 'moder',
  passwordHash: '$2b$10$hash',
  role: 'mod',
  createdAt: 10,
  updatedAt: 10,
  ...over,
});

test('новая база создаёт основную комнату и файл', (t) => {
  const dir = tempDir(t);
  const db = new Db(dir);
  assert.equal(db.data.users.length, 0);
  assert.equal(db.data.rooms.length, 1);
  const room = db.getMainRoom();
  assert.equal(room.id, 'main');
  assert.equal(room.name, 'Основная комната');
  assert.ok(room.overlayKey.length >= 20);
  assert.ok(fs.existsSync(path.join(dir, 'db.json')));

  const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.rooms[0].overlayKey, room.overlayKey);
});

test('данные переживают перезапуск', (t) => {
  const dir = tempDir(t);
  const db = new Db(dir);
  db.addUser(user());
  const key = db.rotateRoomKey('main');
  db.saveNow();

  const second = new Db(dir);
  assert.equal(second.data.users.length, 1);
  assert.equal(second.findUserByLogin('moder').id, 'u_1');
  assert.equal(second.getMainRoom().overlayKey, key);
});

test('поиск пользователей без учёта регистра', (t) => {
  const db = new Db(tempDir(t));
  db.addUser(user({ login: 'Moderator' }));
  assert.equal(db.findUserByLogin('moderator').id, 'u_1');
  assert.equal(db.findUserByLogin('  MODERATOR ').id, 'u_1');
  assert.equal(db.findUserByLogin('nobody'), undefined);
  assert.equal(db.findUserById('u_1').login, 'Moderator');
  assert.equal(db.findUserById('u_missing'), undefined);
});

test('битый JSON откладывается в сторону, база создаётся заново', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'db.json'), '{ это не json', 'utf8');
  const db = new Db(dir);
  assert.equal(db.data.users.length, 0);
  assert.equal(db.data.rooms.length, 1);

  const broken = fs.readdirSync(dir).filter((name) => name.startsWith('db.json.broken-'));
  assert.equal(broken.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, broken[0]), 'utf8'), '{ это не json');
});

test('некорректные записи фильтруются при загрузке', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, 'db.json'),
    JSON.stringify({
      version: 1,
      users: [user(), { id: 1 }, { id: 'u_2', login: 'x' }, user({ id: 'u_3', login: 'ok' })],
      rooms: [null, { id: 'main' }, { id: 'r2', name: 'Room', overlayKey: 'key' }],
    }),
    'utf8',
  );
  const db = new Db(dir);
  assert.deepEqual(
    db.data.users.map((u) => u.id),
    ['u_1', 'u_3'],
  );
  assert.deepEqual(
    db.data.rooms.map((r) => r.id),
    ['r2'],
  );
});

test('пустой список комнат заменяется основной', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 1, users: [], rooms: [] }), 'utf8');
  const db = new Db(dir);
  assert.equal(db.getMainRoom().id, 'main');
  assert.ok(db.getMainRoom().overlayKey);
});

test('подсчёт администраторов и ротация ключа', (t) => {
  const db = new Db(tempDir(t));
  assert.equal(db.countAdmins(), 0);
  db.addUser(user({ id: 'a1', login: 'a1', role: 'admin' }));
  db.addUser(user({ id: 'a2', login: 'a2', role: 'admin' }));
  db.addUser(user({ id: 'm1', login: 'm1' }));
  assert.equal(db.countAdmins(), 2);

  const before = db.getMainRoom().overlayKey;
  const after = db.rotateRoomKey('main');
  assert.notEqual(after, before);
  assert.equal(db.getMainRoom().overlayKey, after);
  assert.equal(new Set([before, after]).size, 2);
  assert.throws(() => db.rotateRoomKey('missing'), /room_not_found/);
});

test('генераторы идентификаторов уникальны', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId('u_')));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^u_/);
  const keys = new Set(Array.from({ length: 100 }, () => newOverlayKey()));
  assert.equal(keys.size, 100);
});

test('getRoom возвращает комнату по id', (t) => {
  const db = new Db(tempDir(t));
  assert.equal(db.getRoom('main').name, 'Основная комната');
  assert.equal(db.getRoom('nope'), undefined);
});
