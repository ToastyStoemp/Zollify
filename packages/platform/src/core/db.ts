import Dexie, { type EntityTable } from 'dexie';
import type {
  DiscountRule,
  EventStock,
  InventoryItem,
  Op,
  Product,
  SalesEvent,
  Transaction,
} from '@zollify/shared';

/**
 * Core's own local database.
 *
 * Core is not a module, but it follows the same per-account rule so two logins
 * on one device never see each other's catalogue. Modules get their own
 * databases via `sdk.db()`; this one holds the shared domain - products,
 * events, stock, transactions - that modules read through the SDK rather than
 * opening themselves.
 */

export interface ImageRec {
  id: string;
  productId: string;
  full: Blob;
  thumb: Blob;
  updatedAt: number;
}

/** An operation waiting to be pushed to the server. */
export interface OutboxOp extends Op {
  seq?: number;
  /** 0 = not yet pushed, 1 = acknowledged. */
  synced: 0 | 1;
}

export interface SettingRow {
  key: string;
  value: unknown;
  /** Present only on settings synced across devices; last-write-wins. */
  updatedAt?: number;
}

export type CoreDb = Dexie & {
  products: EntityTable<Product, 'id'>;
  events: EntityTable<SalesEvent, 'id'>;
  /** The one inventory: what the booth owns, keyed by product and variant. */
  inventory: Dexie.Table<InventoryItem, [string, string]>;
  /** Per-event claims on that inventory. */
  eventStock: Dexie.Table<EventStock, [string, string, string]>;
  transactions: EntityTable<Transaction, 'id'>;
  discounts: EntityTable<DiscountRule, 'id'>;
  images: EntityTable<ImageRec, 'id'>;
  ops: Dexie.Table<OutboxOp, number>;
  settings: Dexie.Table<SettingRow, string>;
};

const open = new Map<string, CoreDb>();

export function coreDbName(accountId: string): string {
  return `zollify_${accountId.replace(/[^A-Za-z0-9_-]/g, '_')}_core`;
}

export function openCoreDb(accountId: string): CoreDb {
  const name = coreDbName(accountId);
  const existing = open.get(name);
  if (existing) return existing;

  const db = new Dexie(name) as CoreDb;
  db.version(1).stores({
    products: 'id, title, sku, forSale, updatedAt',
    events: 'id, name, status, updatedAt',
    // Compound key so stock is unique per event/product/variant. variantId is
    // '' rather than null for the product itself - IndexedDB compound keys
    // cannot hold null, which is why the shared type documents it that way.
    eventStock: '[eventId+productId+variantId], eventId, productId',
    transactions: 'id, eventId, timestamp',
    discounts: 'id, updatedAt',
    images: 'id, productId',
    // Auto-incrementing outbox: ++seq gives a stable push order per device.
    ops: '++seq, synced',
    settings: 'key',
  });

  /**
   * v2 introduces the single inventory.
   *
   * Before this, stock existed only per event and there was no answer to "how
   * many do I own". Existing per-event rows become claims against the new
   * inventory, and the inventory is seeded from the largest claim any event
   * held - the only figure in the old data that is evidence of what was owned.
   * It is a starting point to correct, not a count, which is why the Inventory
   * screen leads with a recount prompt when it finds seeded rows.
   */
  db.version(2)
    .stores({ inventory: '[productId+variantId], productId' })
    .upgrade(async (tx) => {
      const claims = await tx.table('eventStock').toArray();
      const largest = new Map<string, InventoryItem>();

      for (const claim of claims) {
        const key = `${claim.productId}:${claim.variantId ?? ''}`;
        const existing = largest.get(key);
        if (!existing || claim.broughtQty > existing.onHand) {
          largest.set(key, {
            productId: claim.productId,
            variantId: claim.variantId ?? '',
            onHand: claim.broughtQty,
            updatedAt: Date.now(),
          });
        }
      }

      if (largest.size) await tx.table('inventory').bulkPut([...largest.values()]);
    });

  open.set(name, db);
  return db;
}

export function closeCoreDb(accountId: string): void {
  const name = coreDbName(accountId);
  open.get(name)?.close();
  open.delete(name);
}

export async function deleteCoreDb(accountId: string): Promise<void> {
  const name = coreDbName(accountId);
  closeCoreDb(accountId);
  await Dexie.delete(name);
}
