import { reactive } from 'vue';
import type { CashClosing, ReceiptNumber, Transaction } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';
import { deviceId } from './device';
import { tillId } from './tse';
import { lastReceipt, nextReceiptNumber, type ReceiptContext } from './receipt-numbers';

/**
 * Closings (Kassenabschluss, the "Z" of the DSFinV-K tax export).
 *
 * Every receipt a till takes ends up in exactly one closing: the receipts
 * since the till's previous closing, closed once and never changed. A till
 * closes itself whenever its next receipt would be for a different day,
 * event or currency (so a closing is one day at one event in one currency),
 * at start-up on a new day, and when asked to. Only the till makes its own
 * closings, so their numbers count up per till without ever colliding.
 */

const closings = reactive(new Map<string, CashClosing>());

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Closings were used while signed out.');
  return account.accountId;
}

export async function loadClosings(): Promise<void> {
  const rows = await openCoreDb(requireAccountId()).closings.toArray();
  closings.clear();
  for (const row of rows) closings.set(row.id, row);
}

/** All closings known here, every till's, newest first. */
export function allClosings(): CashClosing[] {
  return [...closings.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** The local calendar day of a moment, YYYY-MM-DD. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Serialised: a closing and the receipt number after it must not interleave with another sale's. */
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}

function sameContext(a: ReceiptContext | null, b: ReceiptContext): boolean {
  return !!a && a.day === b.day && a.eventId === b.eventId && a.currency === b.currency;
}

/**
 * The next receipt number for a sale or cancellation - closing the till
 * first when this receipt is for another day, event or currency than the
 * one before it.
 */
export function takeReceiptNumber(context: ReceiptContext): Promise<ReceiptNumber> {
  return locked(async () => {
    const till = await tillId();
    const last = await lastReceipt(till);
    if (last.context && !sameContext(last.context, context)) await close(till, last.number, last.context);
    return nextReceiptNumber(context);
  });
}

/** At start-up: closes the till's previous day, if it ended unclosed. */
export function closeStaleDay(now = Date.now()): Promise<CashClosing | null> {
  return locked(async () => {
    const till = await tillId();
    const last = await lastReceipt(till);
    if (!last.context || last.context.day >= localDay(now)) return null;
    return close(till, last.number, last.context);
  });
}

/** Closes the till now ("close the day"), if it has taken receipts since its last closing. */
export function closeTillNow(): Promise<CashClosing | null> {
  return locked(async () => {
    const till = await tillId();
    const last = await lastReceipt(till);
    return close(till, last.number, last.context);
  });
}

/** Receipts on this till since its last closing - for Settings. */
export async function openReceipts(): Promise<number> {
  const till = await tillId();
  const { number } = await lastReceipt(till);
  return Math.max(0, number - lastClosedOn(till));
}

function lastClosedOn(till: string): number {
  let max = 0;
  for (const c of closings.values()) if (c.till === till) max = Math.max(max, c.lastReceipt);
  return max;
}

function deviceInfo(): CashClosing['device'] {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; isPluginAvailable?: (n: string) => boolean } }).Capacitor;
  const native = cap?.isNativePlatform?.() === true;
  const carbon = native && cap?.isPluginAvailable?.('CarbonPayment') === true;
  return {
    brand: carbon ? 'myPOS' : native ? 'Android' : 'Browser',
    model: carbon ? 'Carbon' : native ? 'Zollify app' : 'Zollify web',
    software: 'Zollify',
    version: typeof __ZOLLIFY_VERSION__ === 'string' ? __ZOLLIFY_VERSION__ : 'dev',
  };
}

/** The receipts (sales and cancellations) a till took in a number range, with what they came to. */
function receiptsIn(rows: Transaction[], till: string, from: number, to: number): { total: number; cash: number; count: number } {
  let total = 0;
  let cash = 0;
  let count = 0;
  const add = (tx: Transaction, sign: 1 | -1): void => {
    count++;
    total += sign * Math.round(tx.total * 100);
    for (const leg of tx.payments) if (leg.kind === 'cash') cash += sign * Math.round(leg.amount * 100);
  };
  for (const tx of rows) {
    if (tx.receipt?.till === till && tx.receipt.number >= from && tx.receipt.number <= to) add(tx, 1);
    if (tx.revertReceipt?.till === till && tx.revertReceipt.number >= from && tx.revertReceipt.number <= to) add(tx, -1);
  }
  return { total: total / 100, cash: cash / 100, count };
}

async function close(till: string, lastNumber: number, context: ReceiptContext | null): Promise<CashClosing | null> {
  const from = lastClosedOn(till) + 1;
  if (lastNumber < from) return null;
  const db = openCoreDb(requireAccountId());
  const sums = receiptsIn(await db.transactions.toArray(), till, from, lastNumber);
  let number = 0;
  for (const c of closings.values()) if (c.till === till) number = Math.max(number, c.number);
  const now = Date.now();
  const closing: CashClosing = toPlain({
    id: crypto.randomUUID(),
    till,
    number: number + 1,
    createdAt: now,
    businessDay: context?.day ?? localDay(now),
    firstReceipt: from,
    lastReceipt: lastNumber,
    eventId: context?.eventId ?? '',
    currency: context?.currency ?? '',
    deviceId: await deviceId(),
    device: deviceInfo(),
    receipts: sums.count,
    total: sums.total,
    cash: sums.cash,
  });
  await db.closings.put(closing);
  closings.set(closing.id, closing);
  await queueOp({ type: 'closing.create', payload: closing });
  return closing;
}

/** Sync: another device's closing (or this one's, from a restore). Insert-if-absent. */
export async function applyClosing(incoming: CashClosing): Promise<number> {
  const db = openCoreDb(requireAccountId());
  if (await db.closings.get(incoming.id)) return 0;
  await db.closings.put(incoming);
  closings.set(incoming.id, incoming);
  return 1;
}

export function resetClosingCache(): void {
  closings.clear();
  chain = Promise.resolve();
}

declare const __ZOLLIFY_VERSION__: string | undefined;
