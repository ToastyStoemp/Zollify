import type { DiscountRule, EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';

/**
 * Reads a ZollTool v2 backup.
 *
 * Deliberately narrow: this imports business data into a freshly created
 * account, and nothing else. Users, API keys and integration config are
 * re-entered by hand, so none of that is parsed here and none of it can be
 * carried over by accident.
 */

export interface ZollToolBackup {
  version: 2;
  exportedAt: string;
  events: SalesEvent[];
  products: Product[];
  eventStock: EventStock[];
  transactions: Transaction[];
  discounts: DiscountRule[];
  images?: { id: string; productId: string; updatedAt: number; fullB64?: string; thumbB64?: string }[];
}

/** A photo with both renditions in hand, ready to store under its original id. */
export interface ImportImage {
  id: string;
  productId: string;
  updatedAt: number;
  full: Blob;
  thumb: Blob;
}

/**
 * Photo bytes found beside the JSON: `images/<id>.full` (JPEG) and
 * `images/<id>.thumb` (WebP) inside a ZollTool .zip backup.
 */
export type ImageBlobs = Map<string, { full?: Blob; thumb?: Blob }>;

export interface ImportPlan {
  events: SalesEvent[];
  products: Product[];
  /** ZollTool's per-event stock becomes a claim on the new single inventory. */
  eventStock: EventStock[];
  /**
   * A starting inventory seeded from those claims.
   *
   * ZollTool had no notion of total stock owned — only what was taken to each
   * event. The largest quantity any event took is the only evidence in the old
   * data of how many existed, so it is used as an opening count to correct
   * rather than a figure to trust.
   */
  inventory: { productId: string; variantId: string; onHand: number; updatedAt: number }[];
  /** Photos whose bytes were in the file, keyed to the products that reference them. */
  images: ImportImage[];
  /** Rows the file contained but this importer does not bring across. */
  skipped: { what: string; count: number; why: string }[];
  warnings: string[];
}

export class BackupParseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray<T>(value: unknown, what: string, warnings: string[]): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`"${what}" was not a list and has been ignored.`);
    return [];
  }
  return value as T[];
}

/**
 * Parses and validates a backup, returning what would be written.
 *
 * Nothing is imported here — the caller shows this plan first. Importing into
 * a live catalogue without seeing the counts is how someone discovers they
 * picked the wrong file after it has already run.
 */
export function planImport(raw: unknown, imageBlobs: ImageBlobs = new Map()): ImportPlan {
  if (!isRecord(raw)) {
    throw new BackupParseError('That file is not a ZollTool backup.');
  }
  if (raw.version !== 2) {
    throw new BackupParseError(
      `This importer reads ZollTool backup version 2; the file says version ${String(raw.version ?? 'unknown')}.`,
    );
  }

  const warnings: string[] = [];
  const products = asArray<Product>(raw.products, 'products', warnings).filter((p) => {
    if (typeof p?.id === 'string' && typeof p?.title === 'string') return true;
    warnings.push('A product without an id or title was skipped.');
    return false;
  });

  const events = asArray<SalesEvent>(raw.events, 'events', warnings).filter((e) => {
    if (typeof e?.id === 'string' && typeof e?.name === 'string') return true;
    warnings.push('An event without an id or name was skipped.');
    return false;
  });

  const knownEvents = new Set(events.map((e) => e.id));
  const knownProducts = new Set(products.map((p) => p.id));

  const stock = asArray<EventStock>(raw.eventStock, 'eventStock', warnings).filter((s) => {
    // Orphaned stock would be invisible and unfixable in the UI, so it is
    // dropped with a count rather than imported silently.
    const ok = knownEvents.has(s?.eventId) && knownProducts.has(s?.productId);
    return ok;
  });

  const orphanStock = asArray<EventStock>(raw.eventStock, 'eventStock', []).length - stock.length;
  if (orphanStock > 0) {
    warnings.push(`${orphanStock} stock row(s) referenced a missing event or product and were dropped.`);
  }

  const skipped: ImportPlan['skipped'] = [];
  const transactions = asArray<Transaction>(raw.transactions, 'transactions', []);
  if (transactions.length) {
    skipped.push({
      what: 'Past transactions',
      count: transactions.length,
      why: 'Sales history stays in ZollTool. Importing it would double-count revenue if both systems are live.',
    });
  }
  const discounts = asArray<DiscountRule>(raw.discounts, 'discounts', []);
  if (discounts.length) {
    skipped.push({
      what: 'Discount rules',
      count: discounts.length,
      why: 'Not modelled in Zollify yet — re-create them once discounts land.',
    });
  }
  // Photos come across when their bytes do: from the zip, or inline base64 in
  // an older backup. Metadata alone is nothing to show, so it is skipped.
  const imageMeta = asArray<NonNullable<ZollToolBackup['images']>[number]>(raw.images, 'images', warnings);
  const images: ImportImage[] = [];
  for (const img of imageMeta) {
    if (typeof img?.id !== 'string' || typeof img?.productId !== 'string') continue;
    const zip = imageBlobs.get(img.id);
    let full = zip?.full;
    let thumb = zip?.thumb;
    if ((!full || !thumb) && img.fullB64 && img.thumbB64) {
      full = base64ToBlob(img.fullB64, 'image/jpeg');
      thumb = base64ToBlob(img.thumbB64, 'image/webp');
    }
    if (full && thumb) images.push({ id: img.id, productId: img.productId, updatedAt: Number(img.updatedAt) || Date.now(), full, thumb });
  }
  const withoutBytes = imageMeta.length - images.length;
  if (withoutBytes > 0) {
    skipped.push({
      what: 'Product images',
      count: withoutBytes,
      why: 'Only listed in the JSON, with no photo bytes. Use the .zip backup to bring photos across.',
    });
  }

  const liveEvents = dropDeleted(events);
  const liveProducts = dropDeleted(products);
  const deletedCount = events.length - liveEvents.length + (products.length - liveProducts.length);
  if (deletedCount > 0) {
    warnings.push(`${deletedCount} row(s) already deleted in ZollTool were not imported.`);
  }

  const claims = stock.map((s) => ({ ...s, variantId: s.variantId ?? '' }));

  const seeded = new Map<string, { productId: string; variantId: string; onHand: number; updatedAt: number }>();
  for (const claim of claims) {
    const key = `${claim.productId}:${claim.variantId}`;
    const existing = seeded.get(key);
    if (!existing || claim.broughtQty > existing.onHand) {
      seeded.set(key, {
        productId: claim.productId,
        variantId: claim.variantId,
        onHand: claim.broughtQty,
        updatedAt: Date.now(),
      });
    }
  }

  if (seeded.size) {
    warnings.push(
      `Opening inventory seeded from the largest quantity each item was ever taken to an event ` +
        `(${seeded.size} item(s)). Recount before trusting it — ZollTool never recorded total stock.`,
    );
  }

  const liveProductIds = new Set(liveProducts.map((p) => p.id));
  return {
    events: liveEvents,
    products: liveProducts,
    eventStock: claims,
    inventory: [...seeded.values()],
    images: images.filter((i) => liveProductIds.has(i.productId)),
    skipped,
    warnings,
  };
}

function base64ToBlob(base64: string, type: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type });
}

const ZIP_IMAGE_RE = /^images\/(.+)\.(full|thumb)$/;

/**
 * Splits a ZollTool .zip backup into its JSON and the photo bytes beside it.
 * The JSON is parsed by the caller through planImport like any other backup.
 */
export function unpackZip(files: Record<string, Uint8Array>): { json: unknown; images: ImageBlobs } {
  const jsonBytes = files['backup.json'];
  if (!jsonBytes) throw new BackupParseError('That zip has no backup.json inside — it is not a ZollTool backup.');
  const images: ImageBlobs = new Map();
  for (const [name, bytes] of Object.entries(files)) {
    const m = name.match(ZIP_IMAGE_RE);
    if (!m) continue;
    const entry = images.get(m[1]!) ?? {};
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: m[2] === 'full' ? 'image/jpeg' : 'image/webp' });
    if (m[2] === 'full') entry.full = blob;
    else entry.thumb = blob;
    images.set(m[1]!, entry);
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new BackupParseError("The backup.json inside the zip isn't valid JSON.");
  }
  return { json, images };
}

/**
 * Rows already deleted in ZollTool are not carried over.
 *
 * Dropping them is the only correct move: keeping the tombstone would import a
 * row that exists purely to be invisible, and clearing the marker instead would
 * resurrect something the user had deliberately removed.
 */
export function dropDeleted<T extends { deletedAt?: number }>(rows: T[]): T[] {
  return rows.filter((r) => !r.deletedAt);
}
