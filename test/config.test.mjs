import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConfig } from '../dist/config.js';
import { makeTempDir, removeDir } from './helpers.mjs';

function tempDir(t) {
  const dir = makeTempDir('mod-overlay-config-');
  t.after(() => removeDir(dir));
  return dir;
}

function withEnv(t, values) {
  const originals = (t.__envOriginals ??= {});
  for (const [key, value] of Object.entries(values)) {
    if (!(key in originals)) originals[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (!t.__envRestoreRegistered) {
    t.__envRestoreRegistered = true;
    t.after(() => {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
}

test('настройки по умолчанию и структура папок', (t) => {
  const dir = tempDir(t);
  withEnv(t, {
    HOST: undefined,
    PORT: undefined,
    ADMIN_LOGIN: undefined,
    ADMIN_PASSWORD: undefined,
    PUBLIC_URL: undefined,
    TRUST_PROXY: undefined,
  });
  const config = createConfig({ dataDir: dir, publicDir: path.join(dir, 'public'), jwtSecret: 'x'.repeat(32) });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3000);
  assert.equal(config.adminLogin, 'admin');
  assert.equal(config.adminPassword, undefined);
  assert.equal(config.publicUrl, undefined);
  assert.equal(config.trustProxy, 'loopback');
  assert.ok(fs.statSync(path.join(dir, 'uploads')).isDirectory());
  assert.ok(fs.statSync(path.join(dir, 'tts')).isDirectory());
  assert.equal(fs.existsSync(path.join(dir, 'secret.key')), false, 'явный секрет не пишется на диск');
});

test('секрет создаётся один раз и переиспользуется', (t) => {
  const dir = tempDir(t);
  const first = createConfig({ dataDir: dir, publicDir: dir });
  assert.match(first.jwtSecret, /^[0-9a-f]{64}$/);
  const stored = fs.readFileSync(path.join(dir, 'secret.key'), 'utf8');
  assert.equal(stored, first.jwtSecret);

  const second = createConfig({ dataDir: dir, publicDir: dir });
  assert.equal(second.jwtSecret, first.jwtSecret);

  fs.writeFileSync(path.join(dir, 'secret.key'), 'short', 'utf8');
  const replaced = createConfig({ dataDir: dir, publicDir: dir });
  assert.notEqual(replaced.jwtSecret, 'short');
  assert.equal(replaced.jwtSecret.length, 64);
});

test('JWT_SECRET и ADMIN_* из окружения', (t) => {
  const dir = tempDir(t);
  withEnv(t, { JWT_SECRET: 'env-secret', ADMIN_LOGIN: '  Boss ', ADMIN_PASSWORD: 'env-pass-123' });
  const config = createConfig({ dataDir: dir, publicDir: dir });
  assert.equal(config.jwtSecret, 'env-secret');
  assert.equal(config.adminLogin, 'boss');
  assert.equal(config.adminPassword, 'env-pass-123');
});

test('порт проверяется', (t) => {
  const dir = tempDir(t);
  const base = { dataDir: dir, publicDir: dir, jwtSecret: 'secret' };
  assert.equal(createConfig({ ...base, port: 0 }).port, 0);
  assert.equal(createConfig({ ...base, port: 65535 }).port, 65535);
  for (const port of [-1, 65536, 1.5, 'abc']) {
    assert.throws(() => createConfig({ ...base, port }), /PORT/, `порт ${port}`);
  }
});

test('PUBLIC_URL нормализуется', (t) => {
  const dir = tempDir(t);
  const base = { dataDir: dir, publicDir: dir, jwtSecret: 'secret' };
  assert.equal(createConfig({ ...base, publicUrl: 'https://overlay.example.com/' }).publicUrl, 'https://overlay.example.com');
  assert.equal(createConfig({ ...base, publicUrl: ' http://example.com/// ' }).publicUrl, 'http://example.com');
  assert.equal(createConfig({ ...base, publicUrl: 'https://example.com:8443' }).publicUrl, 'https://example.com:8443');
  assert.equal(createConfig({ ...base, publicUrl: '' }).publicUrl, undefined);
});

test('некорректный PUBLIC_URL отклоняется', (t) => {
  const dir = tempDir(t);
  const base = { dataDir: dir, publicDir: dir, jwtSecret: 'secret' };
  for (const value of [
    'overlay.example.com',
    'ftp://example.com',
    'https://example.com/panel',
    'https://example.com/?x=1',
    'https://example.com/#hash',
  ]) {
    assert.throws(() => createConfig({ ...base, publicUrl: value }), /PUBLIC_URL/, value);
  }
});

test('TRUST_PROXY разбирается', (t) => {
  const dir = tempDir(t);
  const base = { dataDir: dir, publicDir: dir, jwtSecret: 'secret' };
  assert.equal(createConfig(base).trustProxy, 'loopback');

  withEnv(t, { TRUST_PROXY: '1' });
  assert.equal(createConfig(base).trustProxy, 1);

  withEnv(t, { TRUST_PROXY: 'true' });
  assert.equal(createConfig(base).trustProxy, true);

  withEnv(t, { TRUST_PROXY: 'false' });
  assert.equal(createConfig(base).trustProxy, false);

  withEnv(t, { TRUST_PROXY: 'loopback, 10.0.0.0/8' });
  assert.equal(createConfig(base).trustProxy, 'loopback, 10.0.0.0/8');
});

test('DATA_DIR и PUBLIC_DIR берутся из окружения', (t) => {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'env-data');
  const publicDir = path.join(dir, 'env-public');
  withEnv(t, { DATA_DIR: dataDir, PUBLIC_DIR: publicDir, JWT_SECRET: 'env-secret' });
  const config = createConfig();
  assert.equal(config.dataDir, path.resolve(dataDir));
  assert.equal(config.publicDir, path.resolve(publicDir));
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads')));
});
