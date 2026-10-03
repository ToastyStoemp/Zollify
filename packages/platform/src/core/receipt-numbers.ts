import type { ReceiptNumber, Transaction } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { tillId } from './tse';

/**
 * Receipt numbers: counted up per till, one at a time and never reused, so a
 * missing number stands out - what German and Austrian till rules expect of
 * a receipt.
 *
 * The till is this device, under its till serial number (see tillId): the
 * TSE's when one is set, so the receipt, the TSE and a tax export agree.
 * Every sale gets the next number, and so does every cancellation: with a
 * TSE a cancellation is a receipt of its own.
 */

const KEY = 'core.receiptCounters';

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Receipt numbers were used while signed out.');
  return account.accountId;
}

/** The highest number a till already used here - so a lost counter carries on rather than starting again. */
function highestIn(rows: Transaction[], till: string): number {
  let max = 0;
  for (const tx of rows) {
    if (tx.receipt?.till === till) max = Math.max(max, tx.receipt.number);
    if (tx.revertReceipt?.till === till) max = Math.max(max, tx.revertReceipt.number);
  }
  return max;
}

/** What a receipt was taken for: a till closes when the next one differs (see closings.ts). */
export interface ReceiptContext {
  /** Local day, YYYY-MM-DD. */
  day: string;
  eventId: string;
  currency: string;
}

const CONTEXT_KEY = 'core.receiptContexts';

/** The last receipt number this till took, and what for. */
export async function lastReceipt(till: string): Promise<{ number: number; context: ReceiptContext | null }> {
  const db = openCoreDb(requireAccountId());
  const counters = (await db.settings.get(KEY))?.value as Record<string, number> | undefined;
  const contexts = (await db.settings.get(CONTEXT_KEY))?.value as Record<string, ReceiptContext> | undefined;
  const number = counters?.[till] ?? highestIn(await db.transactions.toArray(), till);
  return { number, context: contexts?.[till] ?? null };
}

/** Takes the next receipt number on this till. Atomic across tabs: the count and its update are one database transaction. */
export async function nextReceiptNumber(context?: ReceiptContext): Promise<ReceiptNumber> {
  const till = await tillId();
  const db = openCoreDb(requireAccountId());
  return db.transaction('rw', db.settings, db.transactions, async () => {
    const counters = { ...((await db.settings.get(KEY))?.value as Record<string, number> | undefined) };
    const last = counters[till] ?? highestIn(await db.transactions.toArray(), till);
    const number = last + 1;
    counters[till] = number;
    await db.settings.put({ key: KEY, value: counters });
    if (context) {
      const contexts = { ...((await db.settings.get(CONTEXT_KEY))?.value as Record<string, ReceiptContext> | undefined), [till]: context };
      await db.settings.put({ key: CONTEXT_KEY, value: contexts });
    }
    return { till, number };
  });
}
