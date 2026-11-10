import os from 'node:os';
import 'dotenv/config';
import { startServer } from './server';
import { error, log } from './log';

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

interface CliOptions {
  port?: number;
  host?: string;
}

function parseCli(argv: string[]): CliOptions {
  const out: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log('Использование: node dist/index.js [--port 3000] [--host 0.0.0.0]');
      console.log('Также можно задать PORT и HOST в переменных окружения или в .env.');
      process.exit(0);
    }
    if (arg === '--port' || arg === '-p' || arg === '--host') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        error(`Не указано значение для ${arg}`);
        process.exit(1);
      }
      i += 1;
      if (arg === '--host') {
        out.host = value;
      } else {
        out.port = Number(value);
      }
      continue;
    }
    const portMatch = /^--port=(\d+)$/.exec(arg);
    if (portMatch) {
      out.port = Number(portMatch[1]);
      continue;
    }
    const hostMatch = /^--host=(.+)$/.exec(arg);
    if (hostMatch) {
      out.host = hostMatch[1];
      continue;
    }
    error(`Неизвестный аргумент: ${arg}. Используйте --help.`);
    process.exit(1);
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    error('Порт должен быть целым числом от 1 до 65535.');
    process.exit(1);
  }
  return out;
}

async function main(): Promise<void> {
  try {
    const cli = parseCli(process.argv.slice(2));
    const running = await startServer({ port: cli.port, host: cli.host });
    const { config } = running;
    const room = running.overlayUrl;

    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════╗');
    console.log('  ║                 MOD OVERLAY  ·  OBS                      ║');
    console.log('  ╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Панель модератора:  ${running.url}/panel/`);
    console.log(`  Оверлей для OBS:    ${room}`);
    if (running.adminPassword) {
      console.log('');
      console.log(`  Логин:  ${config.adminLogin}`);
      console.log(`  Пароль: ${running.adminPassword}`);
      console.log('  (пароль также сохранён в data/ADMIN_PASSWORD.txt — смените его после входа)');
    }
    const lan = lanAddresses();
    if (lan.length) {
      console.log('');
      console.log('  Для модераторов в локальной сети:');
      for (const ip of lan) console.log(`    http://${ip}:${running.port}/panel/`);
    }
    console.log('');
    console.log('  Ctrl+C — остановить сервер');
    console.log('');

    const shutdown = (): void => {
      log('Остановка сервера…');
      void running.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref?.();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      error(`Порт занят. Закройте другой экземпляр сервера или задайте другой PORT.`);
    } else {
      error('Не удалось запустить сервер:', err.message ?? e);
    }
    process.exit(1);
  }
}

void main();
