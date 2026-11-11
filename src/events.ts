import { newId } from './db';

/** Категория действия для ленты событий. */
export type FeedAction =
  | 'draw'
  | 'media'
  | 'text'
  | 'tts'
  | 'sound'
  | 'fx'
  | 'widgets'
  | 'notify'
  | 'clear';

export interface FeedEntry {
  id: string;
  ts: number;
  roomId: string;
  /** Идентификатор пользователя (или 'server'). */
  by: string;
  login: string;
  action: FeedAction;
  detail: string;
}

export interface FeedInput {
  by: string;
  login: string;
  action: FeedAction;
  detail: string;
}

const MAX_ENTRIES = 400;

/**
 * Кольцевой буфер действий модераторов. Не персистится: лента живёт в памяти
 * и переживает переподключения клиентов в рамках запуска сервера.
 */
export class EventLog {
  private entries: FeedEntry[] = [];
  /** Подписчик (hub) рассылает новую запись модераторам комнаты. */
  onRecord?: (roomId: string, entry: FeedEntry) => void;

  record(roomId: string, input: FeedInput): FeedEntry {
    const entry: FeedEntry = {
      id: newId('e_'),
      ts: Date.now(),
      roomId,
      by: input.by,
      login: input.login,
      action: input.action,
      detail: String(input.detail ?? '').slice(0, 160),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.onRecord?.(roomId, entry);
    return entry;
  }

  /** Последние записи комнаты, от старых к новым. */
  list(roomId: string, limit = 120): FeedEntry[] {
    const capped = Math.max(1, Math.min(MAX_ENTRIES, Math.floor(limit) || 120));
    return this.entries.filter((e) => e.roomId === roomId).slice(-capped);
  }

  clear(roomId: string): void {
    this.entries = this.entries.filter((e) => e.roomId !== roomId);
  }
}