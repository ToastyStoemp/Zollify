import type { EventStock, InventoryItem, SalesEvent } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { activeEvent, testEvent, upsertSalesEvent } from './sales-events';
import { forgetTestTransactions, stockTransactions } from './transactions';
import { allClaims, clearClaim, countedAt, setClaim, setOnHand, stockKey } from './inventory';
import { TEST_ENDED_RUNS_KEY, TEST_JOURNAL_KEY, TEST_MODE_KEY, testState, type TestJournal } from './test-state';

/**
 * Test mode: the whole app as usual, without any of it being real.
 *
 * While a device is in test mode its till sells into the account's test
 * event. Those sales are recorded, synced, numbered (in a TEST series) and
 * shown under the test event, with receipts and commissions working as
 * always - but they travel as `tx.test.*` ops, so takings, books, tax,
 * exports and webhooks, which read `tx.create`, never see them.
 *
 * Stock moves as it would for real, and is put back when test mode ends:
 * the run's sales stop counting (`tx.test.end`), and every count or claim
 * this device changed during the run returns to what it was. Clearing test
 * data removes the test sales everywhere (`tx.test.clear`).
 */

export { testState } from './test-state';

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Test mode was used while signed out.');
  return account.accountId;
}

/**
 * The test event, made the first time it is needed: like the event being
 * sold at now (currency, prices, VAT, where it is), so a test runs under the
 * same conditions, but kept out of the event list, the public page and the
 * shared pool.
 */
export async function ensureTestEvent(): Promise<SalesEvent> {
  if (testEvent.value) return testEvent.value;
  const like = activeEvent.value;
  const event: SalesEvent = {
    id: crypto.randomUUID(),
    name: 'Test event',
    venue: like?.venue ?? {},
    currency: like?.currency ?? getAccount()?.profile?.defaultCurrency ?? 'EUR',
    ...(like?.localCurrency ? { localCurrency: like.localCurrency, exchangeRate: like.exchangeRate, roundingIncrement: like.roundingIncrement } : {}),
    ...(like?.localPriceOverrides ? { localPriceOverrides: like.localPriceOverrides } : {}),
    ...(like?.localTierOverrides ? { localTierOverrides: like.localTierOverrides } : {}),
    ...(like?.vat ? { vat: like.vat } : {}),
    status: 'active',
    noPool: true,
    test: true,
    updatedAt: Date.now(),
  };
  await upsertSalesEvent(event);
  return event;
}

async function saveDeviceState(): Promise<void> {
  await openCoreDb(requireAccountId()).settings.put({ key: TEST_MODE_KEY, value: { on: testState.on, run: testState.run } });
}

/** Turns test mode on for this device, in a new test run. */
export async function startTestMode(): Promise<SalesEvent> {
  const event = await ensureTestEvent();
  if (testState.on) return event;
  testState.run = crypto.randomUUID();
  testState.on = true;
  await saveDeviceState();
  await openCoreDb(requireAccountId()).settings.delete(TEST_JOURNAL_KEY);
  return event;
}

/**
 * Turns test mode off: the run ends, so its sales stop taking stock, and
 * every count and claim changed during it is put back.
 */
export async function stopTestMode(): Promise<{ restored: number }> {
  const run = testState.run;
  testState.on = false;
  testState.run = null;
  await saveDeviceState();
  if (!run) return { restored: 0 };
  await endRun(run);
  return { restored: await restoreStock(run) };
}

async function endRun(run: string): Promise<void> {
  const db = openCoreDb(requireAccountId());
  testState.endedRuns = new Set([...testState.endedRuns, run]);
  await db.settings.put({ key: TEST_ENDED_RUNS_KEY, value: [...testState.endedRuns] });
  await queueOp({ type: 'tx.test.end', payload: { run, at: Date.now() } });
}

/** Real sales of an item since a moment - what a count from then no longer has. */
function realSoldSince(key: string, since: number): number {
  let sold = 0;
  for (const tx of stockTransactions.value) {
    if (tx.testRun || tx.revertedAt || tx.timestamp < since) continue;
    for (const item of tx.items) if (stockKey(item.pid, item.vid) === key) sold += item.qty;
  }
  return sold;
}

/**
 * Puts back what the run changed. A count is put back as what it would read
 * now - the old count less the real sales since - because a count's time is
 * what later sales are measured from. Anything changed again since the run
 * last wrote it (on another device, say) is left as it is.
 */
async function restoreStock(run: string): Promise<number> {
  const db = openCoreDb(requireAccountId());
  const row = await db.settings.get(TEST_JOURNAL_KEY);
  const journal = row?.value as TestJournal | undefined;
  if (!journal || journal.run !== run) return 0;
  let restored = 0;

  for (const [key, entry] of Object.entries(journal.inventory)) {
    const [productId = '', variantId = ''] = splitKey(key, 2);
    if (countedAt(productId, variantId) !== entry.lastWrite) continue;
    const before = entry.before as InventoryItem | null;
    await setOnHand(productId, variantId, before ? Math.max(0, before.onHand - realSoldSince(key, before.updatedAt)) : 0);
    restored++;
  }

  const claimsNow = new Map(allClaims().map((c) => [`${c.eventId}:${c.productId}:${c.variantId ?? ''}`, c]));
  for (const [key, entry] of Object.entries(journal.claims)) {
    const [eventId = '', productId = '', variantId = ''] = splitKey(key, 3);
    const now = claimsNow.get(key);
    // Changed again since the run's last write: someone else's now.
    if (now && now.updatedAt !== entry.lastWrite) continue;
    const before = entry.before as EventStock | null;
    if (!before) {
      if (now) {
        await clearClaim(eventId, productId, variantId);
        restored++;
      }
    } else {
      await setClaim(eventId, productId, variantId, before.broughtQty, { carried: before.carried ?? { from: '', qty: 0 } });
      restored++;
    }
  }

  await db.settings.delete(TEST_JOURNAL_KEY);
  return restored;
}

/** "a:b:c" into its parts, the last one keeping any colons of its own. */
function splitKey(key: string, parts: number): string[] {
  const bits = key.split(':');
  const out = [...bits.slice(0, parts - 1), bits.slice(parts - 1).join(':')];
  while (out.length < parts) out.push('');
  return out;
}

/**
 * Removes every test sale on every device. Test mode stays as it is; a run
 * still going simply starts again from nothing.
 */
export async function clearTestData(): Promise<void> {
  const at = Date.now();
  await forgetTestTransactions(at);
  await queueOp({ type: 'tx.test.clear', payload: { at } });
}
