/* Простой логгер с таймстампами. */
function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function log(...args: unknown[]): void {
  console.log(`[${stamp()}]`, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(`[${stamp()}] WARN`, ...args);
}

export function error(...args: unknown[]): void {
  console.error(`[${stamp()}] ERROR`, ...args);
}
