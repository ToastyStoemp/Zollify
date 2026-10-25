import Dexie, { type EntityTable } from 'dexie';
import { reactive } from 'vue';
import { openCoreDb } from './db';
import { getAccount } from '../session';

/**
 * Videos a customer display plays while no sale is on - the booth's art on
 * a screen. When the till sends a cart they either keep playing under it or
 * pause and give it the screen, and they carry on once the sale is done.
 *
 * Kept on this device only, in a database of their own: video files are
 * large, have to play with no connection at a convention, and never sync,
 * go into a backup or count against the account's storage on the server.
 * Each display device gets its own, added once. Erasing the account's data
 * on the device takes them too (the database is named after the account).
 */

export interface DisplayVideo {
  id: string;
  name: string;
  type: string;
  size: number;
  /** Play order, lowest first. */
  order: number;
  addedAt: number;
  blob: Blob;
}
export type DisplayVideoInfo = Omit<DisplayVideo, 'blob'>;

/** When a cart comes in: keep playing under it, or pause and let the cart have the screen. */
export type DisplayVideoMode = 'overlay' | 'swap';

export interface DisplayVideoPrefs {
  /** Play the videos at all; off keeps them stored but shows the logo as before. */
  enabled: boolean;
  mode: DisplayVideoMode;
  /** How much the video is darkened under the cart, 0 to 80 percent. */
  dimPct: number;
  /** What it is darkened with - black, or a colour that suits the art. */
  dimColor: string;
  /** The cart panel's background, text and total; empty follows the app's light or dark look. */
  panelBg: string;
  panelText: string;
  totalColor: string;
}

const PREFS_KEY = 'core.displayVideos';
export const DIM_MAX_PCT = 80;
const DEFAULT_PREFS: DisplayVideoPrefs = { enabled: true, mode: 'overlay', dimPct: 45, dimColor: '#000000', panelBg: '', panelText: '', totalColor: '' };
const HEX = /^#[0-9a-f]{6}$/i;

/** A colour as stored: `#rrggbb`, or empty for the app's own. Anything else is dropped. */
function colour(value: unknown, fallback: string): string {
  return typeof value === 'string' && (value === '' || HEX.test(value)) ? value.toLowerCase() : fallback;
}

/** `#rrggbb` at an opacity, for the dimming layer. */
export function dimLayer(prefs: Pick<DisplayVideoPrefs, 'dimPct' | 'dimColor'>): string {
  const hex = HEX.test(prefs.dimColor) ? prefs.dimColor : '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const alpha = Math.min(DIM_MAX_PCT, Math.max(0, prefs.dimPct)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** This device's choice; read by the display, set under Settings → This device. */
export const displayVideoPrefs = reactive<DisplayVideoPrefs>({ ...DEFAULT_PREFS });

type VideoDb = Dexie & { videos: EntityTable<DisplayVideo, 'id'> };
const open = new Map<string, VideoDb>();

function accountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Display videos were used while signed out.');
  return account.accountId;
}

function db(): VideoDb {
  const name = `zollify_${accountId().replace(/[^A-Za-z0-9_-]/g, '_')}_display`;
  const existing = open.get(name);
  if (existing) return existing;
  const next = new Dexie(name) as VideoDb;
  next.version(1).stores({ videos: 'id, order' });
  open.set(name, next);
  return next;
}

export async function loadDisplayVideoPrefs(): Promise<DisplayVideoPrefs> {
  const row = await openCoreDb(accountId()).settings.get(PREFS_KEY);
  const stored = (row?.value ?? {}) as Partial<DisplayVideoPrefs>;
  Object.assign(displayVideoPrefs, DEFAULT_PREFS, {
    ...(typeof stored.enabled === 'boolean' ? { enabled: stored.enabled } : {}),
    ...(stored.mode === 'overlay' || stored.mode === 'swap' ? { mode: stored.mode } : {}),
    ...(typeof stored.dimPct === 'number' && Number.isFinite(stored.dimPct) ? { dimPct: Math.min(DIM_MAX_PCT, Math.max(0, Math.round(stored.dimPct))) } : {}),
    dimColor: colour(stored.dimColor, DEFAULT_PREFS.dimColor) || DEFAULT_PREFS.dimColor,
    panelBg: colour(stored.panelBg, ''),
    panelText: colour(stored.panelText, ''),
    totalColor: colour(stored.totalColor, ''),
  });
  return { ...displayVideoPrefs };
}

export async function setDisplayVideoPrefs(patch: Partial<DisplayVideoPrefs>): Promise<void> {
  Object.assign(displayVideoPrefs, patch);
  await openCoreDb(accountId()).settings.put({ key: PREFS_KEY, value: { ...displayVideoPrefs } });
}

/** The videos in play order, without loading their contents. */
export async function listDisplayVideos(): Promise<DisplayVideoInfo[]> {
  const rows = await db().videos.orderBy('order').toArray();
  return rows.map(({ blob: _blob, ...info }) => info);
}

/** One video's contents, for the player. Null once it has been removed. */
export async function displayVideoBlob(id: string): Promise<Blob | null> {
  return (await db().videos.get(id))?.blob ?? null;
}

/**
 * Stores picked files at the end of the list. Anything that is not a video
 * is skipped and named back; a device out of room says so in words rather
 * than with the browser's quota error.
 */
export async function addDisplayVideos(files: File[]): Promise<{ added: number; skipped: string[] }> {
  const table = db().videos;
  const last = await table.orderBy('order').last();
  let order = (last?.order ?? 0) + 1;
  const skipped: string[] = [];
  let added = 0;
  // A display shown for days must not lose its videos to the browser tidying up.
  void requestPersistentStorage();
  for (const file of files) {
    if (!file.type.startsWith('video/')) {
      skipped.push(file.name);
      continue;
    }
    try {
      await table.put({ id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size, order: order++, addedAt: Date.now(), blob: file });
      added++;
    } catch (err) {
      if (err instanceof Error && /quota/i.test(`${err.name} ${err.message}`)) {
        throw new Error(`This device has no room left for "${file.name}". Remove a video or free up space, then add it again.`);
      }
      throw err;
    }
  }
  return { added, skipped };
}

export async function removeDisplayVideo(id: string): Promise<void> {
  await db().videos.delete(id);
}

/** Moves a video one place up (-1) or down (+1) in the play order. */
export async function moveDisplayVideo(id: string, by: -1 | 1): Promise<void> {
  const table = db().videos;
  const rows = await table.orderBy('order').toArray();
  const at = rows.findIndex((r) => r.id === id);
  const other = rows[at + by];
  if (at < 0 || !other) return;
  const self = rows[at]!;
  await db().transaction('rw', table, async () => {
    await table.update(self.id, { order: other.order });
    await table.update(other.id, { order: self.order });
  });
}

/** Asks the browser to keep this device's data even when it runs low on space. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Space used and available on this device for the app's data, when the browser says. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && typeof e.usage === 'number' && typeof e.quota === 'number' ? { usage: e.usage, quota: e.quota } : null;
  } catch {
    return null;
  }
}
