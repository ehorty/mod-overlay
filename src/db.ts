import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizePerms, type Perm } from './perms';

export type Role = 'admin' | 'mod';

export interface UserRecord {
  id: string;
  login: string;
  passwordHash: string;
  role: Role;
  /** Отсутствие поля (legacy) означает полный доступ; массив задаёт точные права. */
  perms?: Perm[];
  createdAt: number;
  updatedAt: number;
}

export interface RoomRecord {
  id: string;
  name: string;
  overlayKey: string;
  createdAt: number;
}

export interface DbFile {
  version: 1;
  users: UserRecord[];
  rooms: RoomRecord[];
}

export function newId(prefix = ''): string {
  return prefix + crypto.randomBytes(9).toString('base64url');
}

export function newOverlayKey(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function emptyDb(): DbFile {
  return {
    version: 1,
    users: [],
    rooms: [
      {
        id: 'main',
        name: 'Основная комната',
        overlayKey: newOverlayKey(),
        createdAt: Date.now(),
      },
    ],
  };
}

export class Db {
  readonly file: string;
  data: DbFile;
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'db.json');
    this.data = this.load();
    this.saveNow();
  }

  private load(): DbFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return emptyDb();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<DbFile>;
      const db: DbFile = {
        version: 1,
        users: Array.isArray(parsed.users)
          ? parsed.users.filter(validUser).map((u) => ({ ...u, perms: normalizePerms(u.perms) }))
          : [],
        rooms: Array.isArray(parsed.rooms) ? parsed.rooms.filter(validRoom) : [],
      };
      if (!db.rooms.length) db.rooms = emptyDb().rooms;
      return db;
    } catch {
      // Битый файл — откладываем в сторону, чтобы не потерять данные безвозвратно.
      try {
        fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return emptyDb();
    }
  }

  saveNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.saveNow();
      } catch {
        /* повторим при следующем изменении */
      }
    }, 250);
    this.timer.unref?.();
  }

  findUserByLogin(login: string): UserRecord | undefined {
    const needle = login.trim().toLowerCase();
    return this.data.users.find((u) => u.login.toLowerCase() === needle);
  }

  findUserById(id: string): UserRecord | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  getRoom(id: string): RoomRecord | undefined {
    return this.data.rooms.find((r) => r.id === id);
  }

  getMainRoom(): RoomRecord {
    return this.data.rooms[0];
  }

  addUser(user: UserRecord): void {
    this.data.users.push(user);
    this.save();
  }

  removeUser(id: string): void {
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.save();
  }

  setPerms(id: string, perms: Perm[] | undefined): boolean {
    const user = this.findUserById(id);
    if (!user) return false;
    if (perms === undefined) delete user.perms;
    else user.perms = perms;
    this.save();
    return true;
  }

  countAdmins(): number {
    return this.data.users.filter((u) => u.role === 'admin').length;
  }

  rotateRoomKey(roomId: string): string {
    const room = this.getRoom(roomId);
    if (!room) throw new Error('room_not_found');
    room.overlayKey = newOverlayKey();
    this.save();
    return room.overlayKey;
  }
}

function validUser(value: unknown): value is UserRecord {
  if (!value || typeof value !== 'object') return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.id === 'string' &&
    typeof u.login === 'string' &&
    typeof u.passwordHash === 'string' &&
    (u.role === 'admin' || u.role === 'mod')
  );
}

function validRoom(value: unknown): value is RoomRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.overlayKey === 'string';
}
