import { ref } from 'vue';
import type { Table } from 'dexie';
import type { WireOp } from '@zollify/shared';
import { openCoreDb, type CoreDb, type OutboxOp } from './db';
import { getAccount } from '../session';
import { deviceId } from './device';
import { toPlain } from './plain';

/**
 * The sync outbox.
 *
 * Every local mutation is recorded here before it is pushed. Writing the op in
 * the same breath as the change is what makes the app usable offline: a booth
 * with no signal keeps selling, and the queue drains when a connection returns.
 *
 * Ops are marked `synced` rather than deleted, so a failed or partial push can
 * be retried without losing the record of what happened.
 */

/** What a caller supplies; identity and timing are filled in here. */
export interface PendingOp {
  type: WireOp['type'];
  payload: unknown;
}

export const pendingCount = ref(0);

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('The outbox was used while signed out.');
  return account.accountId;
}

/** The outbox row for a change: identity and timing filled in. */
function outboxRow(op: PendingOp, device: string): OutboxOp {
  const wire: WireOp = {
    // 16-char minimum per the protocol schema; a UUID clears it comfortably and
    // makes the op idempotent, so a retried push de-duplicates server-side
    // rather than double-applying.
    opId: crypto.randomUUID(),
    deviceId: device,
    ts: Date.now(),
    type: op.type,
    payload: toPlain(op.payload),
  };
  return { ...wire, synced: 0, userId: getAccount()?.userId } as OutboxOp;
}

/** Queues an op from inside a `transactWithOutbox` write. */
export type Enqueue = (op: PendingOp) => Promise<void>;

/**
 * Runs a local write and queues its ops in one Dexie transaction over `tables`
 * and the outbox, so both land or neither does. Android can kill the WebView
 * at any moment: a sale stored without its op would sit on this device and
 * never reach the server.
 *
 * The device id is read before the transaction opens, and `write` may await
 * nothing but Dexie calls on those tables - IndexedDB commits a transaction
 * as soon as it is left waiting on anything else.
 */
export async function transactWithOutbox<T>(db: CoreDb, tables: Table[], write: (enqueue: Enqueue) => Promise<T>): Promise<T> {
  const device = await deviceId();
  const enqueue: Enqueue = async (op) => {
    await db.ops.add(outboxRow(op, device));
  };
  // An async function, literally: Dexie only keeps the transaction open across awaits when it is handed one.
  const result = await db.transaction('rw', [...tables, db.ops], async () => write(enqueue));
  await refreshPendingCountSafely();
  return result;
}

/** The count only drives the sync badge and the push timer: it must never fail a write that has already committed. */
async function refreshPendingCountSafely(): Promise<void> {
  try {
    await refreshPendingCount();
  } catch (err) {
    console.warn('[zollify] could not refresh the pending-sync count', err);
  }
}

/** Queues an op that has no local write to go with it. A change that also writes a row belongs in `transactWithOutbox`. */
export async function queueOp(op: PendingOp): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.ops.add(outboxRow(op, await deviceId()));
  await refreshPendingCount();
}

export async function unsyncedOps(limit = 2000): Promise<OutboxOp[]> {
  const db = openCoreDb(requireAccountId());
  // Ordering by insertion keeps a device's own changes applied in the order
  // they were made; push() splits this into batches the protocol accepts.
  return db.ops.where('synced').equals(0).limit(limit).toArray();
}

export async function markSynced(seqs: number[]): Promise<void> {
  if (!seqs.length) return;
  const db = openCoreDb(requireAccountId());
  await db.transaction('rw', db.ops, async () => {
    for (const seq of seqs) await db.ops.update(seq, { synced: 1 });
  });
  await refreshPendingCount();
}

export async function refreshPendingCount(): Promise<void> {
  const account = getAccount();
  if (!account) {
    pendingCount.value = 0;
    return;
  }
  const db = openCoreDb(account.accountId);
  pendingCount.value = await db.ops.where('synced').equals(0).count();
}

/**
 * Drops acknowledged ops older than the cutoff. Deliberately conservative: the
 * outbox is the only local record that a change was made, so anything still
 * unacknowledged is never touched.
 */
export async function pruneSynced(olderThanMs = 7 * 24 * 3600 * 1000): Promise<number> {
  const db = openCoreDb(requireAccountId());
  const cutoff = Date.now() - olderThanMs;
  const doomed = await db.ops
    .where('synced')
    .equals(1)
    .filter((op) => op.ts > 0 && op.ts < cutoff)
    .primaryKeys();
  if (doomed.length) await db.ops.bulkDelete(doomed as number[]);
  return doomed.length;
}

/** When the outbox was last pruned. Under `core.`, so it stays on this device (see synced-settings.ts). */
const PRUNED_AT_KEY = 'core.outboxPrunedAt';
const PRUNE_EVERY_MS = 24 * 3600 * 1000;

/**
 * Prunes the outbox at most once a day. Acknowledged ops keep their full
 * payloads - whole sales, base64 thumbnails - and a till that never drops
 * them gets slower with every event it works.
 */
export async function pruneSyncedWhenDue(now = Date.now()): Promise<number> {
  const db = openCoreDb(requireAccountId());
  const last = (await db.settings.get(PRUNED_AT_KEY))?.value;
  if (typeof last === 'number' && now - last < PRUNE_EVERY_MS) return 0;
  const removed = await pruneSynced();
  await db.settings.put({ key: PRUNED_AT_KEY, value: now });
  return removed;
}

/** Housekeeping after a sync, off to the side: it must never hold up or fail a sync, let alone a sale. */
export function pruneOutboxInBackground(): void {
  void pruneSyncedWhenDue().catch((err) => {
    // Signed out while it ran: the database closed under it, and the next sync after sign-in tries again.
    if ((err as { name?: string } | null)?.name === 'DatabaseClosedError') return;
    console.warn('[zollify] could not prune the outbox', err);
  });
}
