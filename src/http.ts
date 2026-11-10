import path from 'node:path';
import crypto from 'node:crypto';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { AppConfig } from './config';
import { Db, Role, UserRecord, newId } from './db';
import { AuthService, AuthUser, hashPassword, publicUser } from './auth';
import { RoomStore } from './state';
import { TtsService } from './tts';
import { Hub } from './hub';
import { log, warn } from './log';

interface HttpContext {
  config: AppConfig;
  db: Db;
  auth: AuthService;
  rooms: RoomStore;
  tts: TtsService;
  hub: Hub;
}

interface AuthedRequest extends Request {
  user?: AuthUser;
}

const LOGIN_RE = /^[a-z0-9_.-]{3,32}$/;
const VERSION = '0.1.0';

const clamp01 = (value: unknown, fallback = 1): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

function kindFor(mime: string): 'image' | 'audio' | 'video' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

function baseUrl(req: Request, config: AppConfig): string {
  return config.publicUrl ?? `${req.protocol}://${req.get('host')}`;
}

function overlayUrl(req: Request, config: AppConfig, roomId: string, key: string): string {
  return `${baseUrl(req, config)}/overlay/?room=${encodeURIComponent(roomId)}&key=${encodeURIComponent(key)}`;
}

export function createApp(ctx: HttpContext): express.Express {
  const { config, db, auth, rooms, tts, hub } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(express.json({ limit: '128kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https: http:",
        "media-src 'self' data: blob: https: http:",
        "connect-src 'self' ws: wss:",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /* ------------------------------- auth ---------------------------------- */

  const requireAuth: RequestHandler = (req: AuthedRequest, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = auth.verify(token);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.user = user;
    next();
  };

  const requireAdmin: RequestHandler = (req: AuthedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };

  function currentUser(req: AuthedRequest): UserRecord | undefined {
    return req.user ? db.findUserById(req.user.id) : undefined;
  }

  /* ------------------------------- uploads ------------------------------- */

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, path.join(config.dataDir, 'uploads')),
    filename: (_req, file, cb) => {
      const ext = (file as unknown as { storedExt?: string }).storedExt ?? '.bin';
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = MIME_EXT[file.mimetype.toLowerCase()];
      const kind = kindFor(file.mimetype.toLowerCase());
      if (!ext || !kind) {
        cb(new Error('bad_file_type'));
        return;
      }
      (file as unknown as { storedExt?: string }).storedExt = ext;
      (file as unknown as { kind?: string }).kind = kind;
      cb(null, true);
    },
  });

  /* -------------------------------- routes ------------------------------- */

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), version: VERSION });
  });

  app.post('/api/login', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const login = typeof body.login === 'string' ? body.login : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = req.ip ?? 'unknown';
    const result = await auth.login(login, password, ip);
    if (!result.ok) {
      const status = result.error === 'rate_limited' ? 429 : 401;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json({ token: result.token, user: result.user });
  });

  app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ user: publicUser(user) });
  });

  app.post('/api/me/password', requireAuth, async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user) return void res.status(401).json({ error: 'unauthorized' });
    const body = req.body as Record<string, unknown>;
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';
    if (next.length < 8) return void res.status(400).json({ error: 'weak_password' });
    if (!(await auth.verifyPassword(user.id, current))) {
      return void res.status(403).json({ error: 'wrong_password' });
    }
    await auth.setPassword(user.id, next);
    const updated = db.findUserById(user.id);
    // Старый токен становится недействительным — сразу выдаём новый.
    res.json({
      ok: true,
      token: updated ? auth.sign(updated) : undefined,
      user: updated ? publicUser(updated) : undefined,
    });
  });

  app.get('/api/bootstrap', requireAuth, (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user) return void res.status(401).json({ error: 'unauthorized' });
    const room = db.getMainRoom();
    const state = rooms.snapshot(room.id);
    res.json({
      user: publicUser(user),
      room: {
        id: room.id,
        name: room.name,
        overlayKey: room.overlayKey,
        overlayUrl: overlayUrl(req, config, room.id, room.overlayKey),
      },
      state,
      users: user.role === 'admin' ? db.data.users.map(publicUser) : undefined,
      version: VERSION,
    });
  });

  app.get('/api/voices', requireAuth, async (_req, res) => {
    const voices = await tts.listVoices();
    res.json({ voices });
  });

  /* -------------------------------- TTS ---------------------------------- */

  const ttsBusy = new Set<string>();
  let ttsActive = 0;

  app.post('/api/tts', requireAuth, async (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user) return void res.status(401).json({ error: 'unauthorized' });

    const body = req.body as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return void res.status(400).json({ error: 'empty_text' });
    if (text.length > 500) return void res.status(400).json({ error: 'text_too_long' });
    const preview = body.preview === true;
    if (ttsBusy.has(user.id)) return void res.status(429).json({ error: 'tts_busy' });
    if (ttsActive >= 4) return void res.status(429).json({ error: 'tts_busy' });

    ttsBusy.add(user.id);
    ttsActive++;
    try {
      const room = db.getMainRoom();
      const result = await tts.say(text, body.voice, body.rate, body.pitch);
      if (!preview) {
        const volume = clamp01(body.volume);
        hub.broadcast(room.id, {
          t: 'tts',
          url: result.url,
          text,
          voice: typeof body.voice === 'string' ? body.voice : undefined,
          volume,
          duration: result.duration,
          by: user.id,
          ts: Date.now(),
        });
      }
      res.json({ url: result.url, duration: result.duration });
    } catch (e) {
      warn('TTS ошибка:', (e as Error)?.message ?? e);
      res.status(502).json({ error: 'tts_failed' });
    } finally {
      ttsBusy.delete(user.id);
      ttsActive--;
    }
  });

  app.post('/api/tts/stop', requireAuth, (req: AuthedRequest, res) => {
    const user = currentUser(req);
    if (!user) return void res.status(401).json({ error: 'unauthorized' });
    hub.broadcast(db.getMainRoom().id, { t: 'tts.stop', by: user.id, ts: Date.now() });
    res.json({ ok: true });
  });

  /* ------------------------------- uploads ------------------------------- */

  app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    const kind = (file as unknown as { kind?: string }).kind ?? 'image';
    res.json({
      url: `/media/uploads/${file.filename}`,
      kind,
      name: file.originalname,
      size: file.size,
      mime: file.mimetype,
    });
  });

  /* ------------------------------- users --------------------------------- */

  app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
    res.json({ users: db.data.users.map(publicUser) });
  });

  app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const login = String(body.login ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const role: Role = body.role === 'admin' ? 'admin' : 'mod';
    if (!LOGIN_RE.test(login)) return void res.status(400).json({ error: 'bad_login' });
    if (password.length < 8) return void res.status(400).json({ error: 'weak_password' });
    if (db.findUserByLogin(login)) return void res.status(409).json({ error: 'login_exists' });

    const now = Date.now();
    const user: UserRecord = {
      id: newId('u_'),
      login,
      passwordHash: await hashPassword(password),
      role,
      createdAt: now,
      updatedAt: now,
    };
    db.addUser(user);
    log(`Создан пользователь ${login} (${role})`);
    res.status(201).json({ user: publicUser(user) });
  });

  app.delete('/api/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    if (id === req.user?.id) return void res.status(400).json({ error: 'cannot_delete_self' });
    const target = db.findUserById(id);
    if (!target) return void res.status(404).json({ error: 'not_found' });
    if (target.role === 'admin' && db.countAdmins() <= 1) {
      return void res.status(400).json({ error: 'last_admin' });
    }
    db.removeUser(id);
    log(`Удалён пользователь ${target.login}`);
    res.json({ ok: true });
  });

  app.post('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const password = String(body.password ?? '');
    if (password.length < 8) return void res.status(400).json({ error: 'weak_password' });
    const ok = await auth.setPassword(String(req.params.id), password);
    if (!ok) return void res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  app.post('/api/room/rotate-key', requireAuth, requireAdmin, (req, res) => {
    const room = db.getMainRoom();
    const key = db.rotateRoomKey(room.id);
    log('Ключ оверлея обновлён');
    res.json({ overlayKey: key, overlayUrl: overlayUrl(req, config, room.id, key) });
  });

  /* ------------------------------- static -------------------------------- */

  app.use('/media/uploads', express.static(path.join(config.dataDir, 'uploads'), {
    maxAge: '30d',
    immutable: true,
    index: false,
    dotfiles: 'ignore',
  }));
  app.use('/media/tts', express.static(path.join(config.dataDir, 'tts'), {
    maxAge: '1h',
    index: false,
    dotfiles: 'ignore',
  }));

  app.get('/', (_req, res) => res.redirect('/panel/'));
  app.use(express.static(config.publicDir, { index: 'index.html', extensions: ['html'] }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // Ошибки: multer, парсер JSON и обычные.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof multer.MulterError) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'file_too_large' : 'upload_failed',
        message: err.code,
      });
      return;
    }
    const message = (err as Error)?.message ?? 'error';
    if (message === 'bad_file_type') {
      res.status(415).json({ error: 'bad_file_type' });
      return;
    }
    const status = Number((err as { status?: number; statusCode?: number })?.status ??
      (err as { statusCode?: number })?.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? 'too_large' : 'bad_request' });
      return;
    }
    warn('HTTP ошибка:', message);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
