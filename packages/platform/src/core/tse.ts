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
  type TseRequestMessage,
  type TseResultMessage,
  type TseSignature,
} from '@zollify/shared';
import { openCoreDb } from './db';
import { authFetch, getAccount } from '../session';
import { deviceId } from './device';
import { toPlain } from './plain';
import { getSyncedSetting, setSyncedSetting } from './synced-settings';

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
 *
 * Devices with a TSE can be made the account's main TSE devices. Every
 * device without a TSE of its own then signs through one of them, over the
 * live channel, under its own till serial number - a phone kept as a backup
 * till, or one used to mark a sale paid on another terminal, still gets its
 * sales signed. Once an account has a main TSE device, no device sells
 * unsigned in Germany without it showing on the sale.
 */

export type TseDriverId = 'none' | 'swissbit' | 'test' | 'fiskaly';

export interface TseSettings {
  driver: TseDriverId;
  /** The till's serial number as registered with the TSE (the "Kassen-Seriennummer"). */
  clientId: string;
  /** Sign only sales at events in Germany (default), or every sale. */
  scope: 'germany' | 'always';
  /**
   * The main TSE device this till signs through, without a TSE of its own.
   * Fixed once set: a till belongs to exactly one TSE in normal operation
   * (AEAO zu § 146a), and the tax office is told which. Kept per till serial
   * number - a device that must move to another TSE becomes a new till.
   */
  assigned?: { till: string; host: string };
}

/** A time the till's assigned main TSE device could not sign, and another signed instead (or none did). */
export interface TseOutage {
  from: number;
  /** Absent while it lasts. */
  to?: number;
  reason: string;
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

/**
 * What a TSE that composes its own signed record says it signed - fiskaly's
 * receipt QR string, verbatim - so the receipt carries exactly that.
 */
export interface ExactSigned {
  clientId: string;
  processType: string;
  processData: string;
  start: string;
  finish: string;
}

/** What a driver - real hardware or the test TSE - has to do. */
export interface TseDriver {
  available(): Promise<boolean>;
  info(): Promise<TseInfo>;
  /** `via`: the main TSE device that started it, when signing through one - the finish must go to the same TSE. */
  start(clientId: string): Promise<{ number: number; time: number; via?: string }>;
  /** `info`: the identity of the TSE that signed, when it is not this device's. */
  finish(
    clientId: string,
    number: number,
    processType: string,
    processData: string,
    via?: string,
  ): Promise<{ signatureCounter: number; time: number; signature: string; info?: TseInfo; exact?: ExactSigned }>;
}


const KEY = 'core.tse';
const DEFAULTS: TseSettings = { driver: 'none', clientId: '', scope: 'germany' };

/** Synced, account-wide: the device ids of the main TSE devices, in the order they are tried. */
export const TSE_MAIN_KEY = 'core.tseMainDevices';

/**
 * Synced, account-wide: the "Germany (KassenSichV)" switch. It shows or
 * hides the TSE settings, closing the day and the tax export - it never
 * stops a TSE that is set up from signing: an unsigned sale must not be one
 * switch away.
 */
export const KASSENSICHV_KEY = 'core.kassensichv';

export const tseState = reactive<{ settings: TseSettings; info: TseInfo | null; error: string | null; mainDevices: string[]; deviceId: string; outages: TseOutage[]; feature: boolean }>({
  feature: false,
  settings: { ...DEFAULTS },
  info: null,
  error: null,
  mainDevices: [],
  deviceId: '',
  /** This till's outage log, newest last. */
  outages: [],
});

/** Synced per till, so the log outlives the device: outages must be documented (AEAO zu § 146a). */
const outageKey = (till: string): string => `core.tseOutages.${till}`;

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('The TSE was used while signed out.');
  return account.accountId;
}

export async function loadTseSettings(): Promise<TseSettings> {
  const row = await openCoreDb(requireAccountId()).settings.get(KEY);
  tseState.settings = { ...DEFAULTS, ...((row?.value as Partial<TseSettings>) ?? {}) };
  tseState.deviceId = await deviceId();
  applyMainTseDevices(await getSyncedSetting<string[]>(TSE_MAIN_KEY));
  applyKassensichv(await getSyncedSetting<boolean>(KASSENSICHV_KEY));
  tseState.outages = (await getSyncedSetting<TseOutage[]>(outageKey(await tillId()))) ?? [];
  return tseState.settings;
}

/** The till serial number, once the device id is known (after loadTseSettings). */
function currentTill(): string {
  return tseState.settings.clientId.trim() || (tseState.deviceId ? defaultTillId(tseState.deviceId) : '');
}

/** The main TSE device assigned to this till, if any. */
export function assignedTseHost(): string | null {
  const a = tseState.settings.assigned;
  return a && a.till === currentTill() ? a.host : null;
}

/**
 * Assigns this till to a main TSE device - once. Afterwards it signs there,
 * and only while that device is out does another main TSE device sign.
 */
export async function assignTseHost(host: string): Promise<void> {
  tseState.deviceId ||= await deviceId();
  if (assignedTseHost()) throw new Error('This till already has its main TSE device. A till stays with one TSE - use a new till serial number to move.');
  if (!tseState.mainDevices.includes(host) || host === tseState.deviceId) throw new Error('That device is not one of the main TSE devices.');
  await setTseSettings({ assigned: { till: await tillId(), host } });
}

/** Takes in the KassenSichV switch - at load, and whenever sync brings a change. */
export function applyKassensichv(on: unknown): void {
  tseState.feature = on === true;
}

/** Switches the account's Germany (KassenSichV) features on or off. */
export async function setKassensichv(on: boolean): Promise<void> {
  applyKassensichv(on);
  await setSyncedSetting(KASSENSICHV_KEY, on);
}

/**
 * Whether the Germany screens show here: when switched on - or, switched
 * off, while this device still signs (a TSE of its own, or a main TSE
 * device to sign through), so a working TSE never disappears from view.
 */
export function kassensichvVisible(): boolean {
  return tseState.feature || tseMode() !== 'none';
}

/**
 * Whether sales at an event in Germany would go unsigned on this account:
 * the switch is off, or no device has a TSE. For the warning on such events.
 */
export function germanyTseGap(): 'off' | 'no-tse' | null {
  if (!tseState.feature && tseMode() === 'none') return 'off';
  if (tseMode() === 'none' && !tseState.mainDevices.length) return 'no-tse';
  return null;
}

/** Takes in the list of main TSE devices - at load, and whenever sync brings a new one. */
export function applyMainTseDevices(list: unknown): void {
  tseState.mainDevices = Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
}

/** Takes a device off the account's main TSE devices - one replaced or gone, say. */
export async function removeMainTseDevice(id: string): Promise<void> {
  const list = tseState.mainDevices.filter((d) => d !== id);
  applyMainTseDevices(list);
  await setSyncedSetting(TSE_MAIN_KEY, list);
}

/** Makes this device one of the account's main TSE devices, or stops it being one. Only a device with a TSE of its own can be. */
export async function setMainTseDevice(on: boolean): Promise<void> {
  const me = await deviceId();
  if (on && !ownDriverId()) throw new Error('Only a device with a TSE of its own can sign for others.');
  const list = tseState.mainDevices.filter((id) => id !== me);
  if (on) list.push(me);
  applyMainTseDevices(list);
  await setSyncedSetting(TSE_MAIN_KEY, list);
}

/** The till serial number this device signs and numbers receipts under. */
export async function tillId(): Promise<string> {
  return tseState.settings.clientId.trim() || defaultTillId(await deviceId());
}

/** The till serial a device gets unless one is set: stable, short enough to print. */
export function defaultTillId(device: string): string {
  return `ZOLLIFY-${device.slice(0, 8).toUpperCase()}`;
}

export async function setTseSettings(patch: Partial<TseSettings>): Promise<void> {
  tseState.settings = { ...tseState.settings, ...patch };
  tseState.info = null;
  // A plain copy: IndexedDB cannot store the reactive one (its `assigned` is a proxy).
  await openCoreDb(requireAccountId()).settings.put({ key: KEY, value: toPlain({ ...tseState.settings }) });
}

// ── Drivers ─────────────────────────────────────────────────────────────────

const drivers: Partial<Record<TseDriverId, TseDriver>> = {};

/** For tests, and for the native bridge to be swapped in. */
export function registerTseDriver(id: Exclude<TseDriverId, 'none'>, driver: TseDriver): void {
  drivers[id] = driver;
}

/** This device's own TSE, if it has one. */
function ownDriverId(): 'swissbit' | 'test' | 'fiskaly' | null {
  const id = tseState.settings.driver;
  return id === 'swissbit' || id === 'test' || id === 'fiskaly' ? id : null;
}

function ownDriver(): TseDriver | null {
  const id = ownDriverId();
  // One instance per driver: the test TSE's lock only works if every sale goes through the same one.
  if (id === 'swissbit') return (drivers.swissbit ??= swissbitDriver());
  if (id === 'test') return (drivers.test ??= testDriver());
  if (id === 'fiskaly') return (drivers.fiskaly ??= fiskalyDriver());
  return null;
}

/** The main TSE devices besides this one. */
function remoteHosts(): string[] {
  return tseState.mainDevices.filter((id) => id !== tseState.deviceId);
}

/** The order to try: the assigned device, then - only as a stand-in while it is out - the others. */
function signingHosts(): string[] {
  const assigned = assignedTseHost();
  if (!assigned) return [];
  return [assigned, ...remoteHosts().filter((h) => h !== assigned)];
}

/**
 * The TSE this device signs with: its own, or - without one - the account's
 * main TSE devices, when there are any.
 */
function driver(): TseDriver | null {
  return ownDriver() ?? (remoteHosts().length ? remoteDriver() : null);
}

/** How this device signs, for Settings. */
export function tseMode(): 'own' | 'remote' | 'none' {
  return ownDriverId() ? 'own' : remoteHosts().length ? 'remote' : 'none';
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
  if (tseMode() === 'none') return false;
  return tseState.settings.scope === 'always' || countryCodeOf(event?.venue?.country) === 'DE';
}

async function startOn(d: TseDriver): Promise<{ number: number; start: number; via?: string }> {
  const r = await d.start(await tillId());
  return { number: r.number, start: r.time, ...(r.via ? { via: r.via } : {}) };
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

async function finishWith(d: TseDriver, handle: { number: number; start: number; via?: string }, processData: string): Promise<TseSignature> {
  const clientId = await tillId();
  const done = await d.finish(clientId, handle.number, TSE_PROCESS_TYPE, processData, handle.via);
  // A main TSE device says which TSE signed; this device's own is read once.
  const info = done.info ?? tseState.info ?? (await d.info());
  if (!done.info) tseState.info = info;
  // Signed by another main TSE device while the till's own was out.
  const substitute = !!handle.via && handle.via !== assignedTseHost();
  // A cloud TSE says exactly what it signed; that is what the receipt carries.
  const exact = done.exact;
  return {
    ...(substitute ? { substitute: true } : {}),
    clientId: exact?.clientId ?? clientId,
    serial: info.serial,
    transactionNumber: handle.number,
    signatureCounter: done.signatureCounter,
    start: exact?.start ?? tseTime(handle.start),
    finish: exact?.finish ?? tseTime(done.time),
    algorithm: info.algorithm,
    timeFormat: info.timeFormat,
    signature: done.signature,
    publicKey: info.publicKey,
    processType: exact?.processType ?? TSE_PROCESS_TYPE,
    processData: exact?.processData ?? processData,
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
    await d.finish(await tillId(), handle.number, TSE_PROCESS_TYPE, 'AVBelegabbruch^0.00_0.00_0.00_0.00_0.00^', handle.via);
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

// ── Signing through a main TSE device ───────────────────────────────────────

type TseMessage = TseRequestMessage | TseResultMessage;
type TseCall = { op: 'info' } | { op: 'start'; clientId: string } | { op: 'finish'; clientId: string; number: number; processType: string; processData: string };

interface TseTransport {
  /** False when not connected. */
  send(msg: TseMessage): boolean;
  on(handler: (msg: TseMessage) => void): () => void;
}

let transport: TseTransport | null = null;
const waiting = new Map<string, (msg: TseResultMessage) => void>();
/** Long enough for a phone on a busy hall network; short enough not to hold the queue. */
const CALL_TIMEOUT_MS = 8_000;

/**
 * Wired by the live channel (realtime.ts) when it loads. Also where this
 * device starts answering other devices, should it be a main TSE device.
 */
export function setTseTransport(t: TseTransport): void {
  transport = t;
  t.on((msg) => {
    if (msg.type === 'tse.result') waiting.get(msg.requestId)?.(msg);
    else void serve(msg);
  });
}

/** Runs another device's TSE call on this device's TSE - if this is a main TSE device. */
async function serve(msg: TseRequestMessage): Promise<void> {
  const me = await deviceId();
  if (msg.to !== me || !msg.from || !transport) return;
  const reply = (r: Omit<TseResultMessage, 'type' | 'to' | 'requestId'>): void => {
    transport?.send({ type: 'tse.result', to: msg.from!, requestId: msg.requestId, ...r });
  };
  const d = ownDriver();
  if (!d || !tseState.mainDevices.includes(me)) return reply({ ok: false, error: 'That device is no longer a main TSE device.' });
  try {
    if (msg.op === 'info') return reply({ ok: true, info: await d.info() });
    if (msg.op === 'start') {
      const r = await d.start(String(msg.clientId));
      return reply({ ok: true, number: r.number, time: r.time });
    }
    if (msg.op === 'finish') {
      const r = await d.finish(String(msg.clientId), Number(msg.number), String(msg.processType), String(msg.processData));
      // A cloud TSE names the TSE that signed and says exactly what it signed; pass both on.
      return reply({
        ok: true,
        signatureCounter: r.signatureCounter,
        time: r.time,
        signature: r.signature,
        info: r.info ?? tseState.info ?? (tseState.info = await d.info()),
        ...(r.exact ? { exact: r.exact } : {}),
      });
    }
    reply({ ok: false, error: 'Unknown TSE call.' });
  } catch (err) {
    reply({ ok: false, error: reasonOf(err) });
  }
}

/** One TSE call on a main TSE device; throws its error, or when it does not answer. */
function call(host: string, c: TseCall): Promise<TseResultMessage> {
  if (!transport) return Promise.reject(new Error('No live connection to reach the main TSE device.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      reject(new Error('The main TSE device did not answer.'));
    }, CALL_TIMEOUT_MS);
    waiting.set(requestId, (msg) => {
      clearTimeout(timer);
      waiting.delete(requestId);
      if (msg.ok) resolve(msg);
      else reject(new Error(msg.error || 'The main TSE device could not sign.'));
    });
    if (!transport!.send({ type: 'tse.request', to: host, requestId, ...c } as TseRequestMessage)) {
      clearTimeout(timer);
      waiting.delete(requestId);
      reject(new Error('Offline - the main TSE device cannot be reached.'));
    }
  });
}

/**
 * Runs a TSE call on the till's assigned main TSE device - or, while that
 * one is out, on the first other main TSE device that answers, logging the
 * outage. The outage ends the next time the assigned device answers.
 */
async function onFirstHost<T>(work: (host: string) => Promise<T>): Promise<T> {
  const hosts = signingHosts();
  if (!hosts.length) throw new Error('No main TSE device assigned to this till - assign one in Settings → This device → TSE.');
  const errors: string[] = [];
  for (const host of hosts) {
    try {
      const done = await work(host);
      if (host === hosts[0]) await endOutage();
      else await startOutage(errors[0]!);
      return done;
    } catch (err) {
      errors.push(reasonOf(err));
    }
  }
  await startOutage(errors[0]!);
  throw new Error(errors[errors.length - 1]!);
}

async function startOutage(reason: string): Promise<void> {
  const open = tseState.outages[tseState.outages.length - 1];
  if (open && open.to === undefined) return;
  tseState.outages = [...tseState.outages, { from: Date.now(), reason: `Assigned main TSE device: ${reason}` }];
  await saveOutages();
}

async function endOutage(): Promise<void> {
  const open = tseState.outages[tseState.outages.length - 1];
  if (!open || open.to !== undefined) return;
  tseState.outages = [...tseState.outages.slice(0, -1), { ...open, to: Date.now() }];
  await saveOutages();
}

async function saveOutages(): Promise<void> {
  try {
    await setSyncedSetting(outageKey(await tillId()), tseState.outages);
  } catch {
    /* the sale matters more than the log; the next change saves it */
  }
}

function remoteDriver(): TseDriver {
  const infoOf = (r: TseResultMessage): TseInfo => {
    if (!r.info) throw new Error('The main TSE device did not say which TSE it is.');
    return r.info;
  };
  return {
    available: async () => signingHosts().length > 0,
    info: () => onFirstHost(async (host) => infoOf(await call(host, { op: 'info' }))),
    start: (clientId) =>
      onFirstHost(async (host) => {
        const r = await call(host, { op: 'start', clientId });
        return { number: Number(r.number), time: Number(r.time), via: host };
      }),
    finish: async (clientId, number, processType, processData, via) => {
      // A transaction lives on the TSE that started it.
      if (!via) throw new Error('This transaction was not started on a main TSE device.');
      const r = await call(via, { op: 'finish', clientId, number, processType, processData });
      return { signatureCounter: Number(r.signatureCounter), time: Number(r.time), signature: String(r.signature), info: infoOf(r), ...(r.exact ? { exact: r.exact } : {}) };
    },
  };
}

// ── fiskaly cloud TSE, signed on the server ────────────────────────────────

/**
 * fiskaly's cloud TSE. The account's fiskaly key lives on the server, which
 * signs (apps/server/src/modules/fiskaly) - this device only asks, under its
 * own till serial number. Needs a connection while selling; without one the
 * sale is recorded as not signed, like any TSE outage.
 */
interface FiskalyStatus {
  configured: boolean;
  env?: string;
  tss?: { id: string; state: string; serial: string | null } | null;
}

function fiskalyDriver(): TseDriver {
  const status = async (): Promise<FiskalyStatus> => (await authFetch('/m/pos/fiskaly')) as FiskalyStatus;
  return {
    available: async () => (await status()).tss?.state === 'INITIALIZED',
    info: async () => {
      const s = await status();
      if (s.tss?.state !== 'INITIALIZED') throw new Error('The fiskaly TSE is not set up - Settings → TSE (fiskaly).');
      return { serial: s.tss.serial ?? '', publicKey: '', algorithm: 'fiskaly cloud TSE', timeFormat: 'unixTime', certified: s.env === 'LIVE' };
    },
    start: async (clientId) => (await authFetch('/m/pos/fiskaly/start', { method: 'POST', body: JSON.stringify({ clientId }) })) as { number: number; time: number },
    finish: async (clientId, number, processType, processData) =>
      (await authFetch('/m/pos/fiskaly/finish', { method: 'POST', body: JSON.stringify({ clientId, number, processType, processData }) })) as {
        signatureCounter: number;
        time: number;
        signature: string;
        info: TseInfo;
        exact: ExactSigned;
      },
  };
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
  tseState.mainDevices = [];
  tseState.deviceId = '';
  waiting.clear();
  tseState.outages = [];
  tseState.feature = false;
}
