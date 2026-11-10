import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TtsService, FALLBACK_VOICES } from '../dist/tts.js';
import { makeTempDir, removeDir } from './helpers.mjs';

const VOICES = [
  { ShortName: 'en-US-GuyNeural', DisplayName: 'Microsoft Guy Online (Natural)', Locale: 'en-US', Gender: 'Male' },
  { ShortName: 'de-DE-KatjaNeural', DisplayName: 'Microsoft Katja', Locale: 'de-DE', Gender: 'Female' },
  { ShortName: 'ru-RU-DmitryNeural', DisplayName: 'Microsoft Dmitry Online', Locale: 'ru-RU', Gender: 'Male' },
  { ShortName: 'xx-YY-NopeNeural', DisplayName: 'Nope', Locale: 'xx-YY', Gender: 'Female' },
  { ShortName: 'en-US-AriaNeural', DisplayName: 'Microsoft Aria', Locale: 'en-US', Gender: 'Female' },
];

function setup(t) {
  const dir = makeTempDir('mod-overlay-tts-');
  const ttsDir = path.join(dir, 'tts');
  fs.mkdirSync(ttsDir, { recursive: true });
  t.after(() => removeDir(dir));
  return { dir, ttsDir };
}

function fakeFactory({ voices = VOICES, generate, failVoices = false } = {}) {
  const calls = { voices: 0, generate: [] };
  const factory = () => ({
    getVoices: async () => {
      calls.voices += 1;
      if (failVoices) throw new Error('network down');
      return voices;
    },
    generate: async (text, voice, options) => {
      calls.generate.push({ text, voice, options });
      if (generate) return generate(calls.generate.length, text, voice, options);
      return { audio: Buffer.from('fake-mp3-bytes'), duration: 1.5 };
    },
  });
  return { factory, calls };
}

test('say нормализует текст и параметры, сохраняет файл', async (t) => {
  const { ttsDir } = setup(t);
  const { factory, calls } = fakeFactory();
  const tts = new TtsService(ttsDir, factory);

  const result = await tts.say('  Привет\u0000   мир \n\n как дела  ', 'en-US-AriaNeural', 999, -999);

  assert.equal(calls.generate.length, 1);
  assert.deepEqual(calls.generate[0], {
    text: 'Привет мир как дела',
    voice: 'en-US-AriaNeural',
    options: {
      rate: '+100%',
      pitch: '-50Hz',
      volume: '+0%',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    },
  });

  assert.equal(result.duration, 1.5);
  assert.match(result.url, /^\/media\/tts\/[a-z0-9]+-[0-9a-f]+\.mp3$/);
  assert.equal(result.file, path.join(ttsDir, path.basename(result.url)));
  assert.deepEqual(fs.readFileSync(result.file), Buffer.from('fake-mp3-bytes'));
});

test('say зажимает отрицательные значения и обрезает текст', async (t) => {
  const { ttsDir } = setup(t);
  const { factory, calls } = fakeFactory();
  const tts = new TtsService(ttsDir, factory);

  await tts.say('а'.repeat(900), 'ru-RU-DmitryNeural', -999, 999);
  assert.equal(calls.generate[0].text.length, 500);
  assert.equal(calls.generate[0].options.rate, '-50%');
  assert.equal(calls.generate[0].options.pitch, '+50Hz');

  await tts.say('текст', 'ru-RU-DmitryNeural', 'abc', 'abc');
  assert.equal(calls.generate[1].options.rate, '+0%');
  assert.equal(calls.generate[1].options.pitch, '+0Hz');
});

test('неизвестный голос заменяется на русский по умолчанию', async (t) => {
  const { ttsDir } = setup(t);
  const { factory, calls } = fakeFactory();
  const tts = new TtsService(ttsDir, factory);

  await tts.say('текст', 'evil-voice', 0, 0);
  await tts.say('текст', '../../etc/passwd', 0, 0);
  await tts.say('текст', undefined, 0, 0);

  for (const call of calls.generate) assert.equal(call.voice, 'ru-RU-DmitryNeural');
});

test('пустой текст отклоняется без обращения к движку', async (t) => {
  const { ttsDir } = setup(t);
  const { factory, calls } = fakeFactory();
  const tts = new TtsService(ttsDir, factory);

  for (const value of ['', '   ', null, 42, '\u0000\u0001']) {
    await assert.rejects(tts.say(value, undefined, 0, 0), (err) => err.code === 'empty_text');
  }
  assert.equal(calls.generate.length, 0);
});

test('аудио принимается как Uint8Array и ArrayBuffer', async (t) => {
  const { ttsDir } = setup(t);
  const bytes = new Uint8Array([7, 8, 9, 10]);
  let mode = 'typed';
  const { factory } = fakeFactory({
    generate: () => ({ audio: mode === 'typed' ? bytes : bytes.buffer, duration: '2.5' }),
  });
  const tts = new TtsService(ttsDir, factory);

  const typed = await tts.say('раз', 'ru-RU-DmitryNeural', 0, 0);
  assert.deepEqual(fs.readFileSync(typed.file), Buffer.from(bytes));
  assert.equal(typed.duration, 2.5);

  mode = 'buffer';
  const buffer = await tts.say('два', 'ru-RU-DmitryNeural', 0, 0);
  assert.deepEqual(fs.readFileSync(buffer.file), Buffer.from(bytes));
  assert.notEqual(buffer.file, typed.file);
});

test('пустое аудио приводит к повторным попыткам и ошибке', async (t) => {
  const { ttsDir } = setup(t);
  const { factory, calls } = fakeFactory({ generate: () => ({ audio: Buffer.alloc(0) }) });
  const tts = new TtsService(ttsDir, factory);

  await assert.rejects(tts.say('текст', 'ru-RU-DmitryNeural', 0, 0), (err) => err.code === 'tts_failed');
  assert.equal(calls.generate.length, 3);
});

test('временная ошибка движка переживается повтором', async (t) => {
  const { ttsDir } = setup(t);
  const { factory, calls } = fakeFactory({
    generate: (attempt) => {
      if (attempt === 1) throw new Error('temporary');
      return { audio: Buffer.from('ok'), duration: 0 };
    },
  });
  const tts = new TtsService(ttsDir, factory);

  const result = await tts.say('текст', 'ru-RU-DmitryNeural', 0, 0);
  assert.equal(calls.generate.length, 2);
  assert.equal(result.duration, 0);
  assert.deepEqual(fs.readFileSync(result.file), Buffer.from('ok'));
});

test('список голосов фильтруется и сортируется', async (t) => {
  const { ttsDir } = setup(t);
  const { factory, calls } = fakeFactory();
  const tts = new TtsService(ttsDir, factory);

  const voices = await tts.listVoices();
  assert.equal(calls.voices, 1);
  assert.deepEqual(
    voices.map((v) => v.id),
    ['ru-RU-DmitryNeural', 'en-US-AriaNeural', 'en-US-GuyNeural', 'de-DE-KatjaNeural'],
  );
  assert.deepEqual(voices[0], { id: 'ru-RU-DmitryNeural', name: 'Dmitry', locale: 'ru-RU', gender: 'Male' });
  assert.equal(voices[1].name, 'Aria');

  const cached = await tts.listVoices();
  assert.deepEqual(cached, voices);
  assert.equal(calls.voices, 1, 'повторный запрос идёт из кеша');
});

test('ошибка сети при загрузке голосов даёт запасной список', async (t) => {
  const { ttsDir } = setup(t);
  const failing = new TtsService(ttsDir, fakeFactory({ failVoices: true }).factory);
  assert.deepEqual(await failing.listVoices(), FALLBACK_VOICES);

  const empty = new TtsService(ttsDir, fakeFactory({ voices: [] }).factory);
  assert.deepEqual(await empty.listVoices(), FALLBACK_VOICES);
});

test('запасной список содержит русские голоса', () => {
  assert.ok(FALLBACK_VOICES.some((v) => v.locale === 'ru-RU'));
  for (const voice of FALLBACK_VOICES) assert.match(voice.id, /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/);
});

function withFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('голоса Yandex SpeechKit подключаются по ключу', async (t) => {
  const { ttsDir } = setup(t);
  const requests = [];
  await withFetch(t, async (url, init = {}) => {
    requests.push(String(url));
    if (!String(url).startsWith('https://tts.api.cloud.yandex.net/')) throw new Error(`unexpected ${url}`);
    assert.equal(init.headers.Authorization, 'Api-Key test-key');
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get('voice'), 'filipp');
    assert.equal(body.get('folderId'), 'folder-1');
    assert.equal(body.get('speed'), '1.50');
    assert.equal(body.get('format'), 'mp3');
    return new Response(Buffer.from('yandex-audio'), { status: 200 });
  });

  const { factory } = fakeFactory();
  const tts = new TtsService(ttsDir, factory, { yandexKey: 'test-key', yandexFolder: 'folder-1' });

  const voices = await tts.listVoices();
  assert.ok(voices.some((v) => v.id === 'yandex:filipp' && v.provider === 'yandex'));

  const result = await tts.say('привет', 'yandex:filipp', 50, 0);
  assert.deepEqual(fs.readFileSync(result.file), Buffer.from('yandex-audio'));
  assert.equal(requests.length, 1);
});

test('голоса SteosVoice загружаются и синтезируются', async (t) => {
  const { ttsDir } = setup(t);
  const requests = [];
  await withFetch(t, async (url, init = {}) => {
    const href = String(url);
    requests.push(href);
    if (href === 'https://api.test/v1/get/voices') {
      assert.equal(init.headers.Authorization, 'token-1');
      return Response.json({
        status: true,
        message: 'OK',
        voices: [{ voice_id: 7, name: { RU: 'Борис' }, description: { RU: 'Тест' } }],
      });
    }
    if (href === 'https://api.test/v1/get/tts') {
      assert.equal(init.headers.Authorization, 'token-1');
      assert.deepEqual(JSON.parse(init.body), { voice_id: 7, text: 'привет', format: 'mp3' });
      return Response.json({ status: true, message: 'OK', audio_url: 'https://cdn.test/a.mp3', format: 'mp3' });
    }
    if (href === 'https://cdn.test/a.mp3') return new Response(Buffer.from('steos-audio'), { status: 200 });
    throw new Error(`unexpected ${href}`);
  });

  const { factory } = fakeFactory();
  const tts = new TtsService(ttsDir, factory, { steosToken: 'token-1', steosApiUrl: 'https://api.test/v1' });

  const voices = await tts.listVoices();
  assert.ok(voices.some((v) => v.id === 'steos:7' && v.name === 'Борис' && v.provider === 'steos'));

  const result = await tts.say('привет', 'steos:7', 0, 0);
  assert.deepEqual(fs.readFileSync(result.file), Buffer.from('steos-audio'));
  assert.deepEqual(requests, [
    'https://api.test/v1/get/voices',
    'https://api.test/v1/get/tts',
    'https://cdn.test/a.mp3',
  ]);
});

test('без ключей голоса DonationAlerts не показываются', async (t) => {
  const { ttsDir } = setup(t);
  await withFetch(t, async (url) => {
    throw new Error(`fetch не должен вызываться: ${url}`);
  });

  const { factory, calls } = fakeFactory();
  const tts = new TtsService(ttsDir, factory);
  const voices = await tts.listVoices();
  assert.ok(!voices.some((v) => v.provider));

  await tts.say('текст', 'yandex:filipp', 0, 0);
  assert.equal(calls.generate[0].voice, 'ru-RU-DmitryNeural');
});

test('недоступный SteosVoice не тормозит панель повторными запросами', async (t) => {
  const { ttsDir } = setup(t);
  let requests = 0;
  await withFetch(t, async () => {
    requests += 1;
    throw new Error('network down');
  });

  const { factory } = fakeFactory();
  const tts = new TtsService(ttsDir, factory, { steosToken: 'token-1' });

  const first = await tts.listVoices();
  const second = await tts.listVoices();
  assert.equal(requests, 1);
  assert.ok(!first.some((v) => v.provider === 'steos'));
  assert.deepEqual(second, first);
});

test('cleanup удаляет только старые mp3', (t) => {
  const { ttsDir } = setup(t);
  const tts = new TtsService(ttsDir, fakeFactory().factory);

  const oldFile = path.join(ttsDir, 'old.mp3');
  const newFile = path.join(ttsDir, 'new.mp3');
  const note = path.join(ttsDir, 'note.txt');
  fs.writeFileSync(oldFile, 'old');
  fs.writeFileSync(newFile, 'new');
  fs.writeFileSync(note, 'text');

  const twoHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

  tts.cleanup(2 * 60 * 60 * 1000);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
  assert.equal(fs.existsSync(note), true);
});

test('cleanup не падает на отсутствующей папке', (t) => {
  const { dir } = setup(t);
  const tts = new TtsService(path.join(dir, 'missing'), fakeFactory().factory);
  assert.doesNotThrow(() => tts.cleanup());
});
