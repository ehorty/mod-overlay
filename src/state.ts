import fs from 'node:fs';
import path from 'node:path';
import { newId } from './db';

/* ------------------------------------------------------------------ */
/* Модель сцены                                                        */
/* ------------------------------------------------------------------ */

export type Tool = 'pen' | 'marker' | 'eraser';

export interface Stroke {
  id: string;
  tool: Tool;
  color: string;
  /** Толщина как доля высоты сцены (0.006 ≈ 6.5px при 1080p). */
  size: number;
  points: [number, number][];
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video';
  url: string;
  /** Левый верхний угол, доля ширины/высоты сцены. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  rotation: number;
  hidden: boolean;
  fit: 'contain' | 'cover';
  expiresAt?: number;
}

export interface TextItem {
  id: string;
  text: string;
  /** Центр текста, доля ширины/высоты сцены. */
  x: number;
  y: number;
  /** Размер шрифта как доля высоты сцены. */
  size: number;
  color: string;
  bg: string;
  opacity: number;
  hidden: boolean;
  align: 'left' | 'center' | 'right';
  bold: boolean;
  outline: boolean;
  expiresAt?: number;
}

export type WidgetType =
  | 'clock'
  | 'timer'
  | 'counter'
  | 'progress'
  | 'goal'
  | 'random'
  | 'leaderboard';

export const WIDGET_TYPES: WidgetType[] = [
  'clock',
  'timer',
  'counter',
  'progress',
  'goal',
  'random',
  'leaderboard',
];

export interface LeaderEntry {
  name: string;
  score: number;
}

export interface Widget {
  id: string;
  type: WidgetType;
  /** Левый верхний угол и размер, доля ширины/высоты сцены. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  hidden: boolean;
  /** Акцентный цвет и фон карточки. */
  color: string;
  bg: string;
  /** Данные конкретного типа виджета. */
  data: Record<string, unknown>;
  expiresAt?: number;
}

export type NotifyPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type NotifyAnimation = 'slide' | 'fade' | 'pop' | 'bounce';

export interface Notification {
  id: string;
  title: string;
  message: string;
  template: string;
  position: NotifyPosition;
  animation: NotifyAnimation;
  duration: number;
  accent: string;
  icon: string;
}

export interface RoomState {
  revision: number;
  strokes: Stroke[];
  media: MediaItem[];
  texts: TextItem[];
  widgets: Widget[];
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* События                                                             */
/* ------------------------------------------------------------------ */

export type RoomEvent =
  | { t: 'stroke.start'; stroke: Stroke }
  | { t: 'stroke.points'; id: string; points: [number, number][] }
  | { t: 'stroke.end'; id: string }
  | { t: 'stroke.undo'; id: string }
  | { t: 'draw.clear' }
  | { t: 'media.add'; item: MediaItem }
  | { t: 'media.update'; item: MediaItem }
  | { t: 'media.remove'; id: string }
  | { t: 'text.add'; item: TextItem }
  | { t: 'text.update'; item: TextItem }
  | { t: 'text.remove'; id: string }
  | { t: 'widget.add'; item: Widget }
  | { t: 'widget.update'; item: Widget }
  | { t: 'widget.remove'; id: string }
  | { t: 'scene.clear' }
  | { t: 'state'; state: RoomState };

export type FanoutEvent = RoomEvent & { by: string; ts: number };

export type ApplyResult =
  | { ok: true; event: RoomEvent; resync?: boolean }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Лимиты                                                              */
/* ------------------------------------------------------------------ */

const MAX_STROKES = 600;
const MAX_POINTS_PER_STROKE = 12000;
const MAX_TOTAL_POINTS = 400_000;
const MAX_MEDIA = 30;
const MAX_TEXTS = 20;
const MAX_TEXT_LEN = 300;
const MAX_WIDGETS = 20;
const MAX_RANDOM_ITEMS = 60;
const MAX_LEADERS = 30;

/* ------------------------------------------------------------------ */
/* Валидация                                                           */
/* ------------------------------------------------------------------ */

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const num = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

function safeColor(v: unknown, def: string): string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : def;
}

function safeBg(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s === 'transparent') return '';
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^rgba?\([0-9.,\s%]+\)$/.test(s)) return s;
  return '';
}

function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 2000);
  if (!s) return null;
  if (s.startsWith('/media/')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

function safeAlign(v: unknown): 'left' | 'center' | 'right' {
  return v === 'left' || v === 'right' ? v : 'center';
}

function normPoints(input: unknown): [number, number][] {
  if (!Array.isArray(input)) return [];
  const out: [number, number][] = [];
  for (const p of input.slice(0, MAX_POINTS_PER_STROKE)) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = num(p[0], NaN);
    const y = num(p[1], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([round4(clamp(x, 0, 1)), round4(clamp(y, 0, 1))]);
  }
  return out;
}

function normStroke(input: unknown): Stroke | null {
  if (!input || typeof input !== 'object') return null;
  const s = input as Record<string, unknown>;
  const points = normPoints(s.points);
  if (!points.length) return null;
  const id = typeof s.id === 'string' && s.id.length > 0 && s.id.length <= 64 ? s.id : newId('s_');
  const tool: Tool = s.tool === 'marker' || s.tool === 'eraser' ? s.tool : 'pen';
  return {
    id,
    tool,
    color: safeColor(s.color, '#ff3b30'),
    size: clamp(num(s.size, 0.006), 0.0005, 0.15),
    points,
  };
}

function normMedia(input: unknown): MediaItem | null {
  if (!input || typeof input !== 'object') return null;
  const m = input as Record<string, unknown>;
  const url = safeUrl(m.url);
  if (!url) return null;
  const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 64 ? m.id : newId('m_');
  const expiresRaw = num(m.expiresAt, 0);
  return {
    id,
    kind: m.kind === 'video' ? 'video' : 'image',
    url,
    x: clamp(num(m.x, 0.3), -1, 2),
    y: clamp(num(m.y, 0.3), -1, 2),
    w: clamp(num(m.w, 0.4), 0.02, 2),
    h: clamp(num(m.h, 0.4), 0.02, 2),
    opacity: clamp(num(m.opacity, 1), 0, 1),
    rotation: clamp(num(m.rotation, 0), -360, 360),
    hidden: m.hidden === true,
    fit: m.fit === 'cover' ? 'cover' : 'contain',
    ...(expiresRaw > 0 ? { expiresAt: expiresRaw } : {}),
  };
}

function normText(input: unknown, base?: TextItem): TextItem | null {
  if (!input || typeof input !== 'object') return null;
  const t = { ...(base ?? {}), ...(input as Record<string, unknown>) } as Record<string, unknown>;
  const text = typeof t.text === 'string' ? t.text.slice(0, MAX_TEXT_LEN) : '';
  if (!text.trim()) return null;
  const id = typeof t.id === 'string' && t.id.length > 0 && t.id.length <= 64 ? t.id : newId('t_');
  const expiresRaw = num(t.expiresAt, 0);
  return {
    id,
    text,
    x: clamp(num(t.x, 0.5), -0.5, 1.5),
    y: clamp(num(t.y, 0.85), -0.5, 1.5),
    size: clamp(num(t.size, 0.06), 0.01, 0.25),
    color: safeColor(t.color, '#ffffff'),
    bg: safeBg(t.bg),
    opacity: clamp(num(t.opacity, 1), 0, 1),
    hidden: t.hidden === true,
    align: safeAlign(t.align),
    bold: t.bold === true,
    outline: t.outline !== false,
    ...(expiresRaw > 0 ? { expiresAt: expiresRaw } : {}),
  };
}

function safeStr(v: unknown, max: number, def = ''): string {
  return typeof v === 'string' ? v.slice(0, max) : def;
}

function widgetType(v: unknown): WidgetType {
  return WIDGET_TYPES.includes(v as WidgetType) ? (v as WidgetType) : 'clock';
}

function defaultData(type: WidgetType): Record<string, unknown> {
  switch (type) {
    case 'clock':
      return { format24: true, seconds: true, date: false };
    case 'timer':
      return { mode: 'countdown', duration: 300, running: false, remaining: 300, endsAt: 0, startedAt: 0, accumulated: 0, label: 'Таймер' };
    case 'counter':
      return { label: 'Счётчик', value: 0, step: 1 };
    case 'progress':
      return { label: 'Прогресс', value: 0, max: 100 };
    case 'goal':
      return { label: 'Цель сбора', current: 0, target: 1000, currency: '₽' };
    case 'random':
      return { title: 'Случайный выбор', items: [], result: '', pickedAt: 0 };
    case 'leaderboard':
      return { title: 'Таблица лидеров', entries: [] };
  }
}

function normWidgetData(type: WidgetType, raw: unknown): Record<string, unknown> {
  const base = defaultData(type);
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  switch (type) {
    case 'clock':
      return {
        format24: d.format24 !== false,
        seconds: d.seconds === true,
        date: d.date === true,
      };
    case 'timer': {
      const mode = d.mode === 'stopwatch' ? 'stopwatch' : 'countdown';
      const duration = clamp(num(d.duration, 300), 1, 86_400);
      const remaining = clamp(num(d.remaining, duration), 0, 86_400);
      return {
        mode,
        duration,
        running: d.running === true,
        remaining,
        endsAt: num(d.endsAt, 0),
        startedAt: num(d.startedAt, 0),
        accumulated: clamp(num(d.accumulated, 0), 0, 86_400),
        label: safeStr(d.label, 40, 'Таймер'),
      };
    }
    case 'counter':
      return {
        label: safeStr(d.label, 40, 'Счётчик'),
        value: Math.round(clamp(num(d.value, 0), -1_000_000, 1_000_000)),
        step: Math.round(clamp(num(d.step, 1), 1, 1000)),
      };
    case 'progress': {
      const max = clamp(num(d.max, 100), 1, 1_000_000);
      return {
        label: safeStr(d.label, 40, 'Прогресс'),
        value: clamp(num(d.value, 0), 0, max),
        max,
      };
    }
    case 'goal': {
      const target = clamp(num(d.target, 1000), 1, 1_000_000_000);
      return {
        label: safeStr(d.label, 40, 'Цель сбора'),
        current: clamp(num(d.current, 0), 0, 1_000_000_000),
        target,
        currency: safeStr(d.currency, 6, '₽') || '₽',
      };
    }
    case 'random': {
      const items = Array.isArray(d.items)
        ? d.items.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 60)).filter((x) => x.trim()).slice(0, MAX_RANDOM_ITEMS)
        : [];
      return {
        title: safeStr(d.title, 40, 'Случайный выбор'),
        items,
        result: safeStr(d.result, 60),
        pickedAt: num(d.pickedAt, 0),
      };
    }
    case 'leaderboard': {
      const entries: LeaderEntry[] = Array.isArray(d.entries)
        ? d.entries
            .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
            .map((e) => ({ name: safeStr(e.name, 40).trim(), score: Math.round(clamp(num(e.score, 0), -1_000_000, 1_000_000)) }))
            .filter((e) => e.name)
            .slice(0, MAX_LEADERS)
        : [];
      return { title: safeStr(d.title, 40, 'Таблица лидеров'), entries };
    }
  }
}

function normWidget(input: unknown, base?: Widget): Widget | null {
  if (!input || typeof input !== 'object') return null;
  const merged = { ...(base ?? {}), ...(input as Record<string, unknown>) } as Record<string, unknown>;
  const type = widgetType(merged.type);
  const id = typeof merged.id === 'string' && merged.id.length > 0 && merged.id.length <= 64 ? merged.id : newId('w_');
  const expiresRaw = num(merged.expiresAt, 0);
  // При смене типа данные сбрасываются к значениям по умолчанию.
  const dataRaw = base && base.type !== type ? undefined : merged.data;
  return {
    id,
    type,
    x: clamp(num(merged.x, 0.05), -0.5, 1.5),
    y: clamp(num(merged.y, 0.05), -0.5, 1.5),
    w: clamp(num(merged.w, 0.28), 0.06, 1.5),
    h: clamp(num(merged.h, 0.16), 0.05, 1.5),
    opacity: clamp(num(merged.opacity, 1), 0, 1),
    hidden: merged.hidden === true,
    color: safeColor(merged.color, '#7c6eff'),
    bg: safeBg(merged.bg) || 'rgba(12,15,22,0.82)',
    data: normWidgetData(type, dataRaw),
    ...(expiresRaw > 0 ? { expiresAt: expiresRaw } : {}),
  };
}

const NOTIFY_POSITIONS: NotifyPosition[] = [
  'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right',
];
const NOTIFY_ANIMATIONS: NotifyAnimation[] = ['slide', 'fade', 'pop', 'bounce'];
export const NOTIFY_TEMPLATES = ['default', 'success', 'warning', 'error', 'info', 'donation', 'follower', 'sub'];

export function normNotification(input: unknown): Notification | null {
  if (!input || typeof input !== 'object') return null;
  const n = input as Record<string, unknown>;
  const title = safeStr(n.title, 80).trim();
  const message = safeStr(n.message, 200).trim();
  if (!title && !message) return null;
  const id = typeof n.id === 'string' && n.id.length > 0 && n.id.length <= 64 ? n.id : newId('n_');
  return {
    id,
    title,
    message,
    template: NOTIFY_TEMPLATES.includes(n.template as string) ? (n.template as string) : 'default',
    position: NOTIFY_POSITIONS.includes(n.position as NotifyPosition) ? (n.position as NotifyPosition) : 'top-right',
    animation: NOTIFY_ANIMATIONS.includes(n.animation as NotifyAnimation) ? (n.animation as NotifyAnimation) : 'slide',
    duration: Math.round(clamp(num(n.duration, 5000), 1000, 20_000)),
    accent: safeColor(n.accent, '#7c6eff'),
    icon: safeStr(n.icon, 8),
  };
}

/** Применяет живую команду к виджету (мутирует data). false => неизвестная команда. */
function controlWidget(widget: Widget, op: string, ev: Record<string, unknown>): boolean {
  const d = widget.data;
  const now = Date.now();
  switch (widget.type) {
    case 'counter': {
      const step = num(d.step, 1);
      if (op === 'inc') d.value = num(d.value, 0) + step;
      else if (op === 'dec') d.value = num(d.value, 0) - step;
      else if (op === 'reset') d.value = 0;
      else if (op === 'set') d.value = num(ev.value, num(d.value, 0));
      else return false;
      return true;
    }
    case 'timer': {
      const mode = d.mode === 'stopwatch' ? 'stopwatch' : 'countdown';
      if (op === 'start') {
        if (d.running === true) return true;
        if (mode === 'countdown') {
          let remaining = num(d.remaining, num(d.duration, 300));
          if (remaining <= 0) remaining = num(d.duration, 300);
          d.remaining = remaining;
          d.endsAt = now + remaining * 1000;
        } else {
          d.startedAt = now;
        }
        d.running = true;
      } else if (op === 'pause') {
        if (d.running !== true) return true;
        if (mode === 'countdown') {
          d.remaining = clamp((num(d.endsAt, now) - now) / 1000, 0, 86_400);
          d.endsAt = 0;
        } else {
          d.accumulated = num(d.accumulated, 0) + clamp((now - num(d.startedAt, now)) / 1000, 0, 86_400);
          d.startedAt = 0;
        }
        d.running = false;
      } else if (op === 'reset') {
        d.running = false;
        d.remaining = num(d.duration, 300);
        d.endsAt = 0;
        d.startedAt = 0;
        d.accumulated = 0;
      } else {
        return false;
      }
      return true;
    }
    case 'progress': {
      const max = num(d.max, 100);
      if (op === 'set') d.value = clamp(num(ev.value, num(d.value, 0)), 0, max);
      else if (op === 'add') d.value = clamp(num(d.value, 0) + num(ev.amount, 0), 0, max);
      else return false;
      return true;
    }
    case 'goal': {
      if (op === 'set') d.current = clamp(num(ev.value, num(d.current, 0)), 0, 1_000_000_000);
      else if (op === 'add') d.current = clamp(num(d.current, 0) + num(ev.amount, 0), 0, 1_000_000_000);
      else return false;
      return true;
    }
    case 'random': {
      if (op !== 'pick') return false;
      const items = Array.isArray(d.items) ? (d.items as string[]) : [];
      if (!items.length) return false;
      d.result = items[Math.floor(Math.random() * items.length)];
      d.pickedAt = now;
      return true;
    }
    case 'leaderboard': {
      let entries: LeaderEntry[] = Array.isArray(d.entries) ? [...(d.entries as LeaderEntry[])] : [];
      if (op === 'clear') {
        entries = [];
      } else if (op === 'remove') {
        const name = safeStr(ev.name, 40).trim();
        entries = entries.filter((e) => e.name !== name);
      } else if (op === 'upsert' || op === 'bump') {
        const name = safeStr(ev.name, 40).trim();
        if (!name) return false;
        const existing = entries.find((e) => e.name === name);
        const score = op === 'bump'
          ? num(existing?.score, 0) + num(ev.score, 1)
          : num(ev.score, num(existing?.score, 0));
        if (existing) existing.score = Math.round(score);
        else entries.push({ name, score: Math.round(score) });
      } else {
        return false;
      }
      entries.sort((a, b) => b.score - a.score);
      d.entries = entries.slice(0, MAX_LEADERS);
      return true;
    }
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Хранилище                                                           */
/* ------------------------------------------------------------------ */

function emptyState(): RoomState {
  return { revision: 1, strokes: [], media: [], texts: [], widgets: [], updatedAt: Date.now() };
}

export class RoomStore {
  private states = new Map<string, RoomState>();
  private file: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'rooms.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, Partial<RoomState>>;
      for (const [roomId, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object') continue;
        this.states.set(roomId, {
          revision: num(value.revision, 1),
          strokes: Array.isArray(value.strokes)
            ? value.strokes.map(normStroke).filter((s): s is Stroke => !!s)
            : [],
          media: Array.isArray(value.media)
            ? value.media.map(normMedia).filter((m): m is MediaItem => !!m)
            : [],
          texts: Array.isArray(value.texts)
            ? value.texts.map((t) => normText(t)).filter((t): t is TextItem => !!t)
            : [],
          widgets: Array.isArray((value as Record<string, unknown>).widgets)
            ? ((value as Record<string, unknown>).widgets as unknown[])
                .map((w) => normWidget(w))
                .filter((w): w is Widget => !!w)
            : [],
          updatedAt: num(value.updatedAt, Date.now()),
        });
      }
    } catch {
      /* первый запуск */
    }
  }

  get(roomId: string): RoomState {
    let state = this.states.get(roomId);
    if (!state) {
      state = emptyState();
      this.states.set(roomId, state);
    }
    return state;
  }

  snapshot(roomId: string): RoomState {
    return structuredClone(this.get(roomId));
  }

  roomIds(): string[] {
    return [...this.states.keys()];
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 800);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const out: Record<string, RoomState> = {};
    for (const [roomId, state] of this.states) out[roomId] = state;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, this.file);
    } catch {
      /* не критично для работы */
    }
  }

  /** Удаляет просроченные картинки/тексты. Возвращает события для рассылки. */
  sweepExpired(roomId: string): RoomEvent[] {
    const state = this.get(roomId);
    const now = Date.now();
    const events: RoomEvent[] = [];
    state.media = state.media.filter((m) => {
      if (m.expiresAt && m.expiresAt <= now) {
        events.push({ t: 'media.remove', id: m.id });
        return false;
      }
      return true;
    });
    state.texts = state.texts.filter((t) => {
      if (t.expiresAt && t.expiresAt <= now) {
        events.push({ t: 'text.remove', id: t.id });
        return false;
      }
      return true;
    });
    state.widgets = state.widgets.filter((w) => {
      if (w.expiresAt && w.expiresAt <= now) {
        events.push({ t: 'widget.remove', id: w.id });
        return false;
      }
      return true;
    });
    if (events.length) {
      state.revision++;
      state.updatedAt = now;
      this.scheduleSave();
    }
    return events;
  }

  apply(roomId: string, raw: unknown, by: string): ApplyResult {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad_event' };
    const ev = raw as Record<string, unknown>;
    const type = ev.t;
    const state = this.get(roomId);

    const touch = (): void => {
      state.revision++;
      state.updatedAt = Date.now();
      this.scheduleSave();
    };

    switch (type) {
      case 'stroke.start': {
        const stroke = normStroke(ev.stroke);
        if (!stroke) return { ok: false, error: 'bad_stroke' };
        const existing = state.strokes.findIndex((s) => s.id === stroke.id);
        if (existing >= 0) state.strokes.splice(existing, 1);
        state.strokes.push(stroke);
        const resync = this.enforceStrokeLimits(state);
        touch();
        return { ok: true, event: { t: 'stroke.start', stroke }, resync };
      }

      case 'stroke.points': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const stroke = state.strokes.find((s) => s.id === id);
        if (!stroke) return { ok: false, error: 'no_stroke' };
        const points = normPoints(ev.points);
        if (!points.length) return { ok: false, error: 'no_points' };
        if (stroke.points.length >= MAX_POINTS_PER_STROKE) return { ok: false, error: 'stroke_full' };
        stroke.points.push(...points.slice(0, MAX_POINTS_PER_STROKE - stroke.points.length));
        touch();
        return { ok: true, event: { t: 'stroke.points', id, points } };
      }

      case 'stroke.end': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        if (!state.strokes.some((s) => s.id === id)) return { ok: false, error: 'no_stroke' };
        return { ok: true, event: { t: 'stroke.end', id } };
      }

      case 'stroke.undo': {
        const stroke = state.strokes.pop();
        if (!stroke) return { ok: false, error: 'empty' };
        touch();
        return { ok: true, event: { t: 'stroke.undo', id: stroke.id } };
      }

      case 'draw.clear': {
        if (!state.strokes.length) return { ok: false, error: 'empty' };
        state.strokes = [];
        touch();
        return { ok: true, event: { t: 'draw.clear' } };
      }

      case 'media.add': {
        const item = normMedia(ev.item);
        if (!item) return { ok: false, error: 'bad_media' };
        if (state.media.length >= MAX_MEDIA) {
          const removed = state.media.shift();
          if (removed) {
            state.media.push(item);
            touch();
            // Клиенты должны узнать об удалении — отдадим полный снапшот.
            return { ok: true, event: { t: 'media.add', item }, resync: true };
          }
        }
        state.media.push(item);
        touch();
        return { ok: true, event: { t: 'media.add', item } };
      }

      case 'media.update': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const index = state.media.findIndex((m) => m.id === id);
        if (index < 0) return { ok: false, error: 'no_media' };
        const merged = normMedia({ ...state.media[index], ...(ev.patch as object), id });
        if (!merged) return { ok: false, error: 'bad_media' };
        state.media[index] = merged;
        touch();
        return { ok: true, event: { t: 'media.update', item: merged } };
      }

      case 'media.remove': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const before = state.media.length;
        state.media = state.media.filter((m) => m.id !== id);
        if (state.media.length === before) return { ok: false, error: 'no_media' };
        touch();
        return { ok: true, event: { t: 'media.remove', id } };
      }

      case 'text.add': {
        const item = normText(ev.item);
        if (!item) return { ok: false, error: 'bad_text' };
        let resync = false;
        if (state.texts.length >= MAX_TEXTS) {
          state.texts.shift();
          // Удалённый текст нужно убрать у клиентов — отдадим полный снапшот.
          resync = true;
        }
        state.texts.push(item);
        touch();
        return { ok: true, event: { t: 'text.add', item }, resync };
      }

      case 'text.update': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const index = state.texts.findIndex((t) => t.id === id);
        if (index < 0) return { ok: false, error: 'no_text' };
        const merged = normText({ ...(ev.patch as object), id }, state.texts[index]);
        if (!merged) return { ok: false, error: 'bad_text' };
        state.texts[index] = merged;
        touch();
        return { ok: true, event: { t: 'text.update', item: merged } };
      }

      case 'text.remove': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const before = state.texts.length;
        state.texts = state.texts.filter((t) => t.id !== id);
        if (state.texts.length === before) return { ok: false, error: 'no_text' };
        touch();
        return { ok: true, event: { t: 'text.remove', id } };
      }

      case 'widget.add': {
        const item = normWidget(ev.item);
        if (!item) return { ok: false, error: 'bad_widget' };
        let resync = false;
        if (state.widgets.length >= MAX_WIDGETS) {
          state.widgets.shift();
          resync = true;
        }
        state.widgets.push(item);
        touch();
        return { ok: true, event: { t: 'widget.add', item }, resync };
      }

      case 'widget.update': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const index = state.widgets.findIndex((w) => w.id === id);
        if (index < 0) return { ok: false, error: 'no_widget' };
        const merged = normWidget({ ...(ev.patch as object), id }, state.widgets[index]);
        if (!merged) return { ok: false, error: 'bad_widget' };
        state.widgets[index] = merged;
        touch();
        return { ok: true, event: { t: 'widget.update', item: merged } };
      }

      case 'widget.control': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const index = state.widgets.findIndex((w) => w.id === id);
        if (index < 0) return { ok: false, error: 'no_widget' };
        const widget = state.widgets[index];
        const op = typeof ev.op === 'string' ? ev.op : '';
        if (!controlWidget(widget, op, ev)) return { ok: false, error: 'bad_control' };
        const normalized = normWidget(widget, widget);
        if (!normalized) return { ok: false, error: 'bad_widget' };
        state.widgets[index] = normalized;
        touch();
        return { ok: true, event: { t: 'widget.update', item: normalized } };
      }

      case 'widget.remove': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        const before = state.widgets.length;
        state.widgets = state.widgets.filter((w) => w.id !== id);
        if (state.widgets.length === before) return { ok: false, error: 'no_widget' };
        touch();
        return { ok: true, event: { t: 'widget.remove', id } };
      }

      case 'scene.clear': {
        const empty =
          !state.strokes.length && !state.media.length && !state.texts.length && !state.widgets.length;
        if (empty) return { ok: false, error: 'empty' };
        state.strokes = [];
        state.media = [];
        state.texts = [];
        state.widgets = [];
        touch();
        return { ok: true, event: { t: 'scene.clear' } };
      }

      default:
        return { ok: false, error: 'unknown_event' };
    }
  }

  private enforceStrokeLimits(state: RoomState): boolean {
    let resync = false;
    while (state.strokes.length > MAX_STROKES) {
      state.strokes.shift();
      resync = true;
    }
    let total = state.strokes.reduce((sum, s) => sum + s.points.length, 0);
    while (total > MAX_TOTAL_POINTS && state.strokes.length > 1) {
      const removed = state.strokes.shift();
      if (!removed) break;
      total -= removed.points.length;
      resync = true;
    }
    return resync;
  }
}
