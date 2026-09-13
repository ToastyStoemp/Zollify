import { ref } from 'vue';
import type { WireOp } from '@boothly/shared';
import { openCoreDb, type OutboxOp } from './db';
import { getAccount } from '../session';
import { deviceId } from './device';

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

export async function queueOp(op: PendingOp): Promise<void> {
  const accountId = requireAccountId();
  const db = openCoreDb(accountId);

  const wire: WireOp = {
    // 16-char minimum per the protocol schema; a UUID clears it comfortably and
    // makes the op idempotent, so a retried push de-duplicates server-side
    // rather than double-applying.
    opId: crypto.randomUUID(),
    deviceId: await deviceId(),
    ts: Date.now(),
    type: op.type,
    payload: op.payload,
  };

  await db.ops.add({ ...wire, synced: 0 } as OutboxOp);
  await refreshPendingCount();
}

export async function unsyncedOps(limit = 500): Promise<OutboxOp[]> {
  const db = openCoreDb(requireAccountId());
  // The protocol caps a push at 500 ops; ordering by insertion keeps a device's
  // own changes applied in the order they were made.
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
