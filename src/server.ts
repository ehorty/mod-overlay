import http from 'node:http';
import path from 'node:path';
import { AppConfig, StartOverrides, createConfig } from './config';
import { Db } from './db';
import { AuthService } from './auth';
import { RoomStore } from './state';
import { TtsService } from './tts';
import { Hub } from './hub';
import { createApp } from './http';
import { log } from './log';

export interface StartOptions extends StartOverrides {
  quiet?: boolean;
}

export interface RunningServer {
  host: string;
  port: number;
  url: string;
  overlayUrl: string;
  config: AppConfig;
  adminPassword?: string;
  close: () => Promise<void>;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = createConfig(opts);
  const db = new Db(config.dataDir);
  const auth = new AuthService(db, config.jwtSecret, {
    adminLogin: config.adminLogin,
    adminPassword: config.adminPassword,
  });
  const rooms = new RoomStore(config.dataDir);
  const tts = new TtsService(path.join(config.dataDir, 'tts'), undefined, {
    yandexKey: config.yandexTtsKey,
    yandexFolder: config.yandexTtsFolder,
    steosToken: config.steosVoiceToken,
    steosApiUrl: config.steosVoiceApiUrl,
  });

  const server = http.createServer();
  const hub = new Hub({ server, config, db, auth, rooms });
  server.on('request', createApp({ config, db, auth, rooms, tts, hub }));

  const cleanup = setInterval(() => tts.cleanup(), 30 * 60 * 1000);
  cleanup.unref?.();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
  } catch (e) {
    clearInterval(cleanup);
    hub.close();
    throw e;
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const hostForUrl = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const base = config.publicUrl ?? `http://${hostForUrl}:${port}`;
  const room = db.getMainRoom();
  const overlayUrl = `${base}/overlay/?room=${encodeURIComponent(room.id)}&key=${encodeURIComponent(room.overlayKey)}`;

  if (!opts.quiet) {
    log(`Сервер запущен: ${base} (порт ${port})`);
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(cleanup);
    hub.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(() => resolve(), 1500).unref?.();
      server.closeAllConnections?.();
    });
    rooms.flush();
    db.saveNow();
  };

  return {
    host: config.host,
    port,
    url: base,
    overlayUrl,
    config,
    adminPassword: auth.generatedPassword,
    close,
  };
}
