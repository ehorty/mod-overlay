import fs from 'node:fs';
import path from 'node:path';
import { newId } from './db';

export interface Sound {
  id: string;
  name: string;
  url: string;
  category: string;
  favorite: boolean;
  hotkey: string;
  order: number;
  createdAt: number;
}

const MAX_SOUNDS = 200;
const MAX_NAME = 60;
const MAX_CATEGORY = 30;
const DEFAULT_CATEGORY = 'Общее';

function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 2000);
  if (!s) return null;
  if (s.startsWith('/media/')) return s;
  return /^https?:\/\//i.test(s) ? s : null;
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '';
  return s || fallback;
}

function cleanCategory(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().slice(0, MAX_CATEGORY) : '';
  return s || DEFAULT_CATEGORY;
}

/** Горячая клавиша: одна буква/цифра или F1–F12, в нижнем регистре. */
export function cleanHotkey(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  if (/^[a-z0-9]$/.test(s)) return s;
  if (/^f([1-9]|1[0-2])$/.test(s)) return s;
  return '';
}

function validSound(value: unknown): Sound | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  const url = safeUrl(s.url);
  if (!url) return null;
  return {
    id: typeof s.id === 'string' && s.id ? s.id : newId('snd_'),
    name: cleanName(s.name, 'Звук'),
    url,
    category: cleanCategory(s.category),
    favorite: s.favorite === true,
    hotkey: cleanHotkey(s.hotkey),
    order: typeof s.order === 'number' && Number.isFinite(s.order) ? s.order : 0,
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
  };
}

/** Библиотека звуков комнаты, хранится в sounds.json. */
export class SoundStore {
  private file: string;
  private sounds: Sound[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'sounds.json');
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        this.sounds = parsed.map(validSound).filter((s): s is Sound => !!s).slice(0, MAX_SOUNDS);
        this.sounds.forEach((s, i) => {
          if (!Number.isFinite(s.order)) s.order = i;
        });
        this.sort();
      }
    } catch {
      /* первый запуск */
    }
  }

  private sort(): void {
    this.sounds.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 250);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.sounds));
      fs.renameSync(tmp, this.file);
    } catch {
      /* не критично */
    }
  }

  list(): Sound[] {
    return this.sounds.map((s) => ({ ...s }));
  }

  get(id: string): Sound | undefined {
    return this.sounds.find((s) => s.id === id);
  }

  /** Создаёт звук; при совпадении url возвращает существующий (идемпотентный импорт). */
  add(input: Record<string, unknown>): { sound: Sound; created: boolean } {
    const url = safeUrl(input.url);
    if (!url) throw new Error('bad_url');
    const existing = this.sounds.find((s) => s.url === url);
    if (existing) return { sound: { ...existing }, created: false };
    if (this.sounds.length >= MAX_SOUNDS) throw new Error('limit');
    const maxOrder = this.sounds.reduce((m, s) => Math.max(m, s.order), -1);
    const sound: Sound = {
      id: newId('snd_'),
      name: cleanName(input.name, 'Звук'),
      url,
      category: cleanCategory(input.category),
      favorite: input.favorite === true,
      hotkey: this.takeHotkey(cleanHotkey(input.hotkey), ''),
      order: maxOrder + 1,
      createdAt: Date.now(),
    };
    this.sounds.push(sound);
    this.save();
    return { sound: { ...sound }, created: true };
  }

  /** Освобождает горячую клавишу, занятую другим звуком. */
  private takeHotkey(hotkey: string, exceptId: string): string {
    if (!hotkey) return '';
    for (const s of this.sounds) {
      if (s.id !== exceptId && s.hotkey === hotkey) s.hotkey = '';
    }
    return hotkey;
  }

  update(id: string, patch: Record<string, unknown>): Sound | null {
    const sound = this.get(id);
    if (!sound) return null;
    if ('name' in patch) sound.name = cleanName(patch.name, sound.name);
    if ('category' in patch) sound.category = cleanCategory(patch.category);
    if ('favorite' in patch) sound.favorite = patch.favorite === true;
    if ('hotkey' in patch) sound.hotkey = this.takeHotkey(cleanHotkey(patch.hotkey), id);
    if ('url' in patch) {
      const url = safeUrl(patch.url);
      if (url) sound.url = url;
    }
    this.save();
    return { ...sound };
  }

  remove(id: string): boolean {
    const before = this.sounds.length;
    this.sounds = this.sounds.filter((s) => s.id !== id);
    if (this.sounds.length === before) return false;
    this.save();
    return true;
  }

  /** Перестановка: ids задаёт новый порядок; отсутствующие остаются в конце. */
  reorder(ids: unknown): Sound[] {
    if (!Array.isArray(ids)) return this.list();
    const rank = new Map<string, number>();
    ids.forEach((id, i) => {
      if (typeof id === 'string') rank.set(id, i);
    });
    let next = rank.size;
    for (const s of this.sounds) {
      s.order = rank.has(s.id) ? (rank.get(s.id) as number) : next++;
    }
    this.sort();
    this.save();
    return this.list();
  }
}