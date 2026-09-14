import { authFetch } from '../session';
import { deviceFlavor, deviceId, deviceName } from './device';

/**
 * In-memory ring buffer of console warnings/errors, uncaught exceptions and
 * explicit breadcrumbs — uploaded to the server on request (This device, or
 * right from a failed-payment screen) so a register without a usable USB or
 * ADB connection can still get diagnostics to whoever is investigating.
 * Ported from ZollTool.
 */

const MAX_ENTRIES = 500;
interface LogEntry {
  ts: number;
  level: 'log' | 'warn' | 'error';
  message: string;
}
const buffer: LogEntry[] = [];

function stringify(v: unknown): string {
  if (v instanceof Error) return `${v.message}\n${v.stack ?? ''}`;
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
function push(level: LogEntry['level'], args: unknown[]): void {
  buffer.push({ ts: Date.now(), level, message: args.map(stringify).join(' ') });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

let installed = false;
/** Call once at startup — patches console.warn/error and catches uncaught errors. */
export function installDiagnostics(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = { warn: console.warn.bind(console), error: console.error.bind(console) };
  console.warn = (...args: unknown[]) => {
    push('warn', args);
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push('error', args);
    original.error(...args);
  };
  window.addEventListener('error', (e) => push('error', [`Uncaught: ${e.message}`, (e.error as Error | undefined)?.stack ?? '']));
  window.addEventListener('unhandledrejection', (e) => push('error', ['Unhandled rejection:', e.reason]));
}

/** Breadcrumb for call sites worth capturing even when nothing throws. */
export function logDiagnostic(message: string): void {
  push('log', [message]);
}

export function diagnosticLogText(): string {
  return buffer.map((e) => `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} ${e.message}`).join('\n');
}

/** Uploads the buffered log to the server; throws on failure. */
export async function sendDiagnosticLog(reason?: string): Promise<void> {
  await authFetch('/logs', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: await deviceId(),
      deviceName: await deviceName(),
      flavor: deviceFlavor(),
      appVersion: typeof __ZOLLIFY_VERSION__ === 'string' ? __ZOLLIFY_VERSION__ : undefined,
      reason,
      log: diagnosticLogText() || '(no diagnostic entries recorded)',
    }),
  });
}

declare const __ZOLLIFY_VERSION__: string | undefined;
