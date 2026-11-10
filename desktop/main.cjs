'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Удобно для автотестов и переносимых сборок: своя папка данных Electron.
if (process.env.MO_USERDATA) {
  app.setPath('userData', path.resolve(process.env.MO_USERDATA));
}

const APP_ROOT = app.getAppPath();
const LOCAL_HOST = '127.0.0.1';
const DEFAULT_PORT = 3111;
const MAX_PORT_TRIES = 20;

let cfg = null;
let running = null;
let firstRunPassword = '';
let serverError = '';
let panelWin = null;
let setupWin = null;
let quitting = false;

/* ------------------------------- утилиты -------------------------------- */

function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}

function defaultConfig() {
  return { mode: 'local', localPort: DEFAULT_PORT, serverUrl: '', window: null };
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultConfig(),
      ...parsed,
      mode: parsed.mode === 'remote' ? 'remote' : 'local',
      localPort: Number(parsed.localPort) || DEFAULT_PORT,
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
    };
  } catch {
    return null;
  }
}

function saveConfig() {
  if (!cfg) return;
  try {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    logLine('Не удалось сохранить настройки: ' + errorText(err));
  }
}

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    console.log(line.trimEnd());
  } catch {
    /* ignore */
  }
  try {
    const file = path.join(app.getPath('userData'), 'desktop.log');
    fs.appendFileSync(file, line, 'utf8');
    const size = fs.statSync(file).size;
    if (size > 512 * 1024) fs.writeFileSync(file, line, 'utf8');
  } catch {
    /* ignore */
  }
}

function errorText(err) {
  if (!err) return 'Неизвестная ошибка';
  if (err.code === 'EADDRINUSE') return 'Порт уже занят другой программой.';
  return String(err.message || err);
}

function normalizeServerUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return { error: 'Укажите адрес сервера.' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: 'Адрес выглядит некорректно. Пример: https://overlay.example.com' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'Адрес должен начинаться с http:// или https://' };
  }
  const base = url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
  return { url: base };
}

function sameOrigin(target, base) {
  try {
    return new URL(target).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function dataDirPath() {
  if (process.env.MO_DATA_DIR) return path.resolve(process.env.MO_DATA_DIR);
  if (running) return running.config.dataDir;
  return path.join(app.getPath('userData'), 'data');
}

function panelUrl() {
  if (!cfg) return '';
  if (cfg.mode === 'remote') return `${cfg.serverUrl}/panel/`;
  return running ? `${running.url}/panel/` : '';
}

function statusPayload() {
  return {
    config: cfg
      ? { mode: cfg.mode, localPort: cfg.localPort, serverUrl: cfg.serverUrl }
      : defaultConfig(),
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    running: running
      ? { url: running.url, overlayUrl: running.overlayUrl, port: running.port }
      : null,
    adminPassword: firstRunPassword || '',
    adminLogin: (running && running.config && running.config.adminLogin) || 'admin',
    dataDir: dataDirPath(),
    error: serverError || '',
    logFile: path.join(app.getPath('userData'), 'desktop.log'),
  };
}

/* -------------------------------- сервер -------------------------------- */

async function ensureServer() {
  if (running) return running;
  const { startServer } = require(path.join(APP_ROOT, 'dist', 'server.js'));

  let port = Number(process.env.MO_PORT) || cfg.localPort || DEFAULT_PORT;
  const started = Number(port);
  let lastError = null;

  for (let attempt = 0; attempt < MAX_PORT_TRIES; attempt += 1) {
    try {
      running = await startServer({
        host: LOCAL_HOST,
        port,
        dataDir: dataDirPath(),
        publicDir: path.join(APP_ROOT, 'public'),
        quiet: true,
      });
      break;
    } catch (err) {
      lastError = err;
      if (err && err.code === 'EADDRINUSE') {
        port += 1;
        continue;
      }
      throw err;
    }
  }

  if (!running) {
    throw lastError || new Error('Не удалось запустить локальный сервер.');
  }

  if (Number(cfg.localPort) !== running.port) {
    cfg.localPort = running.port;
    saveConfig();
  }
  if (started !== running.port) {
    logLine(`Порт ${started} занят, сервер запущен на ${running.port}.`);
  }
  if (running.adminPassword) {
    firstRunPassword = running.adminPassword;
    logLine('Создан администратор. Пароль сохранён в ADMIN_PASSWORD.txt.');
  }
  logLine(`Локальный сервер: ${running.url}`);
  return running;
}

async function stopServer() {
  if (!running) return;
  const current = running;
  running = null;
  try {
    await current.close();
    logLine('Локальный сервер остановлен.');
  } catch (err) {
    logLine('Ошибка остановки сервера: ' + errorText(err));
  }
}

async function restartServer() {
  if (!cfg || cfg.mode !== 'local') return { ok: false, error: 'Локальный режим выключен.' };
  await stopServer();
  // Даём ОС освободить порт, чтобы ссылка для OBS не поменялась.
  await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    await ensureServer();
    await openPanel();
    buildMenu();
    return { ok: true, state: statusPayload() };
  } catch (err) {
    serverError = errorText(err);
    return { ok: false, error: serverError, state: statusPayload() };
  }
}

/* -------------------------------- окна ---------------------------------- */

function preloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function windowIcon() {
  const icon = path.join(__dirname, 'icon.png');
  return fs.existsSync(icon) ? icon : undefined;
}

function setupUrl() {
  return path.join(__dirname, 'setup.html');
}

function clampBounds(bounds) {
  if (!bounds || typeof bounds.width !== 'number') return null;
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.max(1100, Math.min(4000, Math.round(bounds.width)));
  const height = Math.max(720, Math.min(3000, Math.round(bounds.height)));
  let x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : area.x + Math.round((area.width - width) / 2);
  let y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : area.y + Math.round((area.height - height) / 2);
  x = Math.max(area.x - 40, Math.min(x, area.x + area.width - width + 40));
  y = Math.max(area.y - 20, Math.min(y, area.y + area.height - height + 20));
  return { width, height, x, y };
}

async function openPanel() {
  const target = panelUrl();
  if (!target) {
    createSetupWindow('Сервер ещё не запущен.');
    return { ok: false, error: 'Сервер ещё не запущен.' };
  }

  if (panelWin && !panelWin.isDestroyed()) {
    try {
      await panelWin.loadURL(target);
      panelWin.show();
      panelWin.focus();
      return { ok: true };
    } catch (err) {
      logLine('Не удалось открыть панель: ' + errorText(err));
      return { ok: false, error: errorText(err) };
    }
  }

  const saved = clampBounds(cfg && cfg.window);
  panelWin = new BrowserWindow({
    width: saved ? saved.width : 1440,
    height: saved ? saved.height : 900,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0d12',
    title: 'Mod Overlay — панель модератора',
    icon: windowIcon(),
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  panelWin.once('ready-to-show', () => {
    panelWin.show();
    panelWin.focus();
  });

  panelWin.on('close', () => {
    if (!cfg || !panelWin) return;
    try {
      cfg.window = panelWin.getBounds();
      saveConfig();
    } catch {
      /* ignore */
    }
  });

  panelWin.on('closed', () => {
    panelWin = null;
  });

  panelWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  panelWin.webContents.on('will-navigate', (event, url) => {
    const allowed = cfg.mode === 'remote' ? cfg.serverUrl : running?.url;
    if (allowed && !sameOrigin(url, allowed)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  panelWin.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    logLine(`Панель не загрузилась (${code}): ${description}`);
    if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
    createSetupWindow('Не удалось открыть панель. Проверьте адрес сервера.');
  });

  try {
    await panelWin.loadURL(target);
  } catch (err) {
    logLine('Не удалось загрузить панель: ' + errorText(err));
    serverError = errorText(err);
    createSetupWindow(serverError);
    return { ok: false, error: serverError };
  }
  return { ok: true };
}

function closeSetupWindow() {
  if (setupWin && !setupWin.isDestroyed()) {
    const win = setupWin;
    setupWin = null;
    win.close();
  }
}

function createSetupWindow(errorMessage) {
  if (errorMessage) serverError = errorMessage;
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    setupWin.webContents.send('desktop:refresh');
    return setupWin;
  }

  setupWin = new BrowserWindow({
    width: 780,
    height: 780,
    minWidth: 640,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Mod Overlay — настройка',
    icon: windowIcon(),
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  setupWin.setMenuBarVisibility(false);
  setupWin.once('ready-to-show', () => {
    setupWin.show();
    setupWin.focus();
  });
  setupWin.on('closed', () => {
    setupWin = null;
  });
  setupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  setupWin.loadFile(setupUrl());
  return setupWin;
}

/* ------------------------------- горячие клавиши и меню ------------------ */

function copyOverlayLink() {
  if (!running) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Ссылка для OBS',
      message: 'Локальный сервер не запущен.',
      detail: 'Откройте настройки и запустите сервер, либо используйте ссылку из вкладки «Админ» в панели.',
    });
    return;
  }
  clipboard.writeText(running.overlayUrl);
  try {
    new Notification({
      title: 'Ссылка для OBS скопирована',
      body: running.overlayUrl,
      silent: true,
    }).show();
  } catch {
    /* уведомления могут быть отключены */
  }
}

function openDataFolder() {
  const dir = dataDirPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  shell.openPath(dir).catch((err) => logLine('Не удалось открыть папку: ' + errorText(err)));
}

function showFirstPassword() {
  const file = path.join(dataDirPath(), 'ADMIN_PASSWORD.txt');
  let detail = 'Файл с паролем первого входа не найден.';
  try {
    detail = fs.readFileSync(file, 'utf8');
  } catch {
    /* ignore */
  }
  dialog.showMessageBox({
    type: 'info',
    title: 'Пароль администратора',
    message: 'Данные для первого входа',
    detail,
  });
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: 'О программе',
    message: 'Mod Overlay',
    detail:
      `Версия ${app.getVersion()}\n\n` +
      'Оверлей для OBS: рисунок, картинки, текст, озвучка и звуки.\n' +
      'Панель модератора работает в этом приложении и в браузере.',
    buttons: ['OK'],
  });
}

function buildMenu() {
  const isLocal = cfg && cfg.mode === 'local';
  const template = [
    {
      label: 'Файл',
      submenu: [
        { label: 'Настройки…', accelerator: 'CmdOrCtrl+,', click: () => createSetupWindow() },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Сервер',
      submenu: [
        { label: 'Открыть панель', accelerator: 'CmdOrCtrl+Shift+P', click: () => openPanel() },
        {
          label: 'Открыть панель в браузере',
          click: () => {
            const url = panelUrl();
            if (url) shell.openExternal(url).catch(() => {});
          },
        },
        { type: 'separator' },
        { label: 'Скопировать ссылку для OBS', enabled: Boolean(isLocal && running), click: copyOverlayLink },
        { label: 'Показать папку с данными', click: openDataFolder },
        { label: 'Пароль первого входа', click: showFirstPassword },
        { type: 'separator' },
        { label: 'Перезапустить локальный сервер', enabled: Boolean(isLocal), click: () => restartServer() },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'forceReload', label: 'Перезагрузить без кэша' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' },
      ],
    },
    {
      label: 'Справка',
      submenu: [{ label: 'О программе', click: showAbout }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --------------------------------- IPC ---------------------------------- */

function registerIpc() {
  ipcMain.handle('desktop:get-state', () => statusPayload());

  ipcMain.handle('desktop:apply', async (_event, input) => {
    if (!cfg) cfg = defaultConfig();
    const mode = input && input.mode === 'remote' ? 'remote' : 'local';

    let serverUrl = '';
    if (mode === 'remote') {
      const result = normalizeServerUrl(input && input.serverUrl);
      if (result.error) return { ok: false, error: result.error };
      serverUrl = result.url;
    }

    if (input && input.localPort) {
      const port = Number(input.localPort);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return { ok: false, error: 'Порт должен быть числом от 1024 до 65535.' };
      }
      cfg.localPort = port;
    }

    cfg.mode = mode;
    cfg.serverUrl = serverUrl;
    serverError = '';
    saveConfig();

    try {
      if (mode === 'local') {
        // Если пользователь выбрал другой порт, поднимаем сервер заново.
        if (running && running.port !== cfg.localPort) {
          await stopServer();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        await ensureServer();
      } else {
        await stopServer();
      }
    } catch (err) {
      serverError = errorText(err);
      logLine('Ошибка запуска сервера: ' + serverError);
      return { ok: false, error: serverError, state: statusPayload() };
    }

    saveConfig();
    buildMenu();
    const opened = await openPanel();
    if (!opened.ok && !serverError) {
      return { ok: false, error: 'Не удалось открыть панель.', state: statusPayload() };
    }
    // Закрываем окно настройки после ответа IPC, чтобы не рвать вызов на полуслове.
    setTimeout(closeSetupWindow, 60);
    return { ok: true, state: statusPayload() };
  });

  ipcMain.handle('desktop:open-panel', async () => {
    const result = await openPanel();
    if (result.ok) setTimeout(closeSetupWindow, 60);
    return result;
  });

  ipcMain.handle('desktop:open-external', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Недопустимый адрес.' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('desktop:copy', (_event, text) => {
    if (typeof text !== 'string' || text.length > 4096) return { ok: false };
    clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle('desktop:open-data', () => {
    openDataFolder();
    return { ok: true };
  });

  ipcMain.handle('desktop:restart', () => restartServer());
}

/* ------------------------------ запуск ---------------------------------- */

async function boot() {
  cfg = readConfig();
  buildMenu();

  if (!cfg) {
    createSetupWindow();
    return;
  }

  if (cfg.mode === 'remote') {
    const result = normalizeServerUrl(cfg.serverUrl);
    if (result.error) {
      createSetupWindow(result.error);
      return;
    }
    cfg.serverUrl = result.url;
    saveConfig();
    await openPanel();
    return;
  }

  try {
    await ensureServer();
    await openPanel();
  } catch (err) {
    serverError = errorText(err);
    logLine('Не удалось запустить локальный сервер: ' + serverError);
    createSetupWindow(serverError);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = panelWin && !panelWin.isDestroyed() ? panelWin : setupWin;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    boot().catch((err) => {
      serverError = errorText(err);
      logLine('Критическая ошибка запуска: ' + serverError);
      createSetupWindow(serverError);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting || !running) return;
    event.preventDefault();
    quitting = true;
    stopServer().finally(() => app.quit());
  });
}
