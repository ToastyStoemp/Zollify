import { ref } from 'vue';
import type {
  EventStock,
  Product,
  PullResponse,
  PushResponse,
  SalesEvent,
  ServerOp,
  Transaction,
  DiscountRule,
  InventoryItem,
} from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { authFetch } from '../session';
import { deviceFlavor, deviceId, deviceName } from './device';
import { markSynced, refreshPendingCount, unsyncedOps } from './outbox';
import { loadCatalog } from './catalog';
import { loadSalesEvents } from './sales-events';
import { loadTransactions } from './transactions';
import { loadDiscounts } from './discounts';
import { loadInventory } from './inventory';

/**
 * Offline-first sync.
 *
 * Push first, then pull. Doing it in that order means a device's own changes
 * reach the server before it adopts anyone else's, so a slow device can't have
 * its unsent work silently overwritten by a pull it triggered itself.
 */

const CURSOR_KEY = 'core.syncCursor';
const EPOCH_KEY = 'core.syncEpoch';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export const syncState = ref<SyncState>('idle');
export const lastSyncAt = ref(0);
export const lastSyncError = ref<string | null>(null);

let inFlight: Promise<SyncResult> | null = null;

export interface SyncResult {
  pushed: number;
  pulled: number;
  ok: boolean;
  error?: string;
}

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Sync was used while signed out.');
  return account.accountId;
}

async function readCursor(): Promise<{ since: number; epoch: number }> {
  const db = openCoreDb(requireAccountId());
  const [cursor, epoch] = await Promise.all([db.settings.get(CURSOR_KEY), db.settings.get(EPOCH_KEY)]);
  return {
    since: Number(cursor?.value ?? 0),
    epoch: Number(epoch?.value ?? 0),
  };
}

async function writeCursor(since: number, epoch: number): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.settings.bulkPut([
    { key: CURSOR_KEY, value: since },
    { key: EPOCH_KEY, value: epoch },
  ]);
}

/**
 * Applies ops the server fanned out to us.
 *
 * Resolution is last-write-wins on `updatedAt`, matching the server. Anything
 * the client doesn't recognise is skipped rather than treated as an error: a
 * newer device on the account may legitimately emit op types this build has
 * never heard of, and refusing to sync over that would be worse than ignoring
 * them.
 */
async function applyOps(ops: ServerOp[]): Promise<number> {
  if (!ops.length) return 0;
  const db = openCoreDb(requireAccountId());
  let applied = 0;

  await db.transaction(
    'rw',
    [db.products, db.events, db.eventStock, db.transactions, db.discounts, db.inventory],
    async () => {
    for (const op of ops) {
      try {
        applied += await applyOne(db, op);
      } catch (err) {
        // One malformed op must not poison the whole pull. A peer on a newer
        // build can emit a payload this one cannot read, and refusing every
        // other change because of it would strand the device.
        console.warn(`[zollify] skipped a bad ${op.type} op`, err);
      }
    }
  });

  return applied;
}

/** Applies a single op. Returns 1 when it changed something, 0 when superseded. */
async function applyOne(db: ReturnType<typeof openCoreDb>, op: ServerOp): Promise<number> {
  switch (op.type) {
    case 'product.upsert': {
      const incoming = op.payload as Product;
      const existing = await db.products.get(incoming.id);
      if (!existing || (incoming.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        await db.products.put(incoming);
        return 1;
      }
      return 0;
    }
    case 'product.delete': {
      const { id, deletedAt } = op.payload as { id: string; deletedAt: number };
      const existing = await db.products.get(id);
      if (existing) {
        await db.products.put({ ...existing, deletedAt, updatedAt: deletedAt });
        return 1;
      }
      return 0;
    }
    case 'event.upsert': {
      const incoming = op.payload as SalesEvent;
      const existing = await db.events.get(incoming.id);
      if (!existing || (incoming.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        await db.events.put(incoming);
        return 1;
      }
      return 0;
    }
    case 'tx.create': {
      const incoming = op.payload as Transaction;
      // Sales are immutable once made; first write wins and a replayed op
      // is a no-op rather than a duplicate row.
      if (!(await db.transactions.get(incoming.id))) {
        await db.transactions.put(incoming);
        return 1;
      }
      return 0;
    }
    case 'tx.revert': {
      const { id, revertedAt, revertedBy } = op.payload as {
        id: string;
        revertedAt: number;
        revertedBy: string;
      };
      const existing = await db.transactions.get(id);
      if (existing && !existing.revertedAt) {
        await db.transactions.put({ ...existing, revertedAt, revertedBy });
        return 1;
      }
      return 0;
    }
    case 'discount.upsert': {
      const incoming = op.payload as DiscountRule & { updatedAt?: number };
      const existing = (await db.discounts.get(incoming.id)) as
        | (DiscountRule & { updatedAt?: number })
        | undefined;
      if (!existing || (incoming.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        await db.discounts.put(incoming);
        return 1;
      }
      return 0;
    }
    case 'discount.delete': {
      const { id, deletedAt } = op.payload as { id: string; deletedAt: number };
      const existing = await db.discounts.get(id);
      if (existing) {
        await db.discounts.put({ ...existing, deletedAt, updatedAt: deletedAt } as never);
        return 1;
      }
      return 0;
    }
    case 'inventory.set': {
      const incoming = op.payload as InventoryItem;
      const key: [string, string] = [incoming.productId, incoming.variantId ?? ''];
      const existing = await db.inventory.get(key);
      if (!existing || (incoming.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        await db.inventory.put({ ...incoming, variantId: incoming.variantId ?? '' });
        return 1;
      }
      return 0;
    }
    case 'stock.set': {
      const incoming = op.payload as EventStock;
      const key: [string, string, string] = [
        incoming.eventId,
        incoming.productId,
        incoming.variantId ?? '',
      ];
      const existing = await db.eventStock.get(key);
      if (existing && (incoming.updatedAt ?? 0) < (existing.updatedAt ?? 0)) return 0;

      // A negative quantity is the tombstone for a dropped claim: the protocol
      // has no stock.delete, and the event must fall back to the shared pool
      // rather than keep a stale reservation.
      if (incoming.broughtQty < 0) {
        await db.eventStock.delete(key);
        return 1;
      }

      await db.eventStock.put({ ...incoming, variantId: incoming.variantId ?? '' });
      return 1;
    }
    default:
      // Unknown to this build — skip rather than fail the whole batch.
      return 0;
  }
}

async function push(): Promise<number> {
  const ops = await unsyncedOps();
  if (!ops.length) return 0;

  const body = {
    deviceId: await deviceId(),
    deviceName: await deviceName(),
    flavor: deviceFlavor(),
    // Strip the local bookkeeping columns; the server validates against the
    // wire schema and would reject the extras.
    ops: ops.map(({ seq: _seq, synced: _synced, ...wire }) => wire),
  };

  const res = (await authFetch('/sync/push', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as PushResponse;

  // Marked synced whether accepted or duplicate: a duplicate means the server
  // already has it, which is exactly what we were trying to achieve.
  await markSynced(ops.map((op) => op.seq!).filter((seq) => typeof seq === 'number'));
  return res.accepted;
}

async function pull(): Promise<number> {
  const { since, epoch } = await readCursor();
  const res = (await authFetch(`/sync/pull?since=${since}`)) as PullResponse;

  const serverEpoch = res.epoch ?? 0;
  if (epoch !== 0 && serverEpoch !== 0 && serverEpoch !== epoch) {
    // The server rewrote its op log in place, so everything we cached from it
    // is stale. Discard synced data and re-pull from the beginning rather than
    // trying to reconcile against payloads that no longer exist.
    const db = openCoreDb(requireAccountId());
    await db.transaction('rw', [db.products, db.events, db.eventStock, db.transactions], async () => {
      // Transactions are deliberately kept. They are financial records and are
      // immutable once written, so there is nothing stale to discard — and a
      // sale made on this device but not yet pushed would be lost forever.
      await Promise.all([db.products.clear(), db.events.clear(), db.eventStock.clear()]);
    });
    await writeCursor(0, serverEpoch);
    const fresh = (await authFetch('/sync/pull?since=0')) as PullResponse;
    const applied = await applyOps(fresh.ops);
    await writeCursor(fresh.latestSeq, fresh.epoch ?? serverEpoch);
    return applied;
  }

  const applied = await applyOps(res.ops);
  await writeCursor(res.latestSeq, serverEpoch);
  return applied;
}

/**
 * Runs one sync cycle. Concurrent callers share the in-flight run — a screen
 * that syncs on mount plus a timer tick should not produce two pushes racing
 * over the same outbox rows.
 */
export async function syncNow(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  if (!getAccount()) return { pushed: 0, pulled: 0, ok: false, error: 'Not signed in.' };

  inFlight = (async () => {
    syncState.value = 'syncing';
    lastSyncError.value = null;
    try {
      const pushed = await push();
      const pulled = await pull();

      // Reload the in-memory stores so the UI reflects what just arrived.
      if (pulled > 0) {
        await Promise.all([
          loadCatalog(),
          loadSalesEvents(),
          loadTransactions(),
          loadDiscounts(),
          loadInventory(),
        ]);
      }
      await refreshPendingCount();

      lastSyncAt.value = Date.now();
      syncState.value = 'idle';
      return { pushed, pulled, ok: true };
    } catch (err) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      syncState.value = offline ? 'offline' : 'error';
      const message = err instanceof Error ? err.message : String(err);
      lastSyncError.value = message;
      // Not a thrown error: being offline is the normal state at a booth, and
      // callers should not have to treat it as exceptional.
      return { pushed: 0, pulled: 0, ok: false, error: message };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts periodic sync, plus an immediate attempt whenever the network returns. */
export function startAutoSync(intervalMs = 60_000): void {
  stopAutoSync();
  timer = setInterval(() => void syncNow(), intervalMs);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
  }
  void syncNow();
}

function onOnline(): void {
  void syncNow();
}

export function stopAutoSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
}
