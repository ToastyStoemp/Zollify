import type { EventStock, InventoryItem, Product, SalesEvent, Transaction } from '@zollify/shared';
import { deleteCoreDb, openCoreDb } from './db';
import { listZollifyDbs } from '../module-db';
import Dexie from 'dexie';
import { authFetch } from '../session';
import { getAccount } from '../session';
import { toPlain } from './plain';
import { leaveOnPurpose } from '../leave-guard';
import { loadCatalog, resetCatalogCache } from './catalog';
import { loadSalesEvents, resetSalesEventCache } from './sales-events';
import { loadTransactions, resetTransactionCache } from './transactions';
import { loadInventory, resetInventoryCache } from './inventory';
import { queueOp } from './outbox';
import { Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8, unzipSync } from 'fflate';
import { base64ToBlob, importProductImage } from './images';

/**
 * Local backup and restore.
 *
 * The authoritative copy of a booth's data is the device it was entered on -
 * sync is a convenience, not a guarantee, and a booth often works a whole
 * convention offline. Without an export there is no recovery from a lost or
 * wiped device, which makes this a data-safety feature rather than a
 * convenience one.
 */

/**
 * 2: a .zip - the data as `zollify-backup.json`, each photo as its own file
 * under `images/`. 1: one JSON file with the photos base64-encoded in it,
 * still read on restore; it was what made a large export run out of memory.
 */
export const BACKUP_VERSION = 2;
const READABLE_VERSIONS = [1, 2];

/** A photo in a backup: a file beside the data (version 2), or base64 inside it (version 1). */
export interface BackupImage {
  id: string;
  productId: string;
  updatedAt: number;
  fullType: string;
  thumbType: string;
  /** Path of the full-size photo in the zip. */
  file?: string;
  /** Path of the thumbnail in the zip. */
  thumbFile?: string;
  fullB64?: string;
  thumbB64?: string;
}

/** The data file inside a backup zip. */
export const BACKUP_DATA_FILE = 'zollify-backup.json';

export interface ZollifyBackup {
  format: 'zollify-backup';
  version: number;
  exportedAt: string;
  /** Recorded so a restore into the wrong account is visible, not silent. */
  accountId: string;
  accountName: string;
  products: Product[];
  events: SalesEvent[];
  /** The one inventory: what the booth owns. */
  inventory: InventoryItem[];
  /** Per-event claims against it. */
  eventStock: EventStock[];
  transactions: Transaction[];
  /** Product photos - optional so a version-1 backup from before they were added still restores. */
  images?: BackupImage[];
}

export class RestoreError extends Error {}

/** Which categories to pull into an export - unset means "all of them", same as before this existed. */
export interface BackupOptions {
  products?: boolean;
  events?: boolean;
  inventory?: boolean;
  eventStock?: boolean;
  transactions?: boolean;
  images?: boolean;
  /**
   * Restrict to one or more events instead of the whole booth - undefined or
   * empty means every event, same as before this existed. Events, event
   * stock and transactions filter directly (they carry an id/eventId);
   * inventory has no eventId of its own (it's the one booth-wide "what we
   * own" list, not per event), so it's narrowed to just the product/variant
   * rows that were actually claimed for the selected events instead.
   */
  eventIds?: string[];
}

const ALL_INCLUDED: Required<Omit<BackupOptions, 'eventIds'>> = {
  products: true,
  events: true,
  inventory: true,
  eventStock: true,
  transactions: true,
  images: true,
};

function requireAccount() {
  const account = getAccount();
  if (!account) throw new Error('Backup was used while signed out.');
  return account;
}

/**
 * Everything core owns, including soft-deleted rows.
 *
 * Tombstones are kept deliberately: dropping them would make a restore
 * resurrect every product ever deleted, because last-write-wins sync has no
 * other way to know they are gone. A category left out of `options` is left
 * out of the file entirely, not written as an empty array vs. omitted - a
 * restore already treats a missing field as "nothing to restore here"
 * (`file.products ?? []` etc.), so an old, pre-options backup restores the
 * same way it always did.
 */
async function collectBackup(options?: BackupOptions) {
  const include = { ...ALL_INCLUDED, ...options };
  const account = requireAccount();
  const db = openCoreDb(account.accountId);

  let [products, events, inventory, eventStock, transactions, imageRecs] = await Promise.all([
    include.products ? db.products.toArray() : Promise.resolve([]),
    include.events ? db.events.toArray() : Promise.resolve([]),
    include.inventory ? db.inventory.toArray() : Promise.resolve([]),
    include.eventStock ? db.eventStock.toArray() : Promise.resolve([]),
    include.transactions ? db.transactions.toArray() : Promise.resolve([]),
    include.images ? db.images.toArray() : Promise.resolve([]),
  ]);

  if (include.eventIds && include.eventIds.length) {
    const wanted = new Set(include.eventIds);
    events = events.filter((e) => wanted.has(e.id));
    eventStock = eventStock.filter((s) => wanted.has(s.eventId));
    transactions = transactions.filter((t) => wanted.has(t.eventId));
    // Only the stock actually claimed for these events, not the whole booth.
    const claimed = new Set(eventStock.map((s) => `${s.productId}\x00${s.variantId}`));
    inventory = inventory.filter((i) => claimed.has(`${i.productId}\x00${i.variantId}`));
  }

  // Only images a live product or variant still points at; a photo replaced
  // or removed before this code cleaned them up is dead weight in the file.
  const referenced = new Set<string>();
  for (const p of products) {
    if (p.deletedAt) continue;
    if (p.imageId) referenced.add(p.imageId);
    for (const v of p.variants ?? []) if (v.imageId) referenced.add(v.imageId);
  }
  imageRecs = imageRecs.filter((rec) => referenced.has(rec.id));

  const backup: ZollifyBackup = {
    format: 'zollify-backup',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    accountId: account.accountId,
    accountName: account.accountName,
    products,
    events,
    inventory,
    eventStock,
    transactions,
    images: [],
  };
  return { backup, imageRecs };
}

/** The data alone, without the photos (those only travel in the zip - createBackupZip). */
export async function createBackup(options?: BackupOptions): Promise<ZollifyBackup> {
  return (await collectBackup(options)).backup;
}

const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };
const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'photo';

/**
 * The export: a .zip with the data as JSON and every photo as a file of its
 * own, named after its product ("fox-print-a4-1a2b3c4d.webp") so the folder
 * makes sense opened by hand. Built in pieces - one photo in memory at a
 * time, stored as it is (photos do not compress) - and handed out as a Blob,
 * never as one giant string: base64 photos inside one JSON file is what used
 * to make a full export crash the app.
 */
export async function createBackupZip(options?: BackupOptions): Promise<{ blob: Blob; backup: ZollifyBackup; filename: string }> {
  const { backup, imageRecs } = await collectBackup(options);

  // Who each photo belongs to, for a readable file name.
  const labels = new Map<string, string>();
  for (const p of backup.products) {
    if (p.deletedAt) continue;
    if (p.imageId) labels.set(p.imageId, p.title);
    for (const v of p.variants ?? []) if (v.imageId && !labels.has(v.imageId)) labels.set(v.imageId, `${p.title} ${v.name}`);
  }

  const parts: BlobPart[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else parts.push(chunk as BlobPart);
  });
  const store = async (path: string, blob: Blob): Promise<void> => {
    const entry = new ZipPassThrough(path);
    zip.add(entry);
    entry.push(new Uint8Array(await blob.arrayBuffer()), true);
  };

  const used = new Set<string>();
  for (const rec of imageRecs) {
    let name = `${slug(labels.get(rec.id) ?? 'photo')}-${rec.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
    while (used.has(name)) name += '-1';
    used.add(name);
    const file = `images/${name}.${EXT[rec.full.type] ?? 'bin'}`;
    const thumbFile = `images/thumbs/${name}.${EXT[rec.thumb.type] ?? 'bin'}`;
    await store(file, rec.full);
    await store(thumbFile, rec.thumb);
    backup.images!.push({ id: rec.id, productId: rec.productId, updatedAt: rec.updatedAt, fullType: rec.full.type, thumbType: rec.thumb.type, file, thumbFile });
  }

  const data = new ZipDeflate(BACKUP_DATA_FILE, { level: 6 });
  zip.add(data);
  data.push(strToU8(JSON.stringify(backup, null, 2)), true);
  zip.end();
  if (failure) throw failure;
  return { blob: new Blob(parts, { type: 'application/zip' }), backup, filename: backupFilename(backup) };
}

/** A backup read from a file: the data, and the zip's other files (the photos) when it was a zip. */
export interface LoadedBackup {
  raw: unknown;
  files?: Record<string, Uint8Array>;
}

/** Reads a picked backup file: a .zip (version 2) or a .json (version 1). */
export async function readBackupFile(file: Blob): Promise<LoadedBackup> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    } catch {
      throw new RestoreError('That zip could not be opened.');
    }
    const data = files[BACKUP_DATA_FILE];
    if (!data) throw new RestoreError('That zip is not a Zollify backup.');
    try {
      return { raw: JSON.parse(strFromU8(data)) as unknown, files };
    } catch {
      throw new RestoreError('The data in that backup could not be read.');
    }
  }
  try {
    return { raw: JSON.parse(await file.text()) as unknown };
  } catch {
    throw new RestoreError("That file isn't a Zollify backup.");
  }
}

export interface BackupSummary {
  exportedAt: string;
  accountName: string;
  sameAccount: boolean;
  products: number;
  events: number;
  inventory: number;
  eventStock: number;
  transactions: number;
  images: number;
}

/**
 * Validates a backup and describes it, without writing anything.
 *
 * Restores overwrite live data, so the caller shows this first. Discovering the
 * wrong file after the fact is not recoverable.
 */
export function inspectBackup(raw: unknown): BackupSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw new RestoreError('That file is not a Zollify backup.');
  }
  const file = raw as Partial<ZollifyBackup>;

  if (file.format !== 'zollify-backup') {
    throw new RestoreError('That file is not a Zollify backup.');
  }
  if (!READABLE_VERSIONS.includes(file.version as number)) {
    throw new RestoreError(
      `This app reads backup versions ${READABLE_VERSIONS.join(' and ')}; the file is version ${String(file.version)}. Update the app first.`,
    );
  }

  const account = requireAccount();

  return {
    exportedAt: String(file.exportedAt ?? 'unknown'),
    accountName: String(file.accountName ?? 'unknown'),
    sameAccount: file.accountId === account.accountId,
    products: file.products?.length ?? 0,
    events: file.events?.length ?? 0,
    inventory: file.inventory?.length ?? 0,
    eventStock: file.eventStock?.length ?? 0,
    transactions: file.transactions?.length ?? 0,
    images: file.images?.length ?? 0,
  };
}

export interface RestoreResult {
  products: number;
  events: number;
  inventory: number;
  eventStock: number;
  transactions: number;
  images: number;
}

/**
 * Writes a backup back into core.
 *
 * Rows are merged rather than the database being cleared first: a restore is
 * usually recovering a device, and wiping anything that happened since the
 * export would turn a partial loss into a total one. Ops are recorded so the
 * restored rows reach the other devices too.
 */
export async function restoreBackup(raw: unknown, files: Record<string, Uint8Array> = {}): Promise<RestoreResult> {
  const summary = inspectBackup(raw);
  const file = raw as ZollifyBackup;
  const account = requireAccount();
  const db = openCoreDb(account.accountId);

  const products = (file.products ?? []).map(toPlain);
  const events = (file.events ?? []).map(toPlain);
  const stock = (file.eventStock ?? []).map((s) => toPlain({ ...s, variantId: s.variantId ?? '' }));
  const inventory = (file.inventory ?? []).map((i) => toPlain({ ...i, variantId: i.variantId ?? '' }));
  const transactions = (file.transactions ?? []).map(toPlain);

  await db.transaction('rw', [db.products, db.events, db.eventStock, db.transactions, db.inventory], async () => {
    if (products.length) await db.products.bulkPut(products);
    if (events.length) await db.events.bulkPut(events);
    if (inventory.length) await db.inventory.bulkPut(inventory);
    if (stock.length) await db.eventStock.bulkPut(stock);
    // Sales are immutable, so an existing row always wins over the file's copy.
    for (const tx of transactions) {
      if (!(await db.transactions.get(tx.id))) await db.transactions.put(tx);
    }
  });

  // Queued after the write, so a failed restore leaves nothing half-announced.
  for (const product of products) await queueOp({ type: 'product.upsert', payload: product });
  for (const event of events) await queueOp({ type: 'event.upsert', payload: event });
  for (const item of inventory) await queueOp({ type: 'inventory.set', payload: item });
  for (const entry of stock) await queueOp({ type: 'stock.set', payload: entry });
  for (const tx of transactions) await queueOp({ type: 'tx.create', payload: tx });

  // Images go through the same path a fresh photo does, one at a time - each
  // one queues its own thumbnail op, and there is no bulk equivalent worth
  // building for something that runs once per restore.
  let restoredImages = 0;
  for (const image of file.images ?? []) {
    const blobOf = (path: string | undefined, b64: string | undefined, type: string): Blob | null => {
      if (path) {
        const bytes = files[path];
        return bytes ? new Blob([bytes as BlobPart], { type }) : null;
      }
      return b64 ? base64ToBlob(b64, type) : null;
    };
    const full = blobOf(image.file, image.fullB64, image.fullType);
    if (!full) continue; // a photo missing from the zip: the rest still restores
    const thumb = blobOf(image.thumbFile, image.thumbB64, image.thumbType) ?? full;
    await importProductImage({ id: image.id, productId: image.productId, updatedAt: image.updatedAt, full, thumb });
    restoredImages++;
  }

  // Rebuilt rather than patched - a restore touches everything, and reloading
  // from the database is both simpler and impossible to get subtly wrong.
  resetCatalogCache();
  resetSalesEventCache();
  resetTransactionCache();
  resetInventoryCache();
  await Promise.all([loadCatalog(), loadSalesEvents(), loadTransactions(), loadInventory()]);

  return {
    products: summary.products,
    events: summary.events,
    inventory: summary.inventory,
    eventStock: summary.eventStock,
    transactions: summary.transactions,
    images: restoredImages,
  };
}

/** Filename that sorts chronologically and says which account it came from. */
export function backupFilename(backup: ZollifyBackup): string {
  const stamp = backup.exportedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const account = backup.accountName.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase();
  return `zollify-${account}-${stamp}.zip`;
}

/**
 * Erases the booth's data everywhere and starts over: the server drops the
 * account's op log, then every local Zollify database for the account on this
 * device is deleted and the app reloads to an empty booth. Other devices
 * discard their copy on their next sync (the server's epoch changed); their
 * unpushed sales are kept locally, as with any epoch change.
 */
export async function wipeAccountData(options: { archived?: boolean } = {}): Promise<void> {
  const account = getAccount();
  if (!account) throw new Error('Not signed in.');
  // The device identity lives in the same database; keep it so this stays the
  // same registered device (and its refresh token) after the reload.
  const keep = await openCoreDb(account.accountId).settings.where('key').startsWith('core.device').toArray();
  // `archived` says a backup with the sales in it was saved; the server keeps sales inside their retention period otherwise.
  await authFetch('/account/wipe', { method: 'POST', body: JSON.stringify({ archived: options.archived === true }) });
  await deleteCoreDb(account.accountId);
  const mine = (await listZollifyDbs()).filter((n) => n.includes(account.accountId.replace(/[^A-Za-z0-9_-]/g, '_')));
  for (const name of mine) await Dexie.delete(name);
  await openCoreDb(account.accountId).settings.bulkPut(keep);
  leaveOnPurpose();
  window.location.reload();
}
