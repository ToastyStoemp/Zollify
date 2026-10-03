import { reactive } from 'vue';
import {
  TSE_PROCESS_TYPE,
  TseDataError,
  countryCodeOf,
  kassenbelegData,
  tseTime,
  type SaleTse,
  type SalesEvent,
  type Transaction,
  type TseHandle,
  type TseSignature,
} from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';

/**
 * KassenSichV on this device: the technical security device (TSE) that signs
 * each sale, as German law requires of an electronic till.
 *
 * The TSE is hardware in the device (a Swissbit USB or microSD TSE), so the
 * choice is per device, like the printer. Signing happens here in core, on
 * the finished transaction, so the signed figures are exactly the ones the
 * receipt prints and the books keep.
 *
 * A TSE that fails must not stop the till: the sale goes through, marked as
 * not signed with the reason, and the receipt says so - which is what the
 * rules ask for when a TSE is out of order.
 */

export type TseDriverId = 'none' | 'swissbit' | 'test';

export interface TseSettings {
  driver: TseDriverId;
  /** The till's serial number as registered with the TSE (the "Kassen-Seriennummer"). */
  clientId: string;
  /** Sign only sales at events in Germany (default), or every sale. */
  scope: 'germany' | 'always';
}

export interface TseInfo {
  serial: string;
  publicKey: string;
  algorithm: string;
  timeFormat: string;
  certified: boolean;
  /** When the TSE's certificate runs out, if it says. */
  expires?: string;
}

/** What a driver - real hardware or the test TSE - has to do. */
export interface TseDriver {
  available(): Promise<boolean>;
  info(): Promise<TseInfo>;
  start(clientId: string): Promise<{ number: number; time: number }>;
  finish(clientId: string, number: number, processType: string, processData: string): Promise<{ signatureCounter: number; time: number; signature: string }>;
}


const KEY = 'core.tse';
const DEFAULTS: TseSettings = { driver: 'none', clientId: '', scope: 'germany' };

export const tseState = reactive<{ settings: TseSettings; info: TseInfo | null; error: string | null }>({
  settings: { ...DEFAULTS },
  info: null,
  error: null,
});

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('The TSE was used while signed out.');
  return account.accountId;
}

export async function loadTseSettings(): Promise<TseSettings> {
  const row = await openCoreDb(requireAccountId()).settings.get(KEY);
  tseState.settings = { ...DEFAULTS, ...((row?.value as Partial<TseSettings>) ?? {}) };
  return tseState.settings;
}

export async function setTseSettings(patch: Partial<TseSettings>): Promise<void> {
  tseState.settings = { ...tseState.settings, ...patch };
  tseState.info = null;
  await openCoreDb(requireAccountId()).settings.put({ key: KEY, value: { ...tseState.settings } });
}

// ── Drivers ─────────────────────────────────────────────────────────────────

const drivers: Partial<Record<TseDriverId, TseDriver>> = {};

/** For tests, and for the native bridge to be swapped in. */
export function registerTseDriver(id: Exclude<TseDriverId, 'none'>, driver: TseDriver): void {
  drivers[id] = driver;
}

function driver(): TseDriver | null {
  const id = tseState.settings.driver;
  if (id === 'none') return null;
  return drivers[id] ?? (id === 'swissbit' ? swissbitDriver() : id === 'test' ? testDriver() : null);
}

/** Checks the TSE answers and reads its identity, for Settings and the receipt. */
export async function refreshTseInfo(): Promise<TseInfo | null> {
  tseState.error = null;
  const d = driver();
  if (!d) return (tseState.info = null);
  try {
    if (!(await d.available())) throw new Error('No TSE found on this device.');
    tseState.info = await d.info();
  } catch (err) {
    tseState.info = null;
    tseState.error = err instanceof Error ? err.message : String(err);
  }
  return tseState.info;
}

// ── Signing ─────────────────────────────────────────────────────────────────

/** Whether sales at this event must be signed on this device. */
export function tseRequiredFor(event: Pick<SalesEvent, 'venue'> | null | undefined): boolean {
  const s = tseState.settings;
  if (s.driver === 'none') return false;
  return s.scope === 'always' || countryCodeOf(event?.venue?.country) === 'DE';
}

async function startOn(d: TseDriver): Promise<{ number: number; start: number }> {
  const r = await d.start(tseState.settings.clientId);
  return { number: r.number, start: r.time };
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

/** Starts the TSE transaction - at the first item of a sale, as the rules want. Never throws. */
export async function beginTse(): Promise<TseHandle> {
  const d = driver();
  if (!d) return { failed: 'No TSE configured on this device.' };
  try {
    return await startOn(d);
  } catch (err) {
    return { failed: reasonOf(err) };
  }
}

async function finishWith(d: TseDriver, handle: { number: number; start: number }, processData: string): Promise<TseSignature> {
  const info = tseState.info ?? (await d.info());
  tseState.info = info;
  const done = await d.finish(tseState.settings.clientId, handle.number, TSE_PROCESS_TYPE, processData);
  return {
    clientId: tseState.settings.clientId,
    serial: info.serial,
    transactionNumber: handle.number,
    signatureCounter: done.signatureCounter,
    start: tseTime(handle.start),
    finish: tseTime(done.time),
    algorithm: info.algorithm,
    timeFormat: info.timeFormat,
    signature: done.signature,
    publicKey: info.publicKey,
    processType: TSE_PROCESS_TYPE,
    processData,
    ...(info.certified ? {} : { test: true }),
  };
}

/**
 * Signs a recorded sale. Uses the transaction started at its first item
 * when there is one; otherwise (the app was reloaded mid-sale, say) starts
 * one now. Never throws: a failure comes back as the reason, kept on the sale.
 */
export async function signSale(tx: Transaction, handle?: TseHandle | null): Promise<SaleTse> {
  const d = driver();
  if (!d) return { failed: { reason: 'No TSE configured on this device.', at: Date.now() } };
  try {
    const data = kassenbelegData(tx);
    // Started at the first item, or - if that failed or never happened - now:
    // a late start beats an unsigned sale.
    const started = handle && 'number' in handle ? handle : await startOn(d);
    return { signed: await finishWith(d, started, data) };
  } catch (err) {
    return { failed: { reason: err instanceof TseDataError ? err.message : reasonOf(err), at: Date.now() } };
  }
}

/** Closes a transaction for a sale that was abandoned (cart cleared). Best effort. */
export async function abortTse(handle: TseHandle | null | undefined): Promise<void> {
  const d = driver();
  if (!d || !handle || 'failed' in handle) return;
  try {
    await d.finish(tseState.settings.clientId, handle.number, TSE_PROCESS_TYPE, 'AVBelegabbruch^0.00_0.00_0.00_0.00_0.00^');
  } catch {
    /* an open transaction on the TSE is visible in its own export */
  }
}

/** Signs the cancelling receipt of a reverted sale: the same figures, negative, as a new "Beleg". */
export async function signCancellation(tx: Transaction): Promise<SaleTse> {
  const d = driver();
  if (!d) return { failed: { reason: 'No TSE on the device that reverted this sale.', at: Date.now() } };
  try {
    const data = kassenbelegData(tx, 'Beleg', -1);
    const started = await startOn(d);
    return { signed: await finishWith(d, started, data) };
  } catch (err) {
    return { failed: { reason: reasonOf(err), at: Date.now() } };
  }
}

// ── Swissbit hardware, through the native bridge ────────────────────────────

/**
 * The Android plugin "SwissbitTse" wraps Swissbit's WORM API (shipped in the
 * SDK that comes with the TSE - see docs/tse-swissbit.md). Until that plugin
 * is in the app this driver reports no TSE, and sales fail over to "TSE not
 * available" like any outage.
 */
interface SwissbitPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  info(): Promise<TseInfo>;
  startTransaction(o: { clientId: string }): Promise<{ transactionNumber: number; logTime: number }>;
  finishTransaction(o: { clientId: string; transactionNumber: number; processType: string; processData: string }): Promise<{ signatureCounter: number; logTime: number; signature: string }>;
}

function swissbitDriver(): TseDriver {
  const plugin = (): SwissbitPlugin | null => {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; isPluginAvailable?: (n: string) => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
    if (cap?.isNativePlatform?.() !== true || cap.isPluginAvailable?.('SwissbitTse') === false) return null;
    return (cap.Plugins?.SwissbitTse as SwissbitPlugin | undefined) ?? null;
  };
  const need = (): SwissbitPlugin => {
    const p = plugin();
    if (!p) throw new Error('The Swissbit TSE driver is not in this build of the app.');
    return p;
  };
  return {
    available: async () => {
      const p = plugin();
      return p ? (await p.isAvailable()).available : false;
    },
    info: () => need().info(),
    start: async (clientId) => {
      const r = await need().startTransaction({ clientId });
      return { number: r.transactionNumber, time: r.logTime };
    },
    finish: async (clientId, number, processType, processData) => {
      const r = await need().finishTransaction({ clientId, transactionNumber: number, processType, processData });
      return { signatureCounter: r.signatureCounter, time: r.logTime, signature: r.signature };
    },
  };
}

// ── Test TSE (development only, not certified) ──────────────────────────────

/**
 * A software stand-in that behaves like a TSE - counters, log times and real
 * ECDSA P-384 signatures over the processData - so the whole flow can be
 * built and tried without hardware. It is NOT a certified TSE: receipts and
 * the stored signature are marked as test, and it must never be used for
 * real sales in Germany.
 */
const TEST_KEY = 'core.tseTest';

interface TestState {
  privateJwk: JsonWebKey;
  publicRaw: string;
  serial: string;
  transactionNumber: number;
  signatureCounter: number;
}

function testDriver(): TseDriver {
  const b64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const db = () => openCoreDb(requireAccountId());
  let chain = Promise.resolve();
  /** Serialised, so two sales never take the same counter. */
  const locked = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  async function state(): Promise<TestState> {
    const row = await db().settings.get(TEST_KEY);
    if (row?.value) return row.value as TestState;
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    const fresh: TestState = {
      privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
      publicRaw: b64(raw),
      serial: hex(await crypto.subtle.digest('SHA-256', raw)),
      transactionNumber: 0,
      signatureCounter: 0,
    };
    await db().settings.put({ key: TEST_KEY, value: fresh });
    return fresh;
  }
  async function save(s: TestState): Promise<void> {
    await db().settings.put({ key: TEST_KEY, value: s });
  }
  return {
    available: async () => typeof crypto !== 'undefined' && !!crypto.subtle,
    info: async () => {
      const s = await state();
      return { serial: s.serial, publicKey: s.publicRaw, algorithm: 'ecdsa-plain-SHA384', timeFormat: 'unixTime', certified: false };
    },
    start: (clientId) =>
      locked(async () => {
        if (!clientId) throw new Error('No till serial number set for the TSE.');
        const s = await state();
        s.transactionNumber++;
        s.signatureCounter++;
        await save(s);
        return { number: s.transactionNumber, time: Date.now() };
      }),
    finish: (clientId, number, processType, processData) =>
      locked(async () => {
        const s = await state();
        s.signatureCounter++;
        const time = Date.now();
        const key = await crypto.subtle.importKey('jwk', s.privateJwk, { name: 'ECDSA', namedCurve: 'P-384' }, false, ['sign']);
        const message = new TextEncoder().encode([clientId, number, s.signatureCounter, Math.floor(time / 1000), processType, processData].join('|'));
        const signature = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, key, message));
        await save(s);
        return { signatureCounter: s.signatureCounter, time, signature };
      }),
  };
}

export function resetTseCache(): void {
  for (const id of Object.keys(drivers) as TseDriverId[]) delete drivers[id];
  tseState.settings = { ...DEFAULTS };
  tseState.info = null;
  tseState.error = null;
}
