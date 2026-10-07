import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { ModuleProblems } from './problems';

/**
 * What the host's deploy script left behind (apps/server/deploy.sh writes
 * `status` into the bind-mounted deploy directory): whether the last update
 * worked and whether its database backup did. The server owner's account
 * hears about a failure under Settings, Problems, like any other.
 */

export interface DeployStatus {
  state: 'ok' | 'failed';
  step: string;
  backup: 'ok' | 'failed' | 'skipped';
  at: number;
}

/** A request the host never picked up after this long means nothing is watching for it. */
export const REQUEST_STALE_MS = 15 * 60_000;

/** Reads the script's key=value lines; null when it is not a status we know. */
export function parseDeployStatus(text: string): DeployStatus | null {
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (kv.state !== 'ok' && kv.state !== 'failed') return null;
  const at = Number(kv.at) * 1000;
  return {
    state: kv.state,
    step: /^[a-z]{1,20}$/.test(kv.step ?? '') ? kv.step! : 'unknown',
    backup: kv.backup === 'ok' || kv.backup === 'failed' ? kv.backup : 'skipped',
    at: Number.isFinite(at) ? at : 0,
  };
}

/**
 * Turns the status files into problems on the server owner's account (the
 * `owner` role is the server's). A success of the same source closes them.
 * Never throws.
 */
export function checkDeployStatus(db: Database.Database, deployDir: string, problems: ModuleProblems, now = Date.now()): void {
  try {
    const owners = (db.prepare("SELECT DISTINCT accountId FROM users WHERE role = 'owner'").all() as { accountId: string }[]).map((r) => r.accountId);
    let status: DeployStatus | null = null;
    try {
      status = parseDeployStatus(readFileSync(join(deployDir, 'status'), 'utf8'));
    } catch {
      /* no deploy has run yet, or none is wired */
    }
    let waiting = false;
    try {
      waiting = now - statSync(join(deployDir, 'requested')).mtimeMs > REQUEST_STALE_MS;
    } catch {
      /* nothing requested */
    }
    const link = '/settings?panel=core.admin';
    for (const accountId of owners) {
      if (status?.state === 'failed') problems.report(accountId, { kind: 'server.update', key: 'deploy', severity: 'error', message: 'The last server update failed', detail: `It stopped at the "${status.step}" step. Check journalctl -u zollify-deploy on the host.`, link });
      else if (status?.state === 'ok') problems.resolve(accountId, 'server.update', 'deploy');
      if (status?.backup === 'failed') problems.report(accountId, { kind: 'server.backup', key: 'deploy', severity: 'error', message: 'The last database backup before an update failed', detail: 'The update went ahead without a restore point. Check disk space on the host.', link });
      else if (status?.backup === 'ok') problems.resolve(accountId, 'server.backup', 'deploy');
      if (waiting) problems.report(accountId, { kind: 'server.update', key: 'requested', severity: 'warning', message: 'The update button was pressed but the host never started it', detail: 'Is zollify-deploy.path enabled on the host?', link });
      else problems.resolve(accountId, 'server.update', 'requested');
    }
  } catch {
    /* a status check must never be a problem itself */
  }
}
