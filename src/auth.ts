import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Db, Role, UserRecord, newId } from './db';
import { log, warn } from './log';

export interface PublicUser {
  id: string;
  login: string;
  role: Role;
  createdAt: number;
}

export interface AuthUser {
  id: string;
  login: string;
  role: Role;
  /** Метка версии сессии: совпадает с updatedAt пользователя. */
  ver: number;
}

export interface AuthOptions {
  adminLogin?: string;
  adminPassword?: string;
}

interface Attempt {
  count: number;
  first: number;
  blockedUntil: number;
}

const MAX_ATTEMPTS = 15;
const ATTEMPT_WINDOW = 10 * 60 * 1000;
const BLOCK_TIME = 10 * 60 * 1000;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function publicUser(user: UserRecord): PublicUser {
  return { id: user.id, login: user.login, role: user.role, createdAt: user.createdAt };
}

export class AuthService {
  readonly generatedPassword?: string;
  private attempts = new Map<string, Attempt>();
  private readonly dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    options: AuthOptions = {},
  ) {
    this.generatedPassword = this.ensureAdmin(options);
  }

  private ensureAdmin(options: AuthOptions): string | undefined {
    if (this.db.data.users.length > 0) return undefined;

    const password =
      (options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '').trim() ||
      crypto.randomBytes(9).toString('base64url');
    const login = (options.adminLogin ?? process.env.ADMIN_LOGIN ?? 'admin').trim().toLowerCase();

    // Хеширование синхронное только при первом запуске.
    const passwordHash = bcrypt.hashSync(password, 10);
    const now = Date.now();
    this.db.data.users.push({
      id: newId('u_'),
      login,
      passwordHash,
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });
    this.db.saveNow();

    const note =
      `Первичный администратор\n` +
      `Логин:  ${login}\n` +
      `Пароль: ${password}\n` +
      `Смените пароль после первого входа (кнопка «Профиль»).\n`;
    try {
      fs.writeFileSync(path.join(path.dirname(this.db.file), 'ADMIN_PASSWORD.txt'), note, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      /* не критично */
    }
    log(note.trim());
    return password;
  }

  private checkRate(ip: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry) return true;
    if (entry.blockedUntil > now) return false;
    if (now - entry.first > ATTEMPT_WINDOW) {
      this.attempts.delete(ip);
      return true;
    }
    return entry.count < MAX_ATTEMPTS;
  }

  private registerFailure(ip: string): void {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now - entry.first > ATTEMPT_WINDOW) {
      this.attempts.set(ip, { count: 1, first: now, blockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.blockedUntil = now + BLOCK_TIME;
      warn(`Слишком много попыток входа с ${ip}, вход заблокирован на 10 минут`);
    }
  }

  sign(user: UserRecord): string {
    return jwt.sign({ login: user.login, role: user.role, ver: user.updatedAt }, this.secret, {
      subject: user.id,
      expiresIn: '24h',
    });
  }

  verify(token: string | undefined | null): AuthUser | null {
    if (!token) return null;
    try {
      const payload = jwt.verify(token, this.secret) as jwt.JwtPayload;
      if (!payload.sub) return null;
      const user = this.db.findUserById(payload.sub);
      if (!user) return null;
      // Пароль сменили или пользователя пересоздали — старые токены больше не действуют.
      if (payload.ver !== user.updatedAt) return null;
      return { id: user.id, login: user.login, role: user.role, ver: user.updatedAt };
    } catch {
      return null;
    }
  }

  async login(
    loginRaw: string,
    password: string,
    ip: string,
  ): Promise<{ ok: true; token: string; user: PublicUser } | { ok: false; error: string }> {
    if (!this.checkRate(ip)) return { ok: false, error: 'rate_limited' };

    const login = String(loginRaw ?? '').trim().toLowerCase();
    if (!login || !password) return { ok: false, error: 'invalid_credentials' };

    const user = this.db.findUserByLogin(login);
    if (!user) {
      // Сравнение с фиктивным хешем, чтобы не выдавать существование логина по времени ответа.
      await bcrypt.compare(password, this.dummyHash);
      this.registerFailure(ip);
      return { ok: false, error: 'invalid_credentials' };
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      this.registerFailure(ip);
      return { ok: false, error: 'invalid_credentials' };
    }
    this.attempts.delete(ip);
    return { ok: true, token: this.sign(user), user: publicUser(user) };
  }

  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const user = this.db.findUserById(userId);
    if (!user) return false;
    return bcrypt.compare(password, user.passwordHash);
  }

  async setPassword(userId: string, password: string): Promise<boolean> {
    const user = this.db.findUserById(userId);
    if (!user) return false;
    user.passwordHash = await hashPassword(password);
    // Гарантируем смену версии даже при двух изменениях в одну миллисекунду.
    user.updatedAt = Math.max(Date.now(), user.updatedAt + 1);
    this.db.save();
    return true;
  }
}
