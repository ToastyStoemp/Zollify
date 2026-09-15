import { computed, reactive, ref } from 'vue';
import type { SaleEvent } from '@zollify/sdk';
import type { PaymentLeg, Transaction, TxItem } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';
import { deviceId } from './device';

/**
 * Recorded sales.
 *
 * Core persists these rather than POS, because a sale is account data that
 * outlives any module: Tax reads it, History shows it, a backup must contain
 * it, and it has to survive POS being switched off. POS announces a sale; core
 * is what remembers it.
 */

const transactions = reactive(new Map<string, Transaction>());
const loaded = ref(false);

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Transactions were used while signed out.');
  return account.accountId;
}

/**
 * Loads every sale. Totals over "all events" must see the whole history; a
 * cap of the most recent rows silently under-reported years of takings.
 * A few thousand small records is well within what a phone holds.
 */
export async function loadTransactions(): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const rows = await db.transactions.orderBy('timestamp').reverse().toArray();
  transactions.clear();
  for (const row of rows) transactions.set(row.id, row);
  loaded.value = true;
}

export const transactionsLoaded = computed(() => loaded.value);

/** Most recent first. */
export const recentTransactions = computed(() =>
  [...transactions.values()].sort((a, b) => b.timestamp - a.timestamp),
);

export function getTransaction(id: string): Transaction | undefined {
  return transactions.get(id);
}

/** Money handled in integer minor units, then converted once - see cart totals. */
function toMinor(value: number): number {
  return Math.round(value * 100);
}

/**
 * Turns the SDK's cross-module `sale` announcement into a stored Transaction.
 *
 * The SDK event is deliberately a smaller shape than `Transaction` - it is the
 * contract other modules consume, and widening it would make every subscriber
 * depend on storage details. The mapping lives here instead.
 */
export function saleToTransaction(sale: SaleEvent, device: string): Transaction {
  const items: TxItem[] = sale.lines.map((line) => ({
    pid: line.productId,
    vid: line.variantId ?? null,
    title: line.name,
    qty: line.qty,
    unitPrice: line.unitPrice,
    // Trust the emitter's figure: it already reflects discounts spread across
    // the basket. Recomputing here is what made receipts disagree with their
    // own total.
    lineTotal: line.lineTotal ?? (toMinor(line.unitPrice) * line.qty) / 100,
  }));

  // A split sale carries its own legs; anything else is one leg for the
  // whole amount. A custom method (TWINT, PayPal…) is card-like money: not in
  // the cash box.
  const method = sale.payment.method ?? (sale.payment.provider === 'manual' ? 'cash' : 'card');
  const legs: PaymentLeg[] = sale.payment.legs?.length
    ? sale.payment.legs.map((l) => ({ kind: l.kind, amount: l.amount, provider: l.provider }))
    : [
        {
          kind: method === 'cash' ? 'cash' : 'card',
          amount: sale.total,
          provider: sale.payment.provider,
          txRef: sale.payment.txRef,
          cardBrand: sale.payment.cardBrand,
        },
      ];

  return {
    id: sale.saleId,
    // A sale made with no active event still has to be recorded; filing it
    // under '' keeps it visible in History rather than dropping it.
    eventId: sale.eventId ?? '',
    deviceId: device,
    timestamp: sale.at,
    method,
    payments: legs,
    items,
    discounts: [],
    total: sale.total,
    currency: sale.currency,
    // Only set when the sale was converted; an unconverted sale leaves these
    // absent rather than duplicating its own currency into them.
    ...(sale.baseCurrency && sale.baseCurrency !== sale.currency
      ? {
          baseCurrency: sale.baseCurrency,
          baseTotal: sale.baseTotal,
          exchangeRate: sale.exchangeRate,
        }
      : {}),
  };
}

export async function recordSale(sale: SaleEvent): Promise<Transaction> {
  const db = openCoreDb(requireAccountId());
  const tx = toPlain(saleToTransaction(sale, await deviceId()));

  await db.transactions.put(tx);
  transactions.set(tx.id, tx);
  await queueOp({ type: 'tx.create', payload: tx });
  return tx;
}

/**
 * Reverts a sale.
 *
 * The original row is kept and marked, never deleted: a till's history is a
 * financial record, and a refund that erased the sale would leave the books
 * unexplainable.
 */
export async function revertTransaction(id: string): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const existing = await db.transactions.get(id);
  if (!existing) throw new Error('No such transaction.');
  if (existing.revertedAt) return;

  const revertedAt = Date.now();
  const reverted: Transaction = toPlain({ ...existing, revertedAt, revertedBy: crypto.randomUUID() });

  await db.transactions.put(reverted);
  transactions.set(id, reverted);
  await queueOp({ type: 'tx.revert', payload: { id, revertedAt, revertedBy: reverted.revertedBy } });
}

/**
 * Brings historical sales in from a backup, each queued as its own `tx.create`
 * so the other devices receive them too. Rows already known here are left
 * alone: the op is insert-if-absent everywhere, so re-running an import cannot
 * double-count. Returns how many were new.
 */
export async function importTransactions(rows: Transaction[]): Promise<number> {
  const db = openCoreDb(requireAccountId());
  let added = 0;
  for (const row of rows) {
    const tx = toPlain(row);
    if (await db.transactions.get(tx.id)) continue;
    await db.transactions.put(tx);
    transactions.set(tx.id, tx);
    await queueOp({ type: 'tx.create', payload: tx });
    added++;
  }
  return added;
}

/** Replaces rows wholesale - used by sync pulls and restore. */
export async function replaceTransactions(rows: Transaction[]): Promise<void> {
  const db = openCoreDb(requireAccountId());
  await db.transactions.bulkPut(rows.map(toPlain));
  for (const row of rows) transactions.set(row.id, row);
}

export interface SalesTotals {
  currency: string;
  sales: number;
  gross: number;
  reverted: number;
}

/**
 * Totals for an event, or for everything when no event is given.
 *
 * Reverted sales are counted separately rather than subtracted silently - at
 * cash-up you need to see both what was taken and what was handed back.
 */
export function totalsFor(eventId?: string | null): SalesTotals[] {
  const byCurrency = new Map<string, SalesTotals>();

  for (const tx of transactions.values()) {
    if (eventId !== undefined && eventId !== null && tx.eventId !== eventId) continue;

    const entry = byCurrency.get(tx.currency) ?? {
      currency: tx.currency,
      sales: 0,
      gross: 0,
      reverted: 0,
    };
    if (tx.revertedAt) {
      entry.reverted += tx.total;
    } else {
      entry.sales += 1;
      entry.gross += tx.total;
    }
    byCurrency.set(tx.currency, entry);
  }

  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function resetTransactionCache(): void {
  transactions.clear();
  loaded.value = false;
}
