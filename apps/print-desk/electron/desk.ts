import type { CopyProgress, Settings, Units } from './shared.js';

/**
 * Print Desk in Zollify (modules/print-desk, apps/server/src/modules/print-desk.ts): the settings
 * every desk of an account shares, the status a desk reports, and the requests it takes.
 */

/** The shared settings as the server keeps them: one account's, so the per-account maps are flat. */
export interface SharedConfig {
  target?: number;
  sizeTargets?: Record<string, number>;
  itemTargets?: Record<string, number>;
  hidden?: string[];
  order?: string[];
  paperMaterials?: Record<string, string>;
  global?: Record<string, unknown> | null;
  addToStock?: boolean;
  units?: Units;
}
/** Kept per account here (Settings maps account id -> value), one account's value on the server. */
const PER_ACCOUNT = ['itemTargets', 'hidden', 'order'] as const;
const PLAIN = ['target', 'sizeTargets', 'paperMaterials', 'global', 'addToStock', 'units'] as const;

/** The shared settings in `patch`, as the server takes them; {} when it changes none. */
export function sharedOf(patch: Partial<Settings>, account: string): SharedConfig {
  const out: Record<string, unknown> = {};
  for (const k of PLAIN) if (patch[k] !== undefined) out[k] = patch[k];
  for (const k of PER_ACCOUNT) if (patch[k] !== undefined) out[k] = patch[k][account] ?? (k === 'itemTargets' ? {} : []);
  return out as SharedConfig;
}

/** The change to `settings` that takes on the server's shared settings for `account`. */
export function withShared(settings: Settings, account: string, config: SharedConfig): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of PLAIN) if (config[k] !== undefined) out[k] = config[k];
  for (const k of PER_ACCOUNT) if (config[k] !== undefined) out[k] = { ...settings[k], [account]: config[k] };
  return out as Partial<Settings>;
}

export interface DeskStatus {
  allowRemote?: boolean;
  printer?: string;
  counts: Record<string, number>;
  run: CopyProgress[];
  paper: Record<string, { needed: number; onHand: number | null }>;
  busy?: string;
  error?: string;
}
const cut = (s: string | undefined, n: number): string | undefined => (s ? s.slice(0, n) : undefined);
/** A status report within what the server takes: counts over 0, long messages cut short. */
export function statusReport(s: DeskStatus): DeskStatus {
  return {
    ...(s.printer ? { printer: cut(s.printer, 200) } : {}),
    counts: Object.fromEntries(Object.entries(s.counts).filter(([, n]) => n > 0).map(([k, n]) => [k, Math.min(999, Math.floor(n))])),
    run: s.run.slice(0, 500).map((p) => ({ ...p, status: cut(p.status, 300) ?? '' })),
    paper: s.paper,
    ...(s.busy ? { busy: cut(s.busy, 200) } : {}),
    ...(s.error ? { error: cut(s.error, 500) } : {}),
  };
}

export interface DeskRequest {
  id: string;
  kind: 'counts' | 'print';
  payload: { counts?: Record<string, number>; onlySize?: string };
}
