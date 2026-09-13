import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Minimal `.env` loader (no dotenv dependency) for local dev, so API keys can
 * live in `server/.env` instead of the shell. Real environment variables always
 * win over the file, so shell/CI/Docker env is never overridden. In Docker the
 * file is passed via `--env-file`, so this is a no-op there.
 */
export function loadDotEnv(): void {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no server/.env — rely on process.env
  }
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
