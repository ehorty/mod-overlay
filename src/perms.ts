import type { Role } from './db';

/** Возможности модератора. Администратор всегда имеет все права. */
export const PERMS = [
  'draw',
  'media',
  'text',
  'tts',
  'sound',
  'fx',
  'widgets',
  'notify',
  'clear',
] as const;

export type Perm = (typeof PERMS)[number];

export const ALL_PERMS: Perm[] = [...PERMS];

const PERM_SET = new Set<string>(PERMS);

export interface PermLabels {
  id: Perm;
  label: string;
}

/** Подписи для интерфейса (русский). */
export const PERM_LABELS: PermLabels[] = [
  { id: 'draw', label: 'Рисование' },
  { id: 'media', label: 'Медиа' },
  { id: 'text', label: 'Текст' },
  { id: 'tts', label: 'Озвучка (TTS)' },
  { id: 'sound', label: 'Звуки' },
  { id: 'fx', label: 'Эффекты' },
  { id: 'widgets', label: 'Виджеты' },
  { id: 'notify', label: 'Уведомления' },
  { id: 'clear', label: 'Очистка экрана' },
];

/** Приводит произвольный ввод к списку прав. undefined => полный доступ (legacy). */
export function normalizePerms(input: unknown): Perm[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: Perm[] = [];
  for (const value of input) {
    if (typeof value === 'string' && PERM_SET.has(value) && !out.includes(value as Perm)) {
      out.push(value as Perm);
    }
  }
  return out;
}

/** Эффективные права пользователя: админ и legacy-записи без поля имеют всё. */
export function resolvePerms(user: { role: Role; perms?: Perm[] }): Perm[] {
  if (user.role === 'admin') return ALL_PERMS;
  return Array.isArray(user.perms) ? user.perms : ALL_PERMS;
}

export function hasPerm(user: { role: Role; perms?: Perm[] }, perm: Perm): boolean {
  return resolvePerms(user).includes(perm);
}

/** Право, необходимое для события WebSocket. null => право не требуется. */
export function permForEvent(type: string): Perm | null {
  if (type.startsWith('stroke.') || type === 'draw.clear') return 'draw';
  if (type.startsWith('media.')) return 'media';
  if (type.startsWith('text.')) return 'text';
  if (type.startsWith('widget.')) return 'widgets';
  if (type === 'sound' || type === 'sound.stop' || type === 'sound.clearQueue') return 'sound';
  if (type === 'fx') return 'fx';
  if (type === 'tts.fallback') return 'tts';
  if (type === 'notify') return 'notify';
  if (type === 'scene.clear') return 'clear';
  return null;
}