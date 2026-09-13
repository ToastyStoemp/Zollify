import { ref } from 'vue';
import { openCoreDb, type OutboxOp } from './db';
import { getAccount } from '../session';

/**
 * The sync outbox.
 *
 * Every local mutation is recorded here before it is pushed. Writing the op in
 * the same breath as the change is what makes the app usable offline: a booth
 * with no signal keeps selling, and the queue drains when a connection returns.
 *
 * Ops are never deleted on push — they are marked `synced` — so a failed or
 * partial push can be retried without losing the record of what happened.
 */

export interface PendingOp {
  kind: string;
  payload: unknown;
}

export const pendingCount = ref(0);

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('The outbox was used while signed out.');
  return account.accountId;
}

export async function queueOp(op: PendingOp): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.ops.add({
    ...(op as unknown as OutboxOp),
    synced: 0,
  });
  await refreshPendingCount();
}

export async function unsyncedOps(limit = 500): Promise<OutboxOp[]> {
  const db = openCoreDb(requireAccountId());
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
 * Drops acknowledged ops older than the cutoff. Kept deliberately conservative:
 * the outbox is the only local record that a change was made, so pruning
 * anything still in flight would lose it silently.
 */
export async function pruneSynced(olderThanMs = 7 * 24 * 3600 * 1000): Promise<number> {
  const db = openCoreDb(requireAccountId());
  const cutoff = Date.now() - olderThanMs;
  const doomed = await db.ops
    .where('synced')
    .equals(1)
    .filter((op) => {
      const at = (op as unknown as { at?: number }).at ?? 0;
      return at > 0 && at < cutoff;
    })
    .primaryKeys();
  if (doomed.length) await db.ops.bulkDelete(doomed as number[]);
  return doomed.length;
}
