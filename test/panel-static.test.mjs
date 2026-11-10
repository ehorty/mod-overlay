import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

function idsOf(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

function dollarRefs(source) {
  return [...source.matchAll(/(?<!\$)\$\(\s*['"]#([\w-]+)['"]\s*\)/g)].map((m) => m[1]);
}

test('панель: ссылки на DOM-элементы существуют', () => {
  const html = read('public', 'panel', 'index.html');
  const ids = idsOf(html);
  assert.ok(ids.length > 80);
  assert.equal(new Set(ids).size, ids.length, 'id должны быть уникальны');

  const js = read('public', 'panel', 'panel.js');
  const missing = [...new Set(dollarRefs(js))].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, [], `panel.js ссылается на отсутствующие id: ${missing.join(', ')}`);

  const getById = [...js.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)].map((m) => m[1]);
  const missingGet = getById.filter((id) => !ids.includes(id));
  assert.deepEqual(missingGet, []);
});

test('панель: вкладки и секции совпадают', () => {
  const html = read('public', 'panel', 'index.html');
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const panels = [...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(tabs), new Set(['media', 'text', 'tts', 'sound', 'fx', 'admin']));
  assert.deepEqual(new Set(panels), new Set(tabs));
  assert.equal(new Set(tabs).size, tabs.length, 'вкладки не дублируются');
  assert.equal(new Set(panels).size, panels.length, 'секции не дублируются');

  for (const name of panels) {
    const section = new RegExp(`data-panel="${name}"[\\s\\S]*?</section>`).exec(html);
    assert.ok(section, `нет секции ${name}`);
    assert.ok(section[0].length > 400, `секция ${name} выглядит пустой`);
  }
});

test('панель: форма профиля и управление модераторами на месте', () => {
  const html = read('public', 'panel', 'index.html');
  for (const id of [
    'profile-modal',
    'profile-form',
    'profile-login',
    'profile-role',
    'profile-current',
    'profile-next',
    'profile-confirm',
    'profile-error',
    'profile-cancel',
    'btn-profile',
    'me-pill',
    'user-login',
    'user-password',
    'user-role',
    'user-add',
    'user-list',
    'tab-admin',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `нет #${id}`);
  }

  const js = read('public', 'panel', 'panel.js');
  assert.equal(js.includes('pw-form'), false, 'остался сломанный обработчик #pw-form');
  assert.match(js, /\/api\/me\/password/);
  assert.match(js, /\/api\/users/);
  assert.match(js, /scene\.clearAll\(\)/, 'при отзыве сессии оверлей очищается');
});

test('панель и оверлей: локальные ассеты существуют', () => {
  for (const file of [
    ['public', 'panel', 'index.html'],
    ['public', 'overlay', 'index.html'],
    ['desktop', 'setup.html'],
  ]) {
    const source = read(...file);
    const dir = path.dirname(path.join(ROOT, ...file));
    for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = match[1];
      if (/^(?:https?:|data:|#|javascript:|mailto:)/i.test(target)) continue;
      if (target.startsWith('/')) continue;
      assert.ok(fs.existsSync(path.resolve(dir, target)), `${file.join('/')}: нет ${target}`);
    }
  }
});

test('оверлей: ссылки на элементы и общая сцена', () => {
  const html = read('public', 'overlay', 'index.html');
  const ids = idsOf(html);
  const js = read('public', 'overlay', 'overlay.js');
  const refs = [...js.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(
    refs.filter((id) => !ids.includes(id)),
    [],
  );
  assert.ok(ids.includes('tts-player'));
  assert.ok(ids.includes('confetti'));
  assert.match(js, /from '\.\.\/shared\/scene\.js'/);
  assert.match(js, /4401/, 'обработка отзыва доступа');
});

test('настройка: все обращения к мосту есть в preload', () => {
  const html = read('desktop', 'setup.html');
  const ids = idsOf(html);
  const refs = [...html.matchAll(/\$\(\s*'([\w-]+)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(
    refs.filter((id) => !ids.includes(id)),
    [],
  );

  const preload = read('desktop', 'preload.cjs');
  const used = [...html.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]);
  assert.ok(used.length >= 5);
  for (const name of new Set(used)) {
    assert.match(preload, new RegExp(`\\b${name}:`), `preload не предоставляет ${name}`);
  }

  const main = read('desktop', 'main.cjs');
  assert.match(main, /preload\.cjs/);
  assert.match(main, /desktop:apply/);
  assert.match(main, /desktop:get-state/);
});

test('синтаксис фронтенда и Electron корректен', () => {
  for (const file of ['public/panel/panel.js', 'public/overlay/overlay.js', 'public/shared/scene.js']) {
    const source = read(...file.split('/'));
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: source,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }

  for (const file of ['desktop/main.cjs', 'desktop/preload.cjs']) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, ...file.split('/'))], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});

test('файлы для хостинга на месте', () => {
  const compose = read('deploy', 'docker-compose.yml');
  assert.match(compose, /app:/);
  assert.match(compose, /caddy:/);
  assert.match(compose, /app-data/);
  assert.match(compose, /TRUST_PROXY:\s*1/);

  const caddyfile = read('deploy', 'Caddyfile');
  assert.match(caddyfile, /reverse_proxy app:3000/);
  assert.match(caddyfile, /\{\$DOMAIN\}/);

  const dockerfile = read('deploy', 'Dockerfile');
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /USER app/);
  assert.match(dockerfile, /\/api\/health/);

  for (const file of ['deploy/nginx.conf', 'deploy/mod-overlay.service', 'deploy/README.md', 'deploy/.env.example']) {
    assert.ok(fs.existsSync(path.join(ROOT, ...file.split('/'))), `нет ${file}`);
  }

  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.test, /node --test/);
  assert.match(pkg.scripts.test, /test\/.*\.test\.mjs/);
});
