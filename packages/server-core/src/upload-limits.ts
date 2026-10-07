import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  SNIFF_BYTES,
  base64DecodedSize,
  checkUpload,
  formatFileSize,
  maxBytesFor,
  type UploadAccepted,
  type UploadPurposeId,
  type UploadRefusal,
} from '@zollify/shared';

/**
 * The server side of file uploads. What a purpose may be (types, sizes) is
 * defined once in `@zollify/shared`, which the app also checks before sending;
 * this adds what only the server knows: decoding without trusting the client,
 * the per-account storage quota, and the numbers an operator can set.
 *
 * Every route that accepts file content goes through `decodeUpload`, and sets
 * its Fastify `bodyLimit` from `base64BodyLimit` so an oversized body is
 * refused from its Content-Length, before it is buffered.
 */

const MB = 1024 * 1024;

const envMb = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface UploadConfig {
  /** What one account may keep in stored attachments in total. */
  accountQuotaBytes: number;
  /** Files one event may hold. */
  maxFilesPerEvent: number;
  /** The default request body limit; routes that take files raise it for themselves. */
  maxBodyBytes: number;
}

/** Read on use, so a changed environment (and a test) takes effect without a restart of the module. */
export function uploadConfig(): UploadConfig {
  return {
    accountQuotaBytes: Math.floor(envMb('ZOLLIFY_ACCOUNT_STORAGE_MB', 500) * MB),
    maxFilesPerEvent: Math.floor(envMb('ZOLLIFY_EVENT_FILES_MAX', 20)),
    maxBodyBytes: Math.floor(envMb('ZOLLIFY_MAX_BODY_MB', 8) * MB),
  };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type DecodedUpload = UploadAccepted & { bytes: Buffer };

/**
 * Turns base64 from a request into verified bytes. The size is known from the
 * text, so a file over its cap is refused before anything is allocated, and the
 * type comes from the bytes - `claimedMime` and `name` are only checked, never
 * believed.
 */
export function decodeUpload(purpose: UploadPurposeId, data: unknown, opts: { name?: string; claimedMime?: string } = {}): DecodedUpload | UploadRefusal {
  if (typeof data !== 'string' || !BASE64.test(data)) return { ok: false, status: 400, error: 'empty', message: 'The file could not be read. Try attaching it again.' };
  const expected = base64DecodedSize(data);
  const cap = maxBytesFor(purpose);
  if (expected > cap) {
    const early = checkUpload(purpose, { size: expected, head: new Uint8Array(0), name: opts.name });
    if (!early.ok) return early;
  }
  const bytes = Buffer.from(data, 'base64');
  const res = checkUpload(purpose, { size: bytes.length, head: bytes.subarray(0, SNIFF_BYTES), claimedMime: opts.claimedMime, name: opts.name });
  return res.ok ? { ...res, bytes } : res;
}

/** Sends a refusal as the JSON the app shows: `message` is readable as it stands. */
export function sendRefusal(reply: FastifyReply, r: UploadRefusal): FastifyReply {
  return reply.code(r.status).send({ error: r.error, message: r.message });
}

// ── Account storage quota ───────────────────────────────────────────────────

interface StorageSource {
  table: string;
  /** SQL for the bytes one row holds. */
  bytes: string;
}

/** Where an account's stored attachments live. A module that stores files adds its table with `addStorageSource`. */
const SOURCES: StorageSource[] = [
  { table: 'event_files', bytes: 'size' },
  { table: 'tax_expenses', bytes: 'COALESCE(LENGTH(invoiceBytes), 0)' },
  { table: 'sourcing_files', bytes: 'size' },
];

/** Counts a module's table (it needs an `accountId` column) toward the account quota. */
export function addStorageSource(table: string, bytes: string): void {
  if (!/^\w+$/.test(table)) throw new Error('Bad table name.');
  if (!SOURCES.some((s) => s.table === table)) SOURCES.push({ table, bytes });
}

/** Bytes of stored attachments an account holds, across every module that keeps files. */
export function storageUsed(db: Database.Database, accountId: string): number {
  let total = 0;
  for (const s of SOURCES) {
    // A module that is not deployed has no table; that is zero, not an error.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(s.table)) continue;
    total += (db.prepare(`SELECT COALESCE(SUM(${s.bytes}), 0) AS n FROM ${s.table} WHERE accountId = ?`).get(accountId) as { n: number }).n;
  }
  return total;
}

/** A refusal when storing `incoming` bytes (replacing `replacing`) would pass the account's quota, otherwise null. */
export function checkQuota(db: Database.Database, accountId: string, incoming: number, replacing = 0): UploadRefusal | null {
  const quota = uploadConfig().accountQuotaBytes;
  if (storageUsed(db, accountId) - replacing + incoming <= quota) return null;
  return {
    ok: false,
    status: 413,
    error: 'too_large',
    message: `This account has used up its file storage (${formatFileSize(quota)}). Remove some attachments first.`,
  };
}

// ── Serving stored files back ───────────────────────────────────────────────

/**
 * Headers for a route that returns a stored file as raw bytes (not JSON): it is
 * downloaded rather than shown, never sniffed into something else, and if a
 * browser opens it anyway it runs in an empty sandbox with no scripts.
 */
export function downloadHeaders(name: string, mime: string): Record<string, string> {
  const safe = name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  return {
    'content-type': mime,
    'content-disposition': `attachment; filename="${safe}"`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'none'",
    'cache-control': 'private, no-store',
  };
}

// ── Oversized bodies ────────────────────────────────────────────────────────

/** Answers a body over its route's limit in the same shape as every other upload refusal. */
export function registerUploadErrors(app: FastifyInstance): void {
  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, _req, reply) => {
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'too_large', message: 'That upload is too large to send. Choose a smaller file.' });
    }
    return reply.send(err);
  });
}
