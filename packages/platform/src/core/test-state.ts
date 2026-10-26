import { reactive } from 'vue';
import type { CoreDb } from './db';

/**
 * Where test mode stands, read by the stores that have to tell test data
 * apart (sales events, transactions, inventory). The actions that change it
 * live in test-mode.ts; this file only holds the state, so those stores can
 * import it without importing each other.
 *
 * - `on` and `run` are this device's: one till can be tried out while
 *   another keeps selling for real.
 * - `endedRuns` and `clearedAt` are the account's, from the `tx.test.end`
 *   and `tx.test.clear` ops every device applies: a test sale stops counting
 *   against stock once its run has ended, and is gone once cleared.
 */
export const testState = reactive({
  on: false,
  run: null as string | null,
  endedRuns: new Set<string>(),
  clearedAt: 0,
});

export const TEST_MODE_KEY = 'core.testMode';
export const TEST_ENDED_RUNS_KEY = 'core.testEndedRuns';
export const TEST_CLEARED_AT_KEY = 'core.testClearedAt';

/** This device's test mode: on or off, and the run it is in. */
export async function loadDeviceTestMode(db: CoreDb): Promise<void> {
  const row = await db.settings.get(TEST_MODE_KEY);
  const value = (row?.value ?? {}) as { on?: unknown; run?: unknown };
  testState.on = value.on === true && typeof value.run === 'string';
  testState.run = testState.on ? (value.run as string) : null;
}

/** The runs that have ended and when test data was last cleared, as synced. */
export async function loadAccountTestState(db: CoreDb): Promise<void> {
  const [ended, cleared] = await Promise.all([db.settings.get(TEST_ENDED_RUNS_KEY), db.settings.get(TEST_CLEARED_AT_KEY)]);
  testState.endedRuns = new Set(Array.isArray(ended?.value) ? (ended.value as unknown[]).filter((r): r is string => typeof r === 'string') : []);
  testState.clearedAt = typeof cleared?.value === 'number' ? cleared.value : 0;
}

export function resetTestState(): void {
  testState.on = false;
  testState.run = null;
  testState.endedRuns = new Set();
  testState.clearedAt = 0;
}

// ── Stock changed during a test run ─────────────────────────────────────────

export const TEST_JOURNAL_KEY = 'core.testJournal';

/** A count or claim as it was before the test run first touched it, and the stamp of the run's last write to it. */
export interface JournalEntry<T> {
  before: T | null;
  lastWrite: number;
}
export interface TestJournal {
  run: string;
  inventory: Record<string, JournalEntry<unknown>>;
  claims: Record<string, JournalEntry<unknown>>;
}

/**
 * Notes a count or claim this device changes while in test mode: what it was
 * before the run first changed it, kept until the run ends and it is put back
 * (test-mode.ts). Device-local, like the run; each device puts back its own.
 */
export async function journalStockWrite(db: CoreDb, kind: 'inventory' | 'claims', key: string, before: unknown, written: number): Promise<void> {
  if (!testState.on || !testState.run) return;
  const row = await db.settings.get(TEST_JOURNAL_KEY);
  const stored = row?.value as TestJournal | undefined;
  const journal: TestJournal = stored && stored.run === testState.run ? stored : { run: testState.run, inventory: {}, claims: {} };
  const entry = journal[kind][key];
  journal[kind][key] = { before: entry ? entry.before : (before ?? null), lastWrite: written };
  await db.settings.put({ key: TEST_JOURNAL_KEY, value: JSON.parse(JSON.stringify(journal)) });
}
