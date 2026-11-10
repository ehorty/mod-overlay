import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  publicDir: string;
  jwtSecret: string;
  adminLogin: string;
  adminPassword?: string;
  /** Внешний адрес сервера (если стоит за reverse-proxy), например https://overlay.example.com */
  publicUrl?: string;
  /** Настройка Express «trust proxy»: loopback по умолчанию, 1 за одним прокси. */
  trustProxy: string | number | boolean;
  /** Yandex SpeechKit: API-ключ и folder_id. Без них голоса Яндекса не показываются. */
  yandexTtsKey?: string;
  yandexTtsFolder?: string;
  /** SteosVoice: токен из console.cybervoice.io/user. */
  steosVoiceToken?: string;
  steosVoiceApiUrl?: string;
}

function optionalEnv(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return value || undefined;
}

export type StartOverrides = Partial<AppConfig>;

/** Корень проекта: dist/.. => корень; в Electron __dirname указывает внутрь приложения. */
export const PROJECT_ROOT = path.resolve(__dirname, '..');

function readOrCreateSecret(dataDir: string): string {
  const file = path.join(dataDir, 'secret.key');
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  } catch {
    /* файла ещё нет */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function normalizePublicUrl(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_URL должен быть полным адресом, например https://overlay.example.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_URL должен начинаться с http:// или https://');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('PUBLIC_URL должен указывать на корень домена, без пути');
  }
  if (url.search || url.hash) {
    throw new Error('PUBLIC_URL не должен содержать параметры или якорь');
  }
  return url.origin;
}

function normalizePort(raw: unknown): number {
  const port = Number(raw ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT должен быть целым числом от 0 до 65535');
  }
  return port;
}

function normalizeTrustProxy(raw: string | undefined): string | number | boolean {
  const value = (raw ?? '').trim();
  if (!value) return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export function createConfig(over: StartOverrides = {}): AppConfig {
  const dataDir = path.resolve(over.dataDir ?? process.env.DATA_DIR ?? path.join(PROJECT_ROOT, 'data'));
  const publicDir = path.resolve(over.publicDir ?? process.env.PUBLIC_DIR ?? path.join(PROJECT_ROOT, 'public'));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'tts'), { recursive: true });

  return {
    host: over.host ?? process.env.HOST ?? '0.0.0.0',
    port: normalizePort(over.port ?? process.env.PORT ?? 3000),
    dataDir,
    publicDir,
    jwtSecret: over.jwtSecret ?? process.env.JWT_SECRET ?? readOrCreateSecret(dataDir),
    adminLogin: (over.adminLogin ?? process.env.ADMIN_LOGIN ?? 'admin').trim().toLowerCase(),
    adminPassword: over.adminPassword ?? process.env.ADMIN_PASSWORD,
    publicUrl: normalizePublicUrl(over.publicUrl ?? process.env.PUBLIC_URL),
    trustProxy: normalizeTrustProxy(process.env.TRUST_PROXY),
    yandexTtsKey: over.yandexTtsKey ?? optionalEnv(process.env.YANDEX_TTS_KEY),
    yandexTtsFolder: over.yandexTtsFolder ?? optionalEnv(process.env.YANDEX_TTS_FOLDER),
    steosVoiceToken: over.steosVoiceToken ?? optionalEnv(process.env.STEOSVOICE_TOKEN),
    steosVoiceApiUrl: over.steosVoiceApiUrl ?? optionalEnv(process.env.STEOSVOICE_API_URL),
  };
}
