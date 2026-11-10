import { SceneView } from '../shared/scene.js';

const params = new URLSearchParams(location.search);
const ROOM = params.get('room') || 'main';
const KEY = params.get('key') || '';
const DEBUG = params.get('debug') === '1';

const stage = document.getElementById('stage');
const scene = new SceneView(document.getElementById('scene'));
const player = document.getElementById('tts-player');
const flashEl = document.getElementById('flash');
const statusEl = document.getElementById('status');
const confettiCanvas = document.getElementById('confetti');
const confettiCtx = confettiCanvas.getContext('2d');

/** Ничего не показываем в эфире — только в консоль OBS. */
function log(...args) {
  console.log('[overlay]', ...args);
}

function setStatus(text, online) {
  if (!DEBUG) return;
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle('off', !online);
}

/* ------------------------------- WebSocket ------------------------------ */

let ws = null;
let retryDelay = 800;
let stopped = false;

function connect() {
  if (stopped) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws?role=overlay&room=${encodeURIComponent(ROOM)}&key=${encodeURIComponent(KEY)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    retryDelay = 800;
    setStatus('overlay: connecting', false);
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  };

  ws.onclose = (event) => {
    if (event.code === 4401 || event.code === 4404) {
      setStatus(`overlay: ${event.code === 4401 ? 'неверный ключ' : 'нет комнаты'}`, false);
      log('Соединение отклонено сервером:', event.code, event.reason);
      scene.clearAll();
      stopped = true;
      return;
    }
    setStatus('overlay: offline', false);
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(15000, retryDelay * 1.7);
  };

  ws.onerror = () => {
    /* onclose придёт следом */
  };
}

function handle(msg) {
  if (DEBUG) log('event:', msg.t);
  switch (msg.t) {
    case 'hello':
      setStatus('overlay: online', true);
      scene.setState(msg.state);
      break;
    case 'state':
      scene.setState(msg.state);
      break;
    case 'stroke.start':
      scene.startStroke(msg.stroke);
      break;
    case 'stroke.points':
      scene.addPoints(msg.id, msg.points);
      break;
    case 'stroke.undo':
      scene.removeStroke(msg.id);
      break;
    case 'draw.clear':
      scene.clearStrokes();
      break;
    case 'media.add':
    case 'media.update':
      scene.upsertMedia(msg.item);
      break;
    case 'media.remove':
      scene.removeMedia(msg.id);
      break;
    case 'text.add':
    case 'text.update':
      scene.upsertText(msg.item);
      break;
    case 'text.remove':
      scene.removeText(msg.id);
      break;
    case 'scene.clear':
      scene.clearAll();
      break;
    case 'tts':
      enqueueTts(msg.url, msg.volume);
      break;
    case 'tts.stop':
      stopTts();
      break;
    case 'tts.fallback':
      speakFallback(msg.text, msg.volume);
      break;
    case 'sound':
      playSound(msg);
      break;
    case 'fx':
      playFx(msg.kind);
      break;
    default:
      break;
  }
}

/* ---------------------------------- TTS --------------------------------- */

const ttsQueue = [];
let ttsPlaying = false;

function enqueueTts(url, volume) {
  if (!url) return;
  ttsQueue.push({ url, volume: Number.isFinite(volume) ? volume : 1 });
  if (ttsQueue.length > 10) ttsQueue.splice(0, ttsQueue.length - 10);
  pumpTts();
}

function pumpTts() {
  if (ttsPlaying || !ttsQueue.length) return;
  const item = ttsQueue[0];
  ttsPlaying = true;
  player.src = item.url;
  player.volume = Math.max(0, Math.min(1, item.volume));
  const done = () => {
    ttsPlaying = false;
    ttsQueue.shift();
    setTimeout(pumpTts, 60);
  };
  player.onended = done;
  player.onerror = () => {
    log('Ошибка воспроизведения TTS:', player.src);
    done();
  };
  const play = player.play();
  if (play && play.catch) {
    play.catch((err) => {
      log('Автовоспроизведение заблокировано:', err?.name);
      ttsPlaying = false;
      ttsQueue.shift();
      setTimeout(pumpTts, 1000);
    });
  }
}

function stopTts() {
  ttsQueue.length = 0;
  ttsPlaying = false;
  player.onended = null;
  player.onerror = null;
  try {
    player.pause();
    player.removeAttribute('src');
    player.load();
  } catch {
    /* ignore */
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function speakFallback(text, volume) {
  try {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(String(text ?? ''));
    utterance.lang = /[а-яё]/i.test(utterance.text) ? 'ru-RU' : 'en-US';
    utterance.volume = Math.max(0, Math.min(1, Number(volume) || 1));
    speechSynthesis.speak(utterance);
  } catch (e) {
    log('Резервный TTS недоступен:', e?.message);
  }
}

/* --------------------------------- звуки -------------------------------- */

let audioCtx = null;

function ac() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function tone(freq, duration, type, volume, slideTo) {
  const ctx = ac();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.03);
}

function noiseBurst(duration, volume, frequency) {
  const ctx = ac();
  if (!ctx) return;
  const t = ctx.currentTime;
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency || 1200;
  filter.Q.value = 0.9;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
}

function playPreset(name, volume) {
  const v = Math.max(0.02, Math.min(1, Number(volume) || 0.6));
  switch (name) {
    case 'beep':
      tone(880, 0.16, 'sine', 0.32 * v, 1320);
      break;
    case 'buzzer':
      tone(140, 0.5, 'square', 0.16 * v);
      break;
    case 'whoosh':
      noiseBurst(0.45, 0.5 * v, 900);
      break;
    case 'drum':
      for (let i = 0; i < 11; i++) {
        setTimeout(() => noiseBurst(0.06, 0.3 * v, 350 + Math.random() * 320), i * 55);
      }
      break;
    case 'horn':
      tone(220, 0.55, 'sawtooth', 0.1 * v);
      tone(277, 0.55, 'sawtooth', 0.08 * v);
      tone(330, 0.55, 'sawtooth', 0.07 * v);
      break;
    case 'pop':
      tone(620, 0.08, 'sine', 0.4 * v, 160);
      break;
    default:
      tone(880, 0.12, 'sine', 0.3 * v);
  }
}

function playSound(msg) {
  if (msg.url) {
    const audio = new Audio(msg.url);
    audio.volume = Math.max(0, Math.min(1, Number(msg.volume) || 1));
    audio.play().catch((e) => log('Звук не воспроизведён:', e?.name));
    return;
  }
  playPreset(msg.preset, msg.volume);
}

/* -------------------------------- эффекты ------------------------------- */

function playFx(kind) {
  if (kind === 'flash') {
    flashEl.classList.remove('run');
    void flashEl.offsetWidth;
    flashEl.classList.add('run');
  } else if (kind === 'shake') {
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
    setTimeout(() => stage.classList.remove('shake'), 700);
  } else if (kind === 'confetti') {
    confettiBurst();
  }
}

const confetti = { particles: [], raf: 0, until: 0 };
const CONFETTI_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ff9f0a', '#ffffff'];

function resizeConfetti() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  confettiCanvas.width = Math.round(window.innerWidth * dpr);
  confettiCanvas.height = Math.round(window.innerHeight * dpr);
  confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function confettiBurst() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (let i = 0; i < 170; i++) {
    confetti.particles.push({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.25,
      vx: (Math.random() - 0.5) * 1.6,
      vy: 1.2 + Math.random() * 3.4,
      size: 5 + Math.random() * Math.max(5, h * 0.012),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.28,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
    });
  }
  confetti.until = performance.now() + 4500;
  if (!confetti.raf) confetti.raf = requestAnimationFrame(confettiTick);
}

function confettiTick(now) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  confettiCtx.clearRect(0, 0, w, h);
  const particles = confetti.particles;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += 0.045;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    confettiCtx.save();
    confettiCtx.translate(p.x, p.y);
    confettiCtx.rotate(p.rot);
    confettiCtx.fillStyle = p.color;
    confettiCtx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    confettiCtx.restore();
    if (p.y > h + 40) particles.splice(i, 1);
  }
  if (particles.length && now < confetti.until) {
    confetti.raf = requestAnimationFrame(confettiTick);
  } else {
    particles.length = 0;
    confetti.raf = 0;
    confettiCtx.clearRect(0, 0, w, h);
  }
}

window.addEventListener('resize', resizeConfetti);
resizeConfetti();

connect();
