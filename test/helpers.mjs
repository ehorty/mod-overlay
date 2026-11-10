import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../dist/server.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const ADMIN_LOGIN = 'admin';
export const ADMIN_PASSWORD = 'admin-pass-123';

export function makeTempDir(prefix = 'mod-overlay-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export async function request(base, pathname, options = {}) {
  const { method = 'GET', token, body, headers = {} } = options;
  const finalHeaders = { ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  let payload = body;
  const isMultipart = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isMultipart) {
    finalHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: finalHeaders,
    body: payload,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data };
}

export async function startTestServer(overrides = {}) {
  const dataDir = overrides.dataDir ?? makeTempDir();
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    publicDir: PUBLIC_DIR,
    adminLogin: ADMIN_LOGIN,
    adminPassword: ADMIN_PASSWORD,
    publicUrl: 'https://overlay.test',
    quiet: true,
    ...overrides,
  });

  const localUrl = `http://127.0.0.1:${running.port}`;

  const api = {
    running,
    dataDir,
    // running.url — внешний адрес (PUBLIC_URL), а запросы тестов идут напрямую.
    url: localUrl,
    publicUrl: running.url,
    port: running.port,
    async login(login = ADMIN_LOGIN, password = ADMIN_PASSWORD) {
      const result = await request(localUrl, '/api/login', {
        method: 'POST',
        body: { login, password },
      });
      if (result.status !== 200) throw new Error(`login failed: ${result.status} ${JSON.stringify(result.data)}`);
      return result.data;
    },
    async adminToken() {
      const data = await api.login();
      return data.token;
    },
    request(pathname, options) {
      return request(localUrl, pathname, options);
    },
    async cleanup() {
      await running.close();
      if (!overrides.keepDataDir) removeDir(dataDir);
    },
  };
  return api;
}

/**
 * Небольшая обёртка над ws: копит сообщения и умеет ждать нужное.
 */
export function openWs(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const listeners = new Set();
    let closeInfo = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      messages.push(msg);
      for (const listener of [...listeners]) listener(msg);
    });
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() };
    });

    const api = {
      ws,
      messages,
      get closeInfo() {
        return closeInfo;
      },
      waitFor(predicate, ms = timeout) {
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            listeners.delete(onMessage);
            rej(new Error('timeout waiting for ws message'));
          }, ms);
          const onMessage = (msg) => {
            if (!predicate(msg)) return;
            clearTimeout(timer);
            listeners.delete(onMessage);
            res(msg);
          };
          listeners.add(onMessage);
        });
      },
      waitClose(ms = timeout) {
        if (closeInfo) return Promise.resolve(closeInfo);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            ws.off('close', onClose);
            rej(new Error('timeout waiting for ws close'));
          }, ms);
          const onClose = (code, reason) => {
            clearTimeout(timer);
            res({ code, reason: reason.toString() });
          };
          ws.once('close', onClose);
        });
      },
      send(payload) {
        ws.send(JSON.stringify(payload));
      },
      close() {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };

    ws.once('open', () => resolve(api));
    ws.once('error', (error) => reject(error));
  });
}

export function wsUrl(base, search) {
  const url = new URL(base);
  url.protocol = 'ws:';
  url.pathname = '/ws';
  url.search = search;
  return url.toString();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
