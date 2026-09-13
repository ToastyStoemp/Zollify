import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Minimal `.env` loader (no dotenv dependency) for local dev, so API keys can
 * live in `server/.env` instead of the shell. Real environment variables always
 * win over the file, so shell/CI/Docker env is never overridden. In Docker the
 * file is passed via `--env-file`, so this is a no-op there.
 */
export function loadDotEnv(dir = process.cwd()): void {
  // Resolved against the running app's directory, not this file's. In ZollTool
  // the loader lived inside the server itself so a module-relative path worked;
  // here it is a shared package, and that path would look for apps/server's
  // .env inside packages/server-core.
  const candidates = [
    join(dir, '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  ];

  let raw: string | undefined;
  for (const path of candidates) {
    try {
      raw = readFileSync(path, 'utf8');
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (raw === undefined) return; // no .env — rely on process.env
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
