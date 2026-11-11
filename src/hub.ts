import crypto from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppConfig } from './config';
import { Db } from './db';
import { AuthService, AuthUser } from './auth';
import { RoomStore, RoomEvent, FanoutEvent, normNotification } from './state';
import { EventLog, FeedAction } from './events';
import { SoundStore } from './sounds';
import { hasPerm, permForEvent, resolvePerms } from './perms';
import { log, warn } from './log';

type Role = 'mod' | 'overlay';

interface Client {
  id: string;
  ws: WebSocket;
  role: Role;
  roomId: string;
  user?: AuthUser;
  /** Ключ, с которым подключился оверлей: после смены ключа соединение закрывается. */
  overlayKey?: string;
  alive: boolean;
  tokens: number;
  lastRefill: number;
}

interface HubContext {
  server: HttpServer;
  config: AppConfig;
  db: Db;
  auth: AuthService;
  rooms: RoomStore;
  events: EventLog;
  sounds: SoundStore;
}

const SOUND_PRESETS = new Set(['beep', 'buzzer', 'whoosh', 'drum', 'horn', 'pop']);
const FX_KINDS = new Set(['flash', 'shake', 'confetti']);
const CAPACITY = 400;
const REFILL_PER_SEC = 200;

const FX_LABELS: Record<string, string> = {
  flash: 'вспышка',
  shake: 'тряска',
  confetti: 'конфетти',
};
const PRESET_LABELS: Record<string, string> = {
  beep: 'бип',
  buzzer: 'баззер',
  whoosh: 'вжух',
  drum: 'дробь',
  horn: 'гудок',
  pop: 'поп',
};
const WIDGET_LABELS: Record<string, string> = {
  clock: 'часы',
  timer: 'таймер',
  counter: 'счётчик',
  progress: 'прогресс',
  goal: 'цель сбора',
  random: 'случайный выбор',
  leaderboard: 'лидеры',
};

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, 2000);
  if (!s) return null;
  if (s.startsWith('/media/')) return s;
  return /^https?:\/\//i.test(s) ? s : null;
}

function keyEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class Hub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout;
  private sweeper: NodeJS.Timeout;
  private lastDraw = new Map<string, number>();

  constructor(private readonly ctx: HubContext) {
    this.wss = new WebSocketServer({
      server: ctx.server,
      path: '/ws',
      maxPayload: 512 * 1024,
      perMessageDeflate: false,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', (e) => warn('WebSocket:', (e as Error).message));

    ctx.events.onRecord = (roomId, entry) => this.broadcastMods(roomId, { t: 'event', entry });

    this.heartbeat = setInterval(() => this.tick(), 30_000);
    this.heartbeat.unref?.();

    this.sweeper = setInterval(() => this.sweep(), 2000);
    this.sweeper.unref?.();
  }

  /* ----------------------------- connections ---------------------------- */

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      ws.close(4400, 'bad_request');
      return;
    }

    const role: Role = url.searchParams.get('role') === 'overlay' ? 'overlay' : 'mod';
    const roomId = (url.searchParams.get('room') || 'main').slice(0, 32);
    const room = this.ctx.db.getRoom(roomId);
    if (!room) {
      ws.close(4404, 'no_room');
      return;
    }

    let user: AuthUser | undefined;
    let overlayKey: string | undefined;
    if (role === 'overlay') {
      const key = url.searchParams.get('key') ?? '';
      if (!key || !keyEquals(key, room.overlayKey)) {
        ws.close(4401, 'bad_key');
        return;
      }
      overlayKey = key;
    } else {
      const token = url.searchParams.get('token') ?? '';
      const verified = this.ctx.auth.verify(token);
      if (!verified) {
        ws.close(4401, 'bad_token');
        return;
      }
      user = verified;
    }

    const now = Date.now();
    const client: Client = {
      id: crypto.randomUUID(),
      ws,
      role,
      roomId,
      user,
      overlayKey,
      alive: true,
      tokens: CAPACITY,
      lastRefill: now,
    };
    this.clients.add(client);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.onMessage(client, data.toString());
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.broadcastPresence(roomId);
    });
    ws.on('error', () => {
      /* close придёт следом */
    });

    this.send(client, {
      t: 'hello',
      role,
      clientId: client.id,
      roomId,
      serverTime: now,
      state: this.ctx.rooms.snapshot(roomId),
      me: user
        ? { id: user.id, login: user.login, role: user.role, perms: this.resolvePermsFor(user.id) }
        : null,
    });
    this.broadcastPresence(roomId);
    log(`WS ${role === 'mod' ? `модератор ${user?.login}` : 'оверлей'} подключился (комната ${roomId}, всего ${this.clients.size})`);
  }

  private resolvePermsFor(userId: string) {
    const record = this.ctx.db.findUserById(userId);
    return record ? resolvePerms(record) : [];
  }

  /* ------------------------------- messages ----------------------------- */

  private rateOk(client: Client): boolean {
    const now = Date.now();
    const elapsed = (now - client.lastRefill) / 1000;
    client.lastRefill = now;
    client.tokens = Math.min(CAPACITY, client.tokens + elapsed * REFILL_PER_SEC);
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  /** Пользователь удалён или сменил пароль — сессия больше не действительна. */
  private modAuthorized(client: Client): boolean {
    if (client.role !== 'mod' || !client.user) return false;
    const user = this.ctx.db.findUserById(client.user.id);
    return Boolean(user) && user!.updatedAt === client.user.ver;
  }

  /** Ключ оверлея мог быть перевыпущен — старое подключение закрываем. */
  private overlayAuthorized(client: Client): boolean {
    if (client.role !== 'overlay' || !client.overlayKey) return false;
    const room = this.ctx.db.getRoom(client.roomId);
    return Boolean(room) && keyEquals(client.overlayKey, room!.overlayKey);
  }

  private authorized(client: Client): boolean {
    return client.role === 'overlay' ? this.overlayAuthorized(client) : this.modAuthorized(client);
  }

  private onMessage(client: Client, raw: string): void {
    if (!this.authorized(client)) {
      try {
        client.ws.close(4401, 'auth_changed');
      } catch {
        /* ignore */
      }
      return;
    }
    if (!this.rateOk(client)) return;

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg.t;
    if (type === 'ping') {
      this.send(client, { t: 'pong', ts: Date.now() });
      return;
    }
    if (type === 'state.request') {
      this.send(client, { t: 'state', state: this.ctx.rooms.snapshot(client.roomId), ts: Date.now() });
      return;
    }
    if (client.role === 'overlay') return;

    const typeStr = typeof type === 'string' ? type : '';
    const needed = permForEvent(typeStr);
    if (needed) {
      const record = client.user ? this.ctx.db.findUserById(client.user.id) : undefined;
      if (!record || !hasPerm(record, needed)) {
        this.send(client, { t: 'error', code: 'forbidden', perm: needed });
        return;
      }
    }

    switch (type) {
      case 'sound': {
        const preset = typeof msg.preset === 'string' && SOUND_PRESETS.has(msg.preset) ? msg.preset : null;
        const url = safeMediaUrl(msg.url);
        if (!preset && !url) return this.send(client, { t: 'error', code: 'bad_sound' });
        this.emit(client, {
          t: 'sound',
          ...(preset ? { preset } : { url }),
          volume: Math.max(0, Math.min(1, Number(msg.volume ?? 1))),
          queue: msg.queue !== false,
        });
        const label = preset
          ? PRESET_LABELS[preset] ?? preset
          : this.ctx.sounds.list().find((s) => s.url === url)?.name ?? 'звук';
        this.activity(client, 'sound', `звук: ${label}`);
        return;
      }

      case 'sound.stop':
      case 'sound.clearQueue': {
        this.emit(client, { t: typeStr });
        this.activity(client, 'sound', typeStr === 'sound.stop' ? 'остановил звук' : 'очистил очередь звуков');
        return;
      }

      case 'fx': {
        const kind = typeof msg.kind === 'string' && FX_KINDS.has(msg.kind) ? msg.kind : null;
        if (!kind) return this.send(client, { t: 'error', code: 'bad_fx' });
        this.emit(client, { t: 'fx', kind });
        this.activity(client, 'fx', `эффект: ${FX_LABELS[kind] ?? kind}`);
        return;
      }

      case 'tts.fallback': {
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
        if (!text) return;
        this.emit(client, { t: 'tts.fallback', text, volume: Math.max(0, Math.min(1, Number(msg.volume ?? 1))) });
        this.activity(client, 'tts', `озвучка: «${text.slice(0, 60)}»`);
        return;
      }

      case 'notify': {
        const item = normNotification(msg.item);
        if (!item) return this.send(client, { t: 'error', code: 'bad_notify' });
        this.emit(client, { t: 'notify', item });
        this.activity(client, 'notify', `уведомление: «${(item.title || item.message).slice(0, 60)}»`);
        return;
      }

      default: {
        const result = this.ctx.rooms.apply(client.roomId, msg, client.id);
        if (!result.ok) {
          this.send(client, { t: 'error', code: result.error });
          return;
        }
        this.broadcast(client.roomId, { ...result.event, by: client.id, ts: Date.now() } as FanoutEvent);
        if (result.resync) {
          this.broadcast(client.roomId, {
            t: 'state',
            state: this.ctx.rooms.snapshot(client.roomId),
            by: 'server',
            ts: Date.now(),
          } as FanoutEvent);
        }
        this.sceneActivity(client, typeStr, result.event, msg);
      }
    }
  }

  /** Запись в ленту событий от имени модератора. */
  private activity(client: Client, action: FeedAction, detail: string): void {
    this.ctx.events.record(client.roomId, {
      by: client.user?.id ?? 'server',
      login: client.user?.login ?? 'server',
      action,
      detail,
    });
  }

  /** Записывает значимые действия со сценой, отсекая шум (перетаскивание, точки штриха). */
  private sceneActivity(client: Client, type: string, event: RoomEvent, msg: Record<string, unknown>): void {
    switch (type) {
      case 'stroke.start': {
        const now = Date.now();
        const last = this.lastDraw.get(client.id) ?? 0;
        if (now - last < 1500) return;
        this.lastDraw.set(client.id, now);
        this.activity(client, 'draw', 'рисует на экране');
        return;
      }
      case 'draw.clear':
        this.activity(client, 'draw', 'стёр рисунок');
        return;
      case 'media.add':
        this.activity(client, 'media', 'добавил медиа на экран');
        return;
      case 'media.remove':
        this.activity(client, 'media', 'убрал медиа с экрана');
        return;
      case 'text.add': {
        const text = event.t === 'text.add' ? event.item.text : '';
        this.activity(client, 'text', `текст: «${text.slice(0, 60)}»`);
        return;
      }
      case 'text.remove':
        this.activity(client, 'text', 'убрал текст');
        return;
      case 'widget.add': {
        const wtype = event.t === 'widget.add' ? event.item.type : '';
        this.activity(client, 'widgets', `виджет: ${WIDGET_LABELS[wtype] ?? wtype}`);
        return;
      }
      case 'widget.remove':
        this.activity(client, 'widgets', 'убрал виджет');
        return;
      case 'widget.control': {
        const op = typeof msg.op === 'string' ? msg.op : '';
        this.activity(client, 'widgets', `виджет: ${op}`);
        return;
      }
      case 'scene.clear':
        this.activity(client, 'clear', 'очистил весь экран');
        return;
      default:
        return;
    }
  }

  private emit(client: Client, event: Record<string, unknown>): void {
    this.broadcast(client.roomId, { ...event, by: client.id, ts: Date.now() } as unknown as FanoutEvent);
  }

  /* ------------------------------- sending ------------------------------ */

  private send(client: Client, payload: unknown): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      client.ws.send(JSON.stringify(payload));
    } catch {
      /* соединение уже закрывается */
    }
  }

  broadcast(roomId: string, event: RoomEvent | FanoutEvent | Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.roomId !== roomId) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      try {
        client.ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  /** Рассылка только модераторам комнаты (лента событий, права). */
  private broadcastMods(roomId: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.roomId !== roomId || client.role !== 'mod') continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      try {
        client.ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  /** Права пользователя изменены — сообщаем его подключённым клиентам. */
  notifyUserPerms(userId: string): void {
    const perms = this.resolvePermsFor(userId);
    for (const client of this.clients) {
      if (client.role !== 'mod' || client.user?.id !== userId) continue;
      this.send(client, { t: 'perms', perms });
    }
  }

  private broadcastPresence(roomId: string): void {
    let mods = 0;
    let overlays = 0;
    for (const client of this.clients) {
      if (client.roomId !== roomId) continue;
      if (client.role === 'mod') mods++;
      else overlays++;
    }
    this.broadcast(roomId, { t: 'presence', mods, overlays, ts: Date.now() });
  }

  private tick(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        this.clients.delete(client);
        continue;
      }
      if (!this.authorized(client)) {
        try {
          client.ws.close(4401, 'auth_changed');
        } catch {
          /* ignore */
        }
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  private sweep(): void {
    for (const roomId of this.ctx.rooms.roomIds()) {
      const events = this.ctx.rooms.sweepExpired(roomId);
      for (const event of events) {
        this.broadcast(roomId, { ...event, by: 'server', ts: Date.now() } as FanoutEvent);
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'server_shutdown');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.wss.close();
  }
}
