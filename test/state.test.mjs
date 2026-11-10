import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RoomStore } from '../dist/state.js';
import { makeTempDir, removeDir } from './helpers.mjs';

function store(t) {
  const dir = makeTempDir('mod-overlay-state-');
  t.after(() => removeDir(dir));
  return { dir, rooms: new RoomStore(dir) };
}

const stroke = (over = {}) => ({
  id: 's1',
  tool: 'pen',
  color: '#ff3b30',
  size: 0.006,
  points: [
    [0.1, 0.1],
    [0.2, 0.2],
  ],
  ...over,
});

const media = (over = {}) => ({
  id: 'm1',
  kind: 'image',
  url: '/media/uploads/a.png',
  x: 0.3,
  y: 0.3,
  w: 0.4,
  h: 0.4,
  ...over,
});

const text = (over = {}) => ({
  id: 't1',
  text: 'Привет',
  x: 0.5,
  y: 0.85,
  size: 0.06,
  ...over,
});

test('пустая комната создаётся лениво', (t) => {
  const { rooms } = store(t);
  assert.deepEqual(rooms.roomIds(), []);
  const state = rooms.get('main');
  assert.equal(state.revision, 1);
  assert.deepEqual(state.strokes, []);
  assert.deepEqual(rooms.roomIds(), ['main']);
  assert.notEqual(rooms.snapshot('main'), state, 'snapshot — копия');
});

test('stroke.start нормализует и зажимает значения', (t) => {
  const { rooms } = store(t);
  const result = rooms.apply(
    'main',
    {
      t: 'stroke.start',
      stroke: stroke({
        tool: 'laser',
        color: 'red',
        size: 9,
        points: [
          [2, -1],
          [0.5, 0.5],
          [NaN, 1],
          ['x', 1],
        ],
      }),
    },
    'u1',
  );
  assert.equal(result.ok, true);
  const saved = result.event.stroke;
  assert.equal(saved.tool, 'pen', 'неизвестный инструмент заменяется');
  assert.equal(saved.color, '#ff3b30', 'невалидный цвет заменяется');
  assert.equal(saved.size, 0.15, 'толщина зажимается сверху');
  assert.deepEqual(saved.points, [
    [1, 0],
    [0.5, 0.5],
  ]);
  assert.equal(rooms.get('main').revision, 2);

  const duplicate = rooms.apply('main', { t: 'stroke.start', stroke: stroke({ points: [[0.3, 0.3]] }) }, 'u1');
  assert.equal(duplicate.ok, true);
  assert.equal(rooms.get('main').strokes.length, 1, 'повторный id заменяет штрих');
});

test('начатый штрих без точек и мусор отклоняются', (t) => {
  const { rooms } = store(t);
  assert.deepEqual(rooms.apply('main', { t: 'stroke.start', stroke: { id: 'x', points: [] } }, 'u1'), {
    ok: false,
    error: 'bad_stroke',
  });
  assert.deepEqual(rooms.apply('main', null, 'u1'), { ok: false, error: 'bad_event' });
  assert.deepEqual(rooms.apply('main', { t: 'unknown' }, 'u1'), { ok: false, error: 'unknown_event' });
});

test('добавление точек, завершение и отмена штриха', (t) => {
  const { rooms } = store(t);
  rooms.apply('main', { t: 'stroke.start', stroke: stroke() }, 'u1');

  const add = rooms.apply('main', { t: 'stroke.points', id: 's1', points: [[0.4, 0.4]] }, 'u1');
  assert.equal(add.ok, true);
  assert.deepEqual(rooms.get('main').strokes[0].points.at(-1), [0.4, 0.4]);

  assert.deepEqual(rooms.apply('main', { t: 'stroke.points', id: 'nope', points: [[0, 0]] }, 'u1'), {
    ok: false,
    error: 'no_stroke',
  });
  assert.deepEqual(rooms.apply('main', { t: 'stroke.points', id: 's1', points: [] }, 'u1'), {
    ok: false,
    error: 'no_points',
  });

  const end = rooms.apply('main', { t: 'stroke.end', id: 's1' }, 'u1');
  assert.deepEqual(end.event, { t: 'stroke.end', id: 's1' });
  assert.deepEqual(rooms.apply('main', { t: 'stroke.end', id: 'nope' }, 'u1'), {
    ok: false,
    error: 'no_stroke',
  });

  const undo = rooms.apply('main', { t: 'stroke.undo' }, 'u1');
  assert.deepEqual(undo.event, { t: 'stroke.undo', id: 's1' });
  assert.equal(rooms.get('main').strokes.length, 0);
  assert.deepEqual(rooms.apply('main', { t: 'stroke.undo' }, 'u1'), { ok: false, error: 'empty' });
});

test('очистка рисунка и всей сцены', (t) => {
  const { rooms } = store(t);
  rooms.apply('main', { t: 'stroke.start', stroke: stroke() }, 'u1');
  rooms.apply('main', { t: 'media.add', item: media() }, 'u1');
  rooms.apply('main', { t: 'text.add', item: text() }, 'u1');

  assert.deepEqual(rooms.apply('main', { t: 'draw.clear' }, 'u1').event, { t: 'draw.clear' });
  assert.equal(rooms.get('main').strokes.length, 0);
  assert.equal(rooms.get('main').media.length, 1, 'картинки не затрагиваются');
  assert.deepEqual(rooms.apply('main', { t: 'draw.clear' }, 'u1'), { ok: false, error: 'empty' });

  assert.deepEqual(rooms.apply('main', { t: 'scene.clear' }, 'u1').event, { t: 'scene.clear' });
  const state = rooms.get('main');
  assert.deepEqual([state.strokes, state.media, state.texts], [[], [], []]);
  assert.deepEqual(rooms.apply('main', { t: 'scene.clear' }, 'u1'), { ok: false, error: 'empty' });
});

test('media.add/update/remove и валидация', (t) => {
  const { rooms } = store(t);
  const added = rooms.apply(
    'main',
    {
      t: 'media.add',
      item: media({
        kind: 'gif',
        url: 'javascript:alert(1)',
        x: 5,
        y: -9,
        w: 0,
        h: 9,
        opacity: 3,
        rotation: 999,
        fit: 'stretch',
        expiresAt: -5,
      }),
    },
    'u1',
  );
  assert.deepEqual(added, { ok: false, error: 'bad_media' }, 'опасный URL не принимается');

  const valid = rooms.apply(
    'main',
    {
      t: 'media.add',
      item: media({
        kind: 'video',
        url: 'https://example.com/clip.mp4',
        x: 5,
        y: -9,
        w: 0,
        h: 9,
        opacity: 3,
        rotation: 999,
        fit: 'stretch',
        expiresAt: 0,
      }),
    },
    'u1',
  );
  assert.equal(valid.ok, true);
  const item = valid.event.item;
  assert.equal(item.kind, 'video');
  assert.equal(item.x, 2);
  assert.equal(item.y, -1);
  assert.equal(item.w, 0.02);
  assert.equal(item.h, 2);
  assert.equal(item.opacity, 1);
  assert.equal(item.rotation, 360);
  assert.equal(item.fit, 'contain');
  assert.equal('expiresAt' in item, false);

  const updated = rooms.apply('main', { t: 'media.update', id: 'm1', patch: { hidden: true, opacity: 0.4 } }, 'u1');
  assert.equal(updated.ok, true);
  assert.equal(updated.event.item.hidden, true);
  assert.equal(updated.event.item.opacity, 0.4);
  assert.equal(updated.event.item.url, 'https://example.com/clip.mp4', 'остальные поля сохраняются');

  assert.deepEqual(rooms.apply('main', { t: 'media.update', id: 'nope', patch: { hidden: true } }, 'u1'), {
    ok: false,
    error: 'no_media',
  });
  assert.deepEqual(rooms.apply('main', { t: 'media.remove', id: 'm1' }, 'u1').event, {
    t: 'media.remove',
    id: 'm1',
  });
  assert.deepEqual(rooms.apply('main', { t: 'media.remove', id: 'm1' }, 'u1'), {
    ok: false,
    error: 'no_media',
  });
});

test('лимит картинок вытесняет старую и просит resync', (t) => {
  const { rooms } = store(t);
  for (let i = 0; i < 30; i += 1) {
    const result = rooms.apply('main', { t: 'media.add', item: media({ id: `m${i}` }) }, 'u1');
    assert.equal(result.ok, true);
    assert.equal(result.resync, undefined);
  }
  const overflow = rooms.apply('main', { t: 'media.add', item: media({ id: 'm-new' }) }, 'u1');
  assert.equal(overflow.ok, true);
  assert.equal(overflow.resync, true);
  const state = rooms.get('main');
  assert.equal(state.media.length, 30);
  assert.equal(state.media[0].id, 'm1');
  assert.equal(state.media.at(-1).id, 'm-new');
});

test('text.add/update/remove и валидация', (t) => {
  const { rooms } = store(t);
  assert.deepEqual(rooms.apply('main', { t: 'text.add', item: text({ text: '   ' }) }, 'u1'), {
    ok: false,
    error: 'bad_text',
  });

  const long = 'я'.repeat(400);
  const added = rooms.apply(
    'main',
    {
      t: 'text.add',
      item: text({ text: long, color: 'black', bg: 'red', align: 'justify', opacity: -1, x: 9, y: -9 }),
    },
    'u1',
  );
  assert.equal(added.ok, true);
  const item = added.event.item;
  assert.equal(item.text.length, 300);
  assert.equal(item.color, '#ffffff');
  assert.equal(item.bg, '');
  assert.equal(item.align, 'center');
  assert.equal(item.opacity, 0);
  assert.equal(item.x, 1.5);
  assert.equal(item.y, -0.5);
  assert.equal(item.outline, true, 'обводка включена по умолчанию');

  const updated = rooms.apply('main', { t: 'text.update', id: 't1', patch: { bg: 'rgba(0, 0, 0, 0.5)' } }, 'u1');
  assert.equal(updated.ok, true);
  assert.equal(updated.event.item.bg, 'rgba(0, 0, 0, 0.5)');
  assert.equal(updated.event.item.text, long.slice(0, 300), 'текст не теряется при частичном патче');

  assert.deepEqual(rooms.apply('main', { t: 'text.update', id: 'nope', patch: {} }, 'u1'), {
    ok: false,
    error: 'no_text',
  });
  assert.deepEqual(rooms.apply('main', { t: 'text.remove', id: 't1' }, 'u1').event, { t: 'text.remove', id: 't1' });
  assert.deepEqual(rooms.apply('main', { t: 'text.remove', id: 't1' }, 'u1'), { ok: false, error: 'no_text' });
});

test('лимит текстов вытесняет самый старый', (t) => {
  const { rooms } = store(t);
  for (let i = 0; i < 20; i += 1) {
    rooms.apply('main', { t: 'text.add', item: text({ id: `t${i}`, text: `текст ${i}` }) }, 'u1');
  }
  const overflow = rooms.apply('main', { t: 'text.add', item: text({ id: 't-new', text: 'новый' }) }, 'u1');
  assert.equal(overflow.resync, true);
  const state = rooms.get('main');
  assert.equal(state.texts.length, 20);
  assert.equal(state.texts[0].id, 't1');
  assert.equal(state.texts.at(-1).id, 't-new');
});

test('лимит штрихов вытесняет старые', (t) => {
  const { rooms } = store(t);
  let result;
  for (let i = 0; i < 600; i += 1) {
    result = rooms.apply('main', { t: 'stroke.start', stroke: stroke({ id: `s${i}` }) }, 'u1');
  }
  assert.ok(!result.resync);
  const overflow = rooms.apply('main', { t: 'stroke.start', stroke: stroke({ id: 's-new' }) }, 'u1');
  assert.equal(overflow.resync, true);
  const state = rooms.get('main');
  assert.equal(state.strokes.length, 600);
  assert.equal(state.strokes[0].id, 's1');
  assert.equal(state.strokes.at(-1).id, 's-new');
});

test('sweepExpired удаляет просроченные элементы', (t) => {
  const { rooms } = store(t);
  const past = Date.now() - 1000;
  const future = Date.now() + 60_000;
  rooms.apply('main', { t: 'media.add', item: media({ id: 'old', expiresAt: past }) }, 'u1');
  rooms.apply('main', { t: 'media.add', item: media({ id: 'live', expiresAt: future }) }, 'u1');
  rooms.apply('main', { t: 'text.add', item: text({ id: 'old-text', expiresAt: past }) }, 'u1');
  rooms.apply('main', { t: 'text.add', item: text({ id: 'live-text', expiresAt: future }) }, 'u1');
  const revision = rooms.get('main').revision;

  const events = rooms.sweepExpired('main');
  assert.deepEqual(
    events.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { t: 'media.remove', id: 'old' },
      { t: 'text.remove', id: 'old-text' },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const state = rooms.get('main');
  assert.deepEqual(
    state.media.map((m) => m.id),
    ['live'],
  );
  assert.deepEqual(
    state.texts.map((x) => x.id),
    ['live-text'],
  );
  assert.ok(state.revision > revision);

  const again = rooms.sweepExpired('main');
  assert.deepEqual(again, []);
});

test('состояние сохраняется и загружается', (t) => {
  const { dir, rooms } = store(t);
  rooms.apply('main', { t: 'stroke.start', stroke: stroke() }, 'u1');
  rooms.apply('main', { t: 'media.add', item: media() }, 'u1');
  rooms.apply('main', { t: 'text.add', item: text() }, 'u1');
  rooms.flush();

  const loaded = new RoomStore(dir);
  const state = loaded.get('main');
  assert.equal(state.strokes.length, 1);
  assert.equal(state.media.length, 1);
  assert.equal(state.texts.length, 1);
  assert.equal(state.texts[0].text, 'Привет');
  assert.ok(fs.existsSync(path.join(dir, 'rooms.json')));
});

test('битый rooms.json не мешает запуску', (t) => {
  const dir = makeTempDir('mod-overlay-state-bad-');
  t.after(() => removeDir(dir));
  fs.writeFileSync(path.join(dir, 'rooms.json'), 'nope', 'utf8');
  const rooms = new RoomStore(dir);
  assert.equal(rooms.get('main').revision, 1);
});

test('roomIds возвращает все созданные комнаты', (t) => {
  const { rooms } = store(t);
  rooms.get('main');
  rooms.get('second');
  assert.deepEqual(rooms.roomIds().sort(), ['main', 'second']);
});
