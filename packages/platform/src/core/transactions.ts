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
 * Loads recent sales. Bounded deliberately: a busy convention produces
 * thousands, and History pages rather than holding them all in memory.
 */
export async function loadTransactions(limit = 500): Promise<void> {
  const db = openCoreDb(requireAccountId());
  const rows = await db.transactions.orderBy('timestamp').reverse().limit(limit).toArray();
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

/** Money handled in integer minor units, then converted once — see cart totals. */
function toMinor(value: number): number {
  return Math.round(value * 100);
}

/**
 * Turns the SDK's cross-module `sale` announcement into a stored Transaction.
 *
 * The SDK event is deliberately a smaller shape than `Transaction` — it is the
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

  const leg: PaymentLeg = {
    kind: sale.payment.method ?? (sale.payment.provider === 'manual' ? 'cash' : 'card'),
    amount: sale.total,
    provider: sale.payment.provider,
    txRef: sale.payment.txRef,
    cardBrand: sale.payment.cardBrand,
  };

  return {
    id: sale.saleId,
    // A sale made with no active event still has to be recorded; filing it
    // under '' keeps it visible in History rather than dropping it.
    eventId: sale.eventId ?? '',
    deviceId: device,
    timestamp: sale.at,
    method: leg.kind,
    payments: [leg],
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

/** Replaces rows wholesale — used by sync pulls and restore. */
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
 * Reverted sales are counted separately rather than subtracted silently — at
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
