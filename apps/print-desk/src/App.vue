<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
// Straight from its file, not the @zollify/ui barrel: the barrel pulls in @zollify/shared and zod.
import QrCode from '@zollify/ui/QrCode.vue';
import type { DeskRequest } from '../electron/desk';
import type { Material } from '../electron/materials';
import type { MonitorState } from '../electron/statusmonitor';
import type { CatalogRow, CopyProgress, ImageInfo, PrintLink, Printer, Session, Settings, Supply, Theme, Units } from '../electron/shared';
import { effectiveParams, fitToStock, isPrintFile, moveKey, orderRows, paperName, paperNeeds, paperParam, orientFor, settingsFor, sizeFromName, smartFit, targetFor } from '../electron/shared';
import { addTime, duration, estimate, sheetTimer, sizeTimes, type PrintTime } from '../electron/printtimes';
import Icon from './Icon.vue';
import ItemOverrides from './ItemOverrides.vue';
import Menu from './Menu.vue';
import PriceCards from './PriceCards.vue';
import PrintSettings from './PrintSettings.vue';

const api = window.printDesk;
/**
 * A plain copy for IPC. Anything read from `settings` (a row's params) is a
 * Vue reactive proxy, which Electron cannot send: "An object could not be
 * cloned". Every object argument that may hold such values goes through this.
 */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const settings = ref<Settings | null>(null);
const session = ref<Session | null>(null);
const rows = ref<CatalogRow[]>([]);
const printers = ref<Printer[]>([]);
const qty = reactive<Record<string, number>>({});
/** Per item of the current or last print run: copies left, from the print queue. */
const progress = reactive<Record<string, CopyProgress>>({});
const open = ref<string | null>(null);
const busy = ref('');
const error = ref('');
/** What the last bulk change did, e.g. "Paper set for 12 items". */
const notice = ref('');
const filter = ref('');
/** The print run, or the price cards. */
const view = ref<'prints' | 'cards'>('prints');

const login = reactive({ server: '', email: '', password: '', code: '', needs2fa: false });

const links = computed<Record<string, PrintLink>>(() => (session.value && settings.value ? (settings.value.links[session.value.accountId] ?? {}) : {}));
/** Over the whole catalogue, not the filtered rows, so the column does not come and go while typing a filter. */
const hasSku = computed(() => rows.value.some((r) => r.sku));
/** Items printed elsewhere (outsourced): out of the table, the fills and the print run. */
const hiddenKeys = computed(() => new Set(session.value ? (settings.value?.hidden?.[session.value.accountId] ?? []) : []));
const isHidden = (r: CatalogRow): boolean => hiddenKeys.value.has(r.key);
const showHidden = ref(false);
/** The items printed here. */
/** The catalogue in print order: as dragged in the table, items never dragged after, as Zollify lists them. */
const ordered = computed(() => orderRows(rows.value, session.value ? (settings.value?.order?.[session.value.accountId] ?? []) : []));
const active = computed(() => ordered.value.filter((r) => !isHidden(r)));
/** The table's rows before the size and text filters: the hidden ones too when they are shown. */
const listed = computed(() => (showHidden.value ? ordered.value : active.value));
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return listed.value.filter(
    (r) => (!onlySize.value || printSize(r) === onlySize.value) && (!q || `${r.title} ${r.variant} ${r.sku}`.toLowerCase().includes(q)),
  );
});
/** The paper sizes in the table, for the quick filter: A sizes and others by name, a custom size last. */
const tableSizes = computed(() => [...new Set(listed.value.map(printSize))].sort((a, b) => (a === 'custom' ? 1 : b === 'custom' ? -1 : a.localeCompare(b))));
/** The paper an item prints on ("a3"), or "custom". */
const printSize = (r: CatalogRow): string => paperName(paramsFor(r).paper) ?? 'custom';
/** One paper size for the table and the print run ('' every size): the quick filter, and the Paper needed chips. */
const onlySize = ref('');
/** Every item with copies to print and a file to print them from. */
const queuedAll = computed(() => active.value.filter((r) => (qty[r.key] ?? 0) > 0 && links.value[r.key]?.file));
/** What Print sends: the queued items, of one paper size when one is picked. */
const queued = computed(() => (onlySize.value ? queuedAll.value.filter((r) => printSize(r) === onlySize.value) : queuedAll.value));
const totalCopies = computed(() => queued.value.reduce((n, r) => n + (qty[r.key] ?? 0), 0));
/** Copies of the current run not printed yet; null once nothing is printing. */
const copiesLeft = computed(() => {
  const active = Object.values(progress).filter((p) => !p.done);
  return active.length ? Object.values(progress).reduce((n, p) => n + p.left, 0) : null;
});

async function guard<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = what;
  error.value = '';
  try {
    return await fn();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return undefined;
  } finally {
    busy.value = '';
  }
}

onMounted(async () => {
  settings.value = await api.settings.get();
  login.server = settings.value.server || 'https://';
  session.value = await api.zollify.resume();
  // Listening before loadAll: it picks up jobs from before a restart, whose progress comes at once.
  api.photocraft.onMonitor((state) => {
    const was = monitor.value?.prompt;
    monitor.value = state;
    void recordSheet(timer.see(state, Date.now()));
    // A new wait goes to Zollify now, not at the next report, so the phone hears it while it matters.
    if (state.prompt && state.prompt !== was) void deskTick();
  });
  api.photocraft.onQueue((p) => {
    progress[p.key] = p;
    // The job left the queue: its last sheet is out.
    if (p.done) void recordSheet(timer.stop(Date.now()));
    // A job picked up again: what was counted before is where this desk's counting starts.
    if (p.base !== undefined && counted[p.key] === undefined) {
      counted[p.key] = p.base;
      paperCounted[p.key] = p.base;
    }
    void countPrinted(p);
  });
  if (session.value) await loadAll();
});

async function loadAll(): Promise<void> {
  await Promise.all([refreshCatalog(), refreshPrinters(), loadMaterials(), syncShared()]);
  void refreshSupplies();
  // Jobs still in the print queue from before this start: followed (and counted) again.
  const following = await api.photocraft.resume().catch(() => 0);
  if (following) notice.value = `Following ${following} ${following === 1 ? 'print job' : 'print jobs'} already in the print queue: their copies count as they come out.`;
}
async function refreshCatalog(): Promise<void> {
  await guard('Loading catalogue', async () => {
    rows.value = await api.zollify.catalog();
    syncedAt.value = new Date();
  });
}
/** When the stock was last read from Zollify. */
const syncedAt = ref<Date | null>(null);
/** How often the stock is read again, so a count made in the Zollify app shows here too. */
const RESYNC_MS = 30_000;
/**
 * Reads the catalogue and stock again without a busy state: only what changed since the last
 * read comes over. Skipped while something else runs; an error waits for the next try.
 */
async function resync(): Promise<void> {
  if (!session.value || busy.value) return;
  try {
    const fresh = await api.zollify.catalog();
    if (session.value) {
      rows.value = fresh;
      syncedAt.value = new Date();
    }
    await Promise.all([loadMaterials(), syncShared()]);
  } catch {
    /* offline for a moment: the next resync tries again */
  }
}
const resyncTimer = setInterval(() => void resync(), RESYNC_MS);

// ── Zollify's Print Desk module: settings shared with the other desks, this desk's status, requests ──
/** Sends shared settings changed here and takes on what other devices set. */
async function syncShared(): Promise<void> {
  try {
    settings.value = await api.desk.sync();
  } catch {
    /* the module is off for this account, or Zollify can't be reached: the settings here stand */
  }
}
/** What the printer's status monitor says: the sheet printing, and what it waits for. */
const monitor = ref<MonitorState | null>(null);
/** The item whose linked file is `document` (the name the monitor and the queue give it). */
const rowOfDocument = (document: string): CatalogRow | undefined => {
  const doc = document.toLowerCase();
  return doc ? rows.value.find((r) => (links.value[r.key]?.file ?? '').split(/[\\/]/).pop()?.toLowerCase() === doc) : undefined;
};
/** The item the printer waits on: the one whose file the monitor names. */
const waitingRow = computed(() => (monitor.value?.prompt ? rowOfDocument(monitor.value.document) : undefined));

// ── How long prints take: each sheet timed from the status monitor, per item and per paper size ──
const timer = sheetTimer();
const printTimes = computed<Record<string, PrintTime>>(() => (session.value ? (settings.value?.printTimes?.[session.value.accountId] ?? {}) : {}));
const timesBySize = computed(() => {
  const size = new Map(rows.value.map((r) => [r.key, printSize(r)]));
  return sizeTimes(printTimes.value, (key) => size.get(key));
});
/** How long a sheet of the item takes: its own time, else its size's; null when neither was timed. */
const sheetTime = (r: CatalogRow): { ms: number; own: boolean } | null => {
  const own = printTimes.value[r.key];
  if (own) return { ms: own.ms, own: true };
  const size = timesBySize.value[printSize(r)];
  return size ? { ms: size.ms, own: false } : null;
};
/** A sheet the printer finished: its item learns the time. */
async function recordSheet(done: { document: string; ms: number } | null): Promise<void> {
  const row = done && rowOfDocument(done.document);
  if (!done || !row || !session.value || !settings.value) return;
  const all = plain(settings.value.printTimes ?? {});
  const mine = (all[session.value.accountId] ??= {});
  mine[row.key] = addTime(mine[row.key], done.ms);
  settings.value = await api.settings.set({ printTimes: all });
}
/** The printing ahead (waits at the printer not counted): what is left of a run, else what Print would send. */
const timeAhead = computed(() => {
  const running = Object.values(progress).filter((p) => !p.done && p.left > 0);
  const copies = running.length
    ? running.flatMap((p) => {
        const row = rows.value.find((r) => r.key === p.key);
        return row ? [{ key: row.key, size: printSize(row), copies: p.left }] : [];
      })
    : queued.value.map((r) => ({ key: r.key, size: printSize(r), copies: qty[r.key] ?? 0 }));
  const e = estimate(copies, printTimes.value, timesBySize.value);
  if (!e.ms) return '';
  return `${e.unknown ? 'over ' : 'about '}${duration(e.ms)}${running.length ? ' left' : ''} of printing${e.unknown ? ` (${e.unknown} ${e.unknown === 1 ? 'copy' : 'copies'} not timed yet)` : ''}`;
});
/** The paper to load for it ("A3"); none for a custom size, which has no name to give. */
const waitingPaper = computed(() => {
  const size = waitingRow.value ? printSize(waitingRow.value) : 'custom';
  return size === 'custom' ? '' : sizeLabel(size);
});
/** The copy the printer waits on, with the sheet it is at. */
const waitingFor = computed(() => {
  const m = monitor.value;
  if (!m?.prompt) return '';
  const row = waitingRow.value;
  const name = row ? (row.variant ? `${row.title} ${row.variant}` : row.title) : m.document;
  return [name, m.page ? `copy ${m.page.at} of ${m.page.of}` : ''].filter(Boolean).join(', ');
});
/** How often the desk tells Zollify what it is doing, and looks for requests. */
const DESK_MS = 5000;
let deskTicking = false;
async function deskTick(): Promise<void> {
  if (!session.value || deskTicking) return;
  deskTicking = true;
  try {
    await api.desk.report(
      plain({
        printer: String(globalParams.value?.printer ?? printers.value.find((p) => p.default)?.name ?? ''),
        counts: Object.fromEntries(active.value.map((r) => [r.key, qty[r.key] ?? 0])),
        run: Object.values(progress),
        paper: Object.fromEntries(Object.entries(needs.value).map(([size, needed]) => [size, { needed, onHand: paperOnHand(size) }])),
        ...(supplies.value
          ? {
              supplies: supplies.value.map((s) => {
                const m = supplyMaterial(s);
                return { ...s, ...(m ? { material: m.name, stock: m.onHand } : {}) };
              }),
            }
          : {}),
        busy: busy.value,
        error: error.value,
        waiting: monitor.value?.prompt ?? '',
        waitingFor: waitingFor.value,
        waitingPaper: waitingPaper.value,
        sheetMs: Object.fromEntries(active.value.flatMap((r) => {
          const t = sheetTime(r);
          return t ? [[r.key, t.ms]] : [];
        })),
      }),
    );
    // Not awaited: a print request runs as long as the run, and the reports keep going meanwhile.
    for (const r of await api.desk.requests()) if (await api.desk.claim(r.id)) void doRequest(r);
  } catch {
    /* the module is off, or offline: the next tick tries again */
  } finally {
    deskTicking = false;
  }
}
/** Does what another device asked; printing only when this desk allows it. */
async function doRequest(r: DeskRequest): Promise<void> {
  const answer = (status: 'done' | 'failed' | 'refused', result: string): Promise<void> => api.desk.outcome(r.id, status, result).catch(() => undefined);
  const copiesOf = (n: number): string => `${n} ${n === 1 ? 'copy' : 'copies'}`;
  if (r.kind === 'counts') {
    const counts = r.payload.counts ?? {};
    for (const row of rows.value) qty[row.key] = counts[row.key] ?? 0;
    const copies = Object.values(counts).reduce((n, c) => n + c, 0);
    notice.value = `Print counts set from another device: ${copiesOf(copies)}.`;
    return answer('done', `Counts set: ${copiesOf(copies)}.`);
  }
  if (r.kind === 'fill') {
    if (busy.value) return answer('failed', 'The desk is busy. Try again in a moment.');
    // One size asked for: the others keep their counts.
    const size = r.payload.onlySize;
    const kept = size ? rows.value.filter((row) => printSize(row) !== size).map((row) => [row.key, qty[row.key] ?? 0] as const) : [];
    notice.value = '';
    const how = r.payload.how;
    if (how === 'last-event') await fillFromLastEvent();
    else if (how === 'target') await fillToTarget();
    else if (how === 'smart-fit') await smartFitToPaperStock();
    else if (how === 'fit') fitToPaperStock();
    for (const [key, n] of kept) qty[key] = n;
    return error.value ? answer('failed', error.value) : answer('done', notice.value || 'Filled.');
  }
  if (!settings.value?.allowRemote) return answer('refused', 'Printing on request is off on this desk: switch it on under Setup.');
  if (busy.value || copiesLeft.value !== null) return answer('failed', 'The desk is busy printing. Try again when this run is done.');
  onlySize.value = r.payload.onlySize ?? '';
  if (!queued.value.length) return answer('failed', `Nothing to print${onlySize.value ? ` in ${sizeLabel(onlySize.value)}` : ''}: no copies queued with a file linked.`);
  const copies = totalCopies.value;
  notice.value = `Printing ${copiesOf(copies)}, as asked from another device.`;
  await printAll();
  return error.value ? answer('failed', error.value) : answer('done', `Sent ${copiesOf(copies)} to the printer.`);
}
const deskTimer = setInterval(() => void deskTick(), DESK_MS);

// ── Ink and maintenance cartridge: levels from the printer, stock from Zollify materials ──
/** The printer's tanks and maintenance cartridge, as last read; null before (or when it can't say). */
const supplies = ref<Supply[] | null>(null);
const SUPPLIES_MS = 5 * 60_000;
/** The printer this desk prints on: the global settings', else the system default. */
const deskPrinter = computed(() => String(globalParams.value?.printer ?? printers.value.find((p) => p.default)?.name ?? ''));
const supplyMaterial = (s: Supply): Material | undefined => materialOf(settings.value?.supplyMaterials?.[s.id]);
const supplyLabel = (s: Supply): string => (s.kind === 'maintenance' ? 'Maintenance cartridge' : `${s.name} ink`);
const supplyLevel = (s: Supply): string => (s.kind === 'maintenance' ? `${s.level}% full` : `${s.level}%`);
const supplyWarning = (s: Supply): string => (s.kind === 'maintenance' ? (s.state === 'out' ? 'full' : 'nearly full') : s.state === 'out' ? 'empty' : 'low');
/** Tanks low or empty (the cartridge nearly full), for the warning under the toolbar. */
const lowSupplies = computed(() => (supplies.value ?? []).filter((s) => s.state === 'low' || s.state === 'out'));
/** Levels last seen, kept over restarts, to notice a tank swapped for a new one. */
const LEVELS_KEY = 'print-desk.supplyLevels';
function seenLevels(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LEVELS_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}
/**
 * A tank (or cartridge) whose level jumped up was swapped for a new one: one comes off its
 * material in Zollify, so the stock the warnings go by stays right.
 */
async function countSwapped(fresh: Supply[]): Promise<void> {
  const seen = seenLevels();
  for (const s of fresh) {
    const was = seen[s.id];
    const material = settings.value?.supplyMaterials?.[s.id];
    if (was === undefined || !material || !paperVia.value) continue;
    // A new tank fills the level back up; a new maintenance cartridge (which fills with waste) empties it.
    if ((s.kind === 'maintenance' ? was - s.level : s.level - was) < 40) continue;
    try {
      const res = await api.materials.use({ material, qty: 1, note: `${supplyLabel(s)} replaced in ${deskPrinter.value} · Print Desk`, job: `swap|${s.id}|${Date.now()}` });
      const i = materials.value.findIndex((m) => m.id === res.material.id);
      if (i >= 0) materials.value[i] = res.material;
      notice.value = `${supplyLabel(s)} replaced: one taken off ${res.material.name} (${res.material.onHand} left).`;
    } catch (err) {
      error.value = `Could not take the new ${supplyLabel(s)} off the materials: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  try {
    localStorage.setItem(LEVELS_KEY, JSON.stringify(Object.fromEntries(fresh.map((s) => [s.id, s.level]))));
  } catch {
    /* no storage: a swap goes unnoticed */
  }
}
async function refreshSupplies(): Promise<void> {
  if (!deskPrinter.value) return;
  const fresh = await api.photocraft.supplies(deskPrinter.value).catch(() => null);
  if (!fresh) return;
  await countSwapped(fresh);
  supplies.value = fresh;
}
const suppliesTimer = setInterval(() => void refreshSupplies(), SUPPLIES_MS);
async function setSupplyMaterial(s: Supply, id: string): Promise<void> {
  const next = { ...(settings.value?.supplyMaterials ?? {}) };
  if (id) next[s.id] = id;
  else delete next[s.id];
  settings.value = await api.settings.set({ supplyMaterials: next });
}
async function toggleAllowRemote(on: boolean): Promise<void> {
  settings.value = await api.settings.set({ allowRemote: on });
  void deskTick();
}
const onFocus = (): void => void resync();
window.addEventListener('focus', onFocus);
onBeforeUnmount(() => {
  clearInterval(resyncTimer);
  clearInterval(deskTimer);
  clearInterval(suppliesTimer);
  window.removeEventListener('focus', onFocus);
});
async function refreshPrinters(): Promise<void> {
  try {
    printers.value = await api.photocraft.printers();
  } catch (err) {
    printers.value = [];
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function signIn(): Promise<void> {
  busy.value = 'Signing in';
  error.value = '';
  try {
    session.value = await api.zollify.login({ server: login.server.trim(), email: login.email.trim(), password: login.password, code: login.code.trim() || undefined });
    login.password = '';
    login.code = '';
    login.needs2fa = false;
    settings.value = await api.settings.get();
    await loadAll();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    login.needs2fa = msg.includes('2FA:');
    error.value = msg.replace(/^.*2FA:/, '');
  } finally {
    busy.value = '';
  }
}
// ── Sign in by QR: a signed-in phone scans and approves; this app polls for the session ──
const QR_POLL_MS = 2000;
const qr = reactive({ mode: false, value: '', state: 'waiting' as 'waiting' | 'denied' | 'expired' });
let link: { id: string; pollSecret: string } | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function stopQr(): void {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  link = null;
}
/** An http(s) address with a host: localhost and bare IPs included. */
function serverOk(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
  } catch {
    return false;
  }
}
async function startQr(): Promise<void> {
  stopQr();
  error.value = '';
  if (!serverOk(login.server)) {
    error.value = 'Enter your Zollify server address first, e.g. https://zollify.example.com';
    return;
  }
  qr.mode = true;
  qr.state = 'waiting';
  qr.value = '';
  try {
    const started = await api.zollify.linkStart(login.server.trim());
    link = { id: started.id, pollSecret: started.pollSecret };
    qr.value = started.qr;
    pollTimer = setTimeout(pollQr, QR_POLL_MS);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    qr.mode = false;
  }
}
async function pollQr(): Promise<void> {
  const current = link;
  if (!current) return;
  let r: Awaited<ReturnType<typeof api.zollify.linkPoll>>;
  try {
    r = await api.zollify.linkPoll(current.id, current.pollSecret);
  } catch {
    // A dropped request mid-wait is not the end: try again next tick.
    if (link === current) pollTimer = setTimeout(pollQr, QR_POLL_MS);
    return;
  }
  // Cancelled, or a fresh code was started while this one was in flight.
  if (link !== current) return;
  if (r.status === 'approved' && r.session) {
    stopQr();
    qr.mode = false;
    session.value = r.session;
    settings.value = await api.settings.get();
    await loadAll();
    return;
  }
  if (r.status === 'pending') {
    if (r.qr) qr.value = r.qr;
    pollTimer = setTimeout(pollQr, QR_POLL_MS);
    return;
  }
  stopQr();
  qr.state = r.status === 'denied' ? 'denied' : 'expired';
}
function closeQr(): void {
  stopQr();
  qr.mode = false;
}
onBeforeUnmount(stopQr);

async function signOut(): Promise<void> {
  await api.zollify.logout();
  session.value = null;
  rows.value = [];
}

/** Writes this account's links: `change` edits a copy, which is sent as plain JSON whatever was put in it. */
async function writeLinks(change: (mine: Record<string, PrintLink>) => void): Promise<void> {
  if (!settings.value || !session.value) return;
  const acc = session.value.accountId;
  const all = plain(settings.value.links);
  const mine = (all[acc] ??= {});
  change(mine);
  try {
    settings.value = await api.settings.set({ links: plain(all) });
  } catch (err) {
    error.value = `Could not save the print settings: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
}
async function saveLink(key: string, link: PrintLink): Promise<void> {
  await writeLinks((mine) => {
    mine[key] = link;
  });
}
/** An item's own print settings, or the defaults when it has none yet. File '' = settings without a linked file. */
const paramsOf = (key: string): Record<string, unknown> => links.value[key]?.params ?? defaultParams();
const sizeOf = (row: CatalogRow): string | null => sizeFromName(row.variant, row.title);
const globalParams = computed(() => settings.value?.global ?? null);
/** Whether the item prints with the global settings. */
const usesGlobal = (row: CatalogRow): boolean => !!globalParams.value && !links.value[row.key]?.own;
/** What the item prints with: its own settings, or the global ones with its paper and orientation. */
const paramsFor = (row: CatalogRow): Record<string, unknown> => effectiveParams(links.value[row.key], globalParams.value, sizeOf(row)) ?? defaultParams();
/** `open` for the global settings panel (no stock key looks like this). */
const GLOBAL = '*global';
/** `open` for the paper stock panel. */
const PAPER = '*paper';

// ── Paper stock: Zollify materials used up per printed copy ──
const materials = ref<Material[]>([]);
const keyInput = ref('');
const paperNote = ref('');
/**
 * The paper sizes this catalogue prints on: what each item is set to, and the A size in its name
 * (named sizes only: a custom size has no material).
 */
const paperSizes = computed(() => [...new Set(rows.value.flatMap((r) => [paperName(paramsFor(r).paper), sizeOf(r)]).filter((n): n is string => !!n))].sort());
const materialOf = (id: string | undefined): Material | undefined => materials.value.find((m) => m.id === id);
/** Sheets of each paper size the queued copies need. */
const needs = computed(() => paperNeeds(queuedAll.value.map((r) => ({ key: r.key, size: printSize(r), copies: qty[r.key] ?? 0 }))));
/** Sheets on hand of a paper size, from its material in Zollify; null when none is set for it. */
const paperOnHand = (size: string): number | null => materialOf(settings.value?.paperMaterials?.[size])?.onHand ?? null;
const shortSizes = computed(() => Object.entries(needs.value).filter(([size, n]) => (paperOnHand(size) ?? Infinity) < n).map(([size]) => size));
const sizeLabel = (size: string): string => (size === 'custom' ? 'Custom size' : paperLabel(size));
/** "Fit to paper stock": per size short of paper, the copies cut in proportion to what each item wanted. */
/**
 * Clears the counts of items in these paper sizes that have no file linked: they can't print, so
 * a fit that shares out the paper shouldn't leave them looking like part of the run. Their names.
 */
function clearUnprintable(sizes: string[]): string[] {
  const names: string[] = [];
  for (const r of active.value) {
    if ((qty[r.key] ?? 0) > 0 && !links.value[r.key]?.file && sizes.includes(printSize(r))) {
      qty[r.key] = 0;
      names.push(r.variant ? `${r.title} ${r.variant}` : r.title);
    }
  }
  return names;
}
const clearedNote = (names: string[]): string =>
  names.length ? ` ${names.join(', ')} had copies but no file linked, so ${names.length === 1 ? 'it' : 'they'} can't print: cleared.` : '';

function fitToPaperStock(): void {
  const short = [...shortSizes.value];
  const items = queuedAll.value.map((r) => ({ key: r.key, size: printSize(r), copies: qty[r.key] ?? 0 }));
  const stock = Object.fromEntries(Object.keys(needs.value).flatMap((size) => (paperOnHand(size) === null ? [] : [[size, paperOnHand(size)!]])));
  const before = { ...needs.value };
  const fitted = fitToStock(items, stock);
  for (const [key, n] of Object.entries(fitted)) qty[key] = n;
  const cleared = clearUnprintable(short);
  const cut = Object.keys(before).filter((size) => (needs.value[size] ?? 0) < before[size]!);
  notice.value =
    (cut.length
      ? `Fitted to the paper on hand: ${cut.map((size) => `${sizeLabel(size)} ${before[size]} → ${needs.value[size] ?? 0} sheets`).join(', ')}. Each item keeps its share of what it wanted.`
      : 'Nothing to fit: every paper size has enough on hand, or no material is set for it under Paper stock.') + clearedNote(cleared);
}
/**
 * "Smart fit to stock": per size short of paper, each sheet goes to the copy most likely to sell
 * at the next event, weighed by its price, from Zollify's sales (see demandForecast, smartFit).
 */
async function smartFitToPaperStock(): Promise<void> {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const forecast = await guard('Reading what sells', () => api.zollify.forecast(iso));
  if (!forecast) return;
  const items = queuedAll.value.map((r) => ({
    key: r.key,
    size: printSize(r),
    copies: qty[r.key] ?? 0,
    onHand: r.onHand,
    mean: r.key in forecast.perDay ? forecast.perDay[r.key]! * forecast.horizonDays : null,
    price: forecast.price[r.key] ?? 0,
  }));
  const stock = Object.fromEntries(Object.keys(needs.value).flatMap((size) => (paperOnHand(size) === null ? [] : [[size, paperOnHand(size)!]])));
  const before = { ...needs.value };
  const { counts, gain } = smartFit(items, stock);
  for (const [key, n] of Object.entries(counts)) qty[key] = n;
  const cleared = clearUnprintable(Object.keys(gain));
  const cut = Object.keys(gain);
  if (!cut.length) {
    notice.value = 'Nothing to fit: every paper size has enough on hand, or no material is set for it under Paper stock.';
    return;
  }
  const ev = forecast.event;
  const forWhat = ev ? `${ev.name || 'the next event'} (${ev.days} ${ev.days === 1 ? 'day' : 'days'}${ev.factor !== 1 ? `, earlier editions ${ev.factor > 1 ? 'busier' : 'quieter'} ×${ev.factor}` : ''})` : 'an average event';
  const noHistory = items.filter((i) => i.mean === null && i.copies > 0).length;
  notice.value =
    `Smart fit for ${forWhat}: ` +
    cut.map((size) => `${sizeLabel(size)} ${before[size]} → ${needs.value[size] ?? 0} sheets, of which about ${Math.round(gain[size]!.units)} should sell (worth about ${Math.round(gain[size]!.value)})`).join('; ') +
    '. The sheets went to the copies most likely to sell, dearer prints first.' +
    (noHistory ? ` ${noHistory} ${noHistory === 1 ? 'item has' : 'items have'} no sales in the last year, so ${noHistory === 1 ? 'its' : 'their'} own count stood in for a forecast.` : '') +
    clearedNote(cleared);
}

// A size no item prints on any more goes back to every size.
watch(tableSizes, (sizes) => {
  if (onlySize.value && !sizes.includes(onlySize.value)) onlySize.value = '';
});
async function setHidden(row: CatalogRow, hidden: boolean): Promise<void> {
  if (!session.value) return;
  const all = plain(settings.value?.hidden ?? {});
  const mine = new Set(all[session.value.accountId] ?? []);
  if (hidden) mine.add(row.key);
  else mine.delete(row.key);
  all[session.value.accountId] = [...mine];
  if (hidden) qty[row.key] = 0;
  settings.value = await api.settings.set({ hidden: all });
  notice.value = hidden ? `${row.variant ? `${row.title} ${row.variant}` : row.title} is hidden: printed elsewhere, so out of the fills and the print run. "Show hidden" brings it back.` : '';
}
/** How the materials are reached: the Zollify sign-in, the printer key, or not at all. */
const paperVia = ref<'session' | 'key' | null>(null);
/** Why the sign-in can't reach the materials, when it can't. */
const paperWhy = ref('');
async function loadMaterials(): Promise<void> {
  if (!session.value) return;
  try {
    const access = await api.materials.list();
    materials.value = access.materials;
    paperVia.value = access.via;
    paperWhy.value = access.note;
    paperNote.value = '';
  } catch (err) {
    paperNote.value = `Could not read the materials: ${err instanceof Error ? err.message : String(err)}`;
  }
}
watch(open, (o) => {
  if (o === PAPER) void loadMaterials();
});
async function saveKey(): Promise<void> {
  paperNote.value = '';
  try {
    settings.value = await api.materials.setKey(keyInput.value);
    keyInput.value = '';
    await loadMaterials();
  } catch (err) {
    paperNote.value = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
  }
}
async function removeKey(): Promise<void> {
  settings.value = await api.materials.setKey('');
  materials.value = [];
  await loadMaterials();
}
async function setPaperMaterial(size: string, id: string): Promise<void> {
  const next = { ...(settings.value?.paperMaterials ?? {}) };
  if (id) next[size] = id;
  else delete next[size];
  settings.value = await api.settings.set({ paperMaterials: next });
}

async function saveGlobal(params: Record<string, unknown> | null): Promise<void> {
  try {
    settings.value = await api.settings.set({ global: params && plain(params) });
    notice.value = params
      ? 'Global print settings saved. Items without their own settings print with them, each on its own paper and orientation.'
      : 'Global print settings removed. Every item prints with its own settings again.';
  } catch (err) {
    error.value = `Could not save the global print settings: ${err instanceof Error ? err.message : String(err)}`;
  }
}
/** Images of linked files, by path, as PhotoCraft reads them: for print sizes in the settings. */
const images = reactive<Record<string, ImageInfo | null>>({});
watch(open, async (key) => {
  const file = key ? links.value[key]?.file : '';
  if (!file || file in images) return;
  images[file] = null;
  images[file] = await api.photocraft.size(file).catch(() => null);
});
const imageOf = (row: CatalogRow): ImageInfo | null => images[links.value[row.key]?.file ?? ''] ?? null;
const units = computed<Units>(() => settings.value?.units ?? 'cm');
async function setUnits(u: Units): Promise<void> {
  settings.value = await api.settings.set({ units: u });
}
async function setOverrides(row: CatalogRow, overrides: Record<string, unknown>): Promise<void> {
  const cur = links.value[row.key];
  await saveLink(row.key, { ...cur, file: cur?.file ?? '', params: cur?.params ?? defaultParams(), overrides });
}

/** Items whose print settings another can copy: every other item with settings of its own or changes to the global ones. */
const copySources = (row: CatalogRow): CatalogRow[] =>
  ordered.value.filter((r) => r.key !== row.key && (links.value[r.key]?.own || Object.keys(links.value[r.key]?.overrides ?? {}).length || (!globalParams.value && links.value[r.key])));
const settingsKind = (r: CatalogRow): string =>
  links.value[r.key]?.own || !globalParams.value ? `own settings, ${paperLabel(paramsFor(r).paper)}` : `global, changed`;
/**
 * Copies another item's print settings onto this one: own settings or the global ones with its
 * changes, printer, paper, scaling and driver settings. The item keeps its orientation (from its
 * image), and its own paper when its name says another size than the source's. Its file stays.
 */
async function copySettings(row: CatalogRow, sourceKey: string): Promise<void> {
  const source = ordered.value.find((r) => r.key === sourceKey);
  const from = links.value[sourceKey];
  if (!source || !from) return;
  const cur = links.value[row.key];
  const orientation = cur?.params.orientation;
  const sameSize = !sizeOf(row) || sizeOf(row) === sizeOf(source);
  const params = { ...settingsFor(plain(from.params), sizeOf(source), sizeOf(row)), ...(orientation ? { orientation } : {}) };
  const overrides = Object.fromEntries(Object.entries(plain(from.overrides ?? {})).filter(([k]) => k !== 'orientation' && (sameSize || k !== 'paper')));
  await saveLink(row.key, { file: cur?.file ?? '', params, ...(from.own ? { own: true } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) });
  notice.value =
    `Print settings copied from ${source.variant ? `${source.title} ${source.variant}` : source.title}.` +
    (orientation ? ' The orientation stays as its image has it.' : '') +
    (sameSize ? '' : ` The paper stays ${paperLabel(paramsFor(row).paper)}, the size in its name.`);
}

/** Gives an item its own settings (a copy of what it prints with now), or back to the global ones. */
async function setOwn(row: CatalogRow, own: boolean): Promise<void> {
  const cur = links.value[row.key];
  await saveLink(row.key, { file: cur?.file ?? '', params: own ? paramsFor(row) : (cur?.params ?? defaultParams()), own });
}
const paperLabel = (paper: unknown): string => {
  const name = paperName(paper ?? 'letter');
  return name ? (/^a\d$/.test(name) ? name.toUpperCase() : name) : 'custom paper';
};

/** "Apply to all (A3) items": these settings for every other item, or every other item of this one's size. */
async function applySettings(source: CatalogRow, params: Record<string, unknown>, scope: 'all' | 'size'): Promise<void> {
  const size = sizeOf(source);
  const targets = rows.value.filter((r) => r.key !== source.key && (scope === 'all' || sizeOf(r) === size));
  const what = `${scope === 'size' ? `${size!.toUpperCase()} ` : ''}${targets.length === 1 ? 'item' : 'items'}`;
  if (!targets.length) {
    notice.value = `There are no other ${scope === 'size' ? `${size!.toUpperCase()} ` : ''}items.`;
    return;
  }
  if (!window.confirm(`Use these print settings for ${targets.length} other ${what}? Their own print settings are replaced. Linked files stay as they are.`)) return;
  await writeLinks((mine) => {
    mine[source.key] = { ...mine[source.key], file: mine[source.key]?.file ?? '', params };
    for (const t of targets) {
      const next = settingsFor(params, size, sizeOf(t));
      mine[t.key] = { ...mine[t.key], file: mine[t.key]?.file ?? '', params: next };
    }
  });
  notice.value = `Print settings applied to ${targets.length} ${what}. Items of another size keep their own paper; their driver settings are set to it when they print.`;
}

/**
 * Sets every item's print count and says what that comes to: `counts` per stock key (0 when
 * absent), `what` opens the notice, `none` is the notice when nothing is to print.
 */
function fillCounts(counts: Record<string, number>, what: string, none: string): void {
  let copies = 0;
  let items = 0;
  const noFile: string[] = [];
  for (const r of rows.value) {
    const n = isHidden(r) ? 0 : Math.max(0, Math.min(999, Math.floor(counts[r.key] ?? 0)));
    qty[r.key] = n;
    if (!n) continue;
    copies += n;
    items++;
    if (!links.value[r.key]?.file) noFile.push(r.variant ? `${r.title} ${r.variant}` : r.title);
  }
  notice.value = items
    ? `${what}: ${copies} ${copies === 1 ? 'copy' : 'copies'} of ${items} ${items === 1 ? 'item' : 'items'}.` +
      (noFile.length ? ` No file linked, so not printed: ${noFile.slice(0, 5).join(', ')}${noFile.length > 5 ? ` and ${noFile.length - 5} more` : ''}.` : '')
    : none;
}

const count = (value: number): number => Math.max(0, Math.min(999, Math.floor(value) || 0));
async function setTarget(value: number): Promise<void> {
  settings.value = await api.settings.set({ target: count(value) });
}
/** The A sizes in the catalogue, smallest number (largest paper) first, for per-size targets. */
const sizes = computed(() => [...new Set(rows.value.map(sizeOf).filter((s): s is string => !!s))].sort());
const showSizeTargets = ref(false);
/** A size's own target; an empty box (NaN) clears it, so the size uses the main target again. */
async function setSizeTarget(size: string, value: number): Promise<void> {
  const next = { ...(settings.value?.sizeTargets ?? {}) };
  if (Number.isNaN(value)) delete next[size];
  else next[size] = count(value);
  settings.value = await api.settings.set({ sizeTargets: next });
}
/** This account's own targets per item. */
const itemTargets = computed<Record<string, number>>(() => (session.value ? (settings.value?.itemTargets?.[session.value.accountId] ?? {}) : {}));
/** What the item's target falls back to without its own: its size's, else the main one. */
const fallbackTargetOf = (row: CatalogRow): number => targetFor(undefined, sizeOf(row), settings.value?.target ?? 0, settings.value?.sizeTargets);
const targetOf = (row: CatalogRow): number => targetFor(itemTargets.value[row.key], sizeOf(row), settings.value?.target ?? 0, settings.value?.sizeTargets);
/** An item's own target; an empty box (NaN) clears it, so the item uses its size's or the main one again. */
async function setItemTarget(row: CatalogRow, value: number): Promise<void> {
  if (!session.value) return;
  const all = plain(settings.value?.itemTargets ?? {});
  const mine = (all[session.value.accountId] ??= {});
  if (Number.isNaN(value)) delete mine[row.key];
  else mine[row.key] = count(value);
  settings.value = await api.settings.set({ itemTargets: all });
}
/** "Fill to target": each item's print count = what it takes to reach its target stock, from the latest stock. */
async function fillToTarget(): Promise<void> {
  await resync();
  fillCounts(
    Object.fromEntries(rows.value.map((r) => [r.key, targetOf(r) - r.onHand])),
    'Filled up to each item\'s target stock',
    rows.value.some((r) => targetOf(r) > 0) ? 'Every item is at or above its target stock. Print counts are cleared.' : 'Set a target stock first.',
  );
}

/** "Fill from last event": each item's print count = what the last closed event sold of it. */
async function fillFromLastEvent(): Promise<void> {
  const found = await guard('Reading the last closed event', () => api.zollify.lastEventSold());
  if (found === undefined) return;
  if (!found) {
    notice.value = 'No closed event yet: close an event in Zollify, then fill from it.';
    return;
  }
  const { event, sold } = found;
  const name = event.name || 'the last event';
  const dates = event.dateStart ? ` (${event.dateStart}${event.dateEnd && event.dateEnd !== event.dateStart ? ` to ${event.dateEnd}` : ''})` : '';
  fillCounts(sold, `Filled from ${name}${dates}, as sold`, `${name}${dates} sold no art prints. Print counts are cleared.`);
}

/** "Detect sizes": the paper of every item whose name says A0-A6. */
async function detectSizes(): Promise<void> {
  let changed = 0;
  let same = 0;
  const unsized: string[] = [];
  await writeLinks((mine) => {
    for (const r of rows.value) {
      const size = sizeOf(r);
      if (!size) {
        unsized.push(r.variant ? `${r.title} ${r.variant}` : r.title);
        continue;
      }
      const cur = mine[r.key];
      const params = cur?.params ?? defaultParams();
      if (paperName(params.paper) === size) {
        same++;
        continue;
      }
      // Driver settings for the old paper are set to the new one when the item prints.
      mine[r.key] = { ...cur, file: cur?.file ?? '', params: { ...params, paper: paperParam(size) } };
      changed++;
    }
  });
  notice.value =
    `Paper set from the name for ${changed} ${changed === 1 ? 'item' : 'items'}` +
    (same ? `, ${same} already matched` : '') +
    '.' +
    (unsized.length ? ` No size in the name: ${unsized.slice(0, 5).join(', ')}${unsized.length > 5 ? ` and ${unsized.length - 5} more` : ''}.` : '');
}
/**
 * Links `file` to the row and turns its settings to the image's orientation
 * (read by PhotoCraft). Returns what to tell the user about the orientation.
 */
async function linkFile(row: CatalogRow, file: string): Promise<string> {
  const name = file.split(/[\\/]/).pop();
  let params = links.value[row.key]?.params ?? defaultParams();
  let note = '';
  busy.value = `Reading ${name}`;
  try {
    const { width, height } = await api.photocraft.size(file);
    const o = orientFor(params, width, height);
    params = o.params;
    if (o.turned) {
      note = ` It is ${o.orientation} (${width} × ${height} px), so the print is now ${o.orientation}.`;
      if (params.printerSettings) note += ' Its driver settings were kept; PhotoCraft turns them to match when it prints.';
    }
  } catch (err) {
    note = ` Could not read its size, so the orientation was left as it was (${err instanceof Error ? err.message : String(err)}).`;
  } finally {
    busy.value = '';
  }
  await saveLink(row.key, { ...links.value[row.key], file, params });
  return note;
}
async function pickFile(row: CatalogRow): Promise<void> {
  const file = await api.pickFile();
  if (!file) return;
  const note = await linkFile(row, file);
  notice.value = note ? `Linked ${file.split(/[\\/]/).pop()}.${note}` : '';
}

// ── Drag a file from Explorer onto a row to link it ──
/** The row a file is being dragged over. */
const dropRow = ref<string | null>(null);
const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files');

// ── Print order: an item dragged by its grip to another place in the table ──
/** The row being moved, and where it would land: before or after the row under the pointer. */
const moving = ref<string | null>(null);
const landing = ref<{ key: string; after: boolean } | null>(null);
async function saveOrder(keys: string[]): Promise<void> {
  if (!session.value) return;
  const all = plain(settings.value?.order ?? {});
  all[session.value.accountId] = keys;
  settings.value = await api.settings.set({ order: all });
}
/** Moves `row` to before `target` (after it when `after`), in the whole order, not just what is shown. */
async function moveRow(row: CatalogRow, target: CatalogRow, after: boolean): Promise<void> {
  if (row.key === target.key) return;
  const keys = ordered.value.map((r) => r.key);
  const next = after ? keys[keys.indexOf(target.key) + 1] ?? null : target.key;
  await saveOrder(moveKey(keys, row.key, next === row.key ? (keys[keys.indexOf(row.key) + 1] ?? null) : next));
}
function startMove(row: CatalogRow, e: DragEvent): void {
  moving.value = row.key;
  e.dataTransfer?.setData('application/x-print-desk-row', row.key);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  // The whole row as the drag image, not just the grip.
  const tr = (e.target as HTMLElement).closest('tr');
  if (tr && e.dataTransfer) e.dataTransfer.setDragImage(tr, 24, tr.offsetHeight / 2);
}
function endMove(): void {
  moving.value = null;
  landing.value = null;
}
/** Arrow keys on the grip move the item one place up or down among the rows shown. */
async function moveByKey(row: CatalogRow, e: KeyboardEvent): Promise<void> {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const list = shown.value;
  const i = list.findIndex((r) => r.key === row.key);
  const target = list[e.key === 'ArrowUp' ? i - 1 : i + 1];
  if (!target) return;
  await moveRow(row, target, e.key === 'ArrowDown');
  await nextTick();
  document.querySelector<HTMLElement>(`[data-grip="${CSS.escape(row.key)}"]`)?.focus();
}

function dragOver(row: CatalogRow, e: DragEvent): void {
  if (moving.value) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    landing.value = { key: row.key, after: e.clientY > r.top + r.height / 2 };
    return;
  }
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'link';
  dropRow.value = row.key;
}
function dragLeave(row: CatalogRow, e: DragEvent): void {
  // Moving onto a cell or button inside the row also fires dragleave on the row.
  if (dropRow.value === row.key && !(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) dropRow.value = null;
}
async function drop(row: CatalogRow, e: DragEvent): Promise<void> {
  dropRow.value = null;
  if (moving.value) {
    e.preventDefault();
    const from = ordered.value.find((r) => r.key === moving.value);
    const after = landing.value?.after ?? false;
    endMove();
    if (from) await moveRow(from, row, after);
    return;
  }
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  e.preventDefault();
  error.value = '';
  const file = files[0]!;
  const path = api.pathOf(file);
  if (!path) {
    error.value = `Could not tell where ${file.name} is on this computer. Drop it from File Explorer, or click "Link a file".`;
    return;
  }
  if (!isPrintFile(path)) {
    error.value = `${file.name} is not an image PhotoCraft prints: use a PSD, PNG, JPG, TIFF or WebP file.`;
    return;
  }
  const note = await linkFile(row, path);
  notice.value = `Linked ${file.name} to ${row.variant ? `${row.title} ${row.variant}` : row.title}.${note}${files.length > 1 ? ` Only the first of the ${files.length} files was used.` : ''}`;
}
function defaultParams(): Record<string, unknown> {
  const def = printers.value.find((p) => p.default)?.name;
  return { ...(def ? { printer: def } : {}), paper: 'a4', orientation: 'portrait', scaleToFit: true, colorHandling: 'printerManages' };
}
async function pickExe(): Promise<void> {
  const exe = await api.pickExe();
  if (!exe) return;
  settings.value = await api.settings.set({ photocraft: exe });
  await refreshPrinters();
}
async function setTheme(theme: Theme): Promise<void> {
  settings.value = await api.settings.set({ theme });
}
async function toggleAddToStock(on: boolean): Promise<void> {
  settings.value = await api.settings.set({ addToStock: on });
}

/** A notice goes after a while (not while the pointer rests on it); an error stays until dismissed. */
const NOTICE_MS = 12_000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function holdNotice(): void {
  clearTimeout(noticeTimer);
}
function fadeNotice(): void {
  clearTimeout(noticeTimer);
  if (notice.value) noticeTimer = setTimeout(() => (notice.value = ''), NOTICE_MS);
}
watch(notice, fadeNotice);

/** Per item of the current run: copies already added to the Zollify stock. */
const counted: Record<string, number> = {};
let stockQueue: Promise<void> = Promise.resolve();
/**
 * Adds copies to the Zollify stock as they come out, one item's new copies at a time, so a run
 * cancelled halfway counts only what printed. In order, so two updates never race.
 */
function countPrinted(p: CopyProgress): Promise<void> {
  stockQueue = stockQueue.then(() => usePaper(p)).then(async () => {
    if (!settings.value?.addToStock) return;
    const delta = p.printed - (counted[p.key] ?? 0);
    const row = rows.value.find((r) => r.key === p.key);
    if (delta <= 0 || !row) return;
    try {
      // Onto Zollify's count as it is now, so a stock count made elsewhere meanwhile is kept.
      const [done] = await api.zollify.addOnHand([{ productId: row.productId, variantId: row.variantId, add: delta }]);
      const shown = rows.value.find((r) => r.key === p.key);
      if (shown && done) shown.onHand = done.onHand;
      counted[p.key] = (counted[p.key] ?? 0) + delta;
    } catch (err) {
      // Not counted, so the next progress report for this item tries again.
      error.value = `Could not add printed copies to the Zollify stock: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  return stockQueue;
}

/** Per item of the current run: its paper size, and copies whose paper is already logged. */
const runPaper: Record<string, string | null> = {};
const paperCounted: Record<string, number> = {};
const newRunId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** Names this run's paper uses, so a run's copies are never taken for another's. */
let runId = newRunId();
/**
 * Takes the paper of newly printed copies off the material set for their size, as they come out.
 * The use is named by run, item and copies, so a report sent twice is logged once.
 */
async function usePaper(p: CopyProgress): Promise<void> {
  const row = rows.value.find((r) => r.key === p.key);
  // The paper the run was sent with; an item not in this run's list takes its settings now.
  const size = p.key in runPaper ? runPaper[p.key] : row ? paperName(paramsFor(row).paper) : null;
  const material = size ? settings.value?.paperMaterials?.[size] : undefined;
  const from = paperCounted[p.key] ?? 0;
  const delta = p.printed - from;
  if (!material || !paperVia.value || delta <= 0) return;
  try {
    const res = await api.materials.use({
      material,
      qty: delta,
      note: `${row ? (row.variant ? `${row.title} ${row.variant}` : row.title) : p.key} · Print Desk`,
      job: `${runId}|${p.key}|${from}|${p.printed}`,
    });
    paperCounted[p.key] = p.printed;
    const i = materials.value.findIndex((m) => m.id === res.material.id);
    if (i >= 0) materials.value[i] = res.material;
  } catch (err) {
    // Not logged, so the next progress report for this item tries again.
    error.value = `Could not take the paper off the materials: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function printAll(): Promise<void> {
  const jobs = queued.value.map((r) => ({ key: r.key, file: links.value[r.key]!.file, params: paramsFor(r), copies: qty[r.key]! }));
  // A new run starts a fresh count; rows from a finished run drop out of it.
  for (const k of Object.keys(progress)) if (progress[k]!.done) delete progress[k];
  for (const j of jobs) {
    progress[j.key] = { key: j.key, copies: j.copies, printed: 0, left: j.copies, status: 'Waiting', done: false };
    counted[j.key] = 0;
    paperCounted[j.key] = 0;
    runPaper[j.key] = paperName(j.params.paper);
  }
  runId = newRunId();
  await guard(`Sending ${totalCopies.value} copies`, async () => {
    // Stock is added as copies come out (countPrinted), not here: a run can still be cancelled.
    const done = await api.photocraft.print(plain(jobs));
    for (const r of done) if (r.ok) qty[r.key] = 0;
  });
}
</script>

<template>
  <label class="theme">
    <span class="muted">Theme</span>
    <select :value="settings?.theme ?? 'system'" @change="setTheme(($event.target as HTMLSelectElement).value as Theme)">
      <option value="system">Device</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
  <main v-if="!session" class="login">
    <h1>Zollify Print Desk</h1>
    <section v-if="qr.mode" class="qr-panel" aria-live="polite">
      <template v-if="qr.state === 'waiting'">
        <p class="muted">On a phone or tablet that is already signed in, open <strong>Settings → Account &amp; security → Sign in another device</strong> and scan this code. A phone's camera app works too.</p>
        <QrCode v-if="qr.value" :value="qr.value" :size="220" label="Sign-in QR code" class="qr" />
        <span v-else class="qr qr-wait" aria-hidden="true"></span>
        <p class="muted">{{ busy || 'The code changes every few seconds. Waiting for approval…' }}</p>
      </template>
      <template v-else>
        <p class="error" role="alert">{{ qr.state === 'denied' ? 'The other device declined this sign-in.' : 'This code has expired.' }}</p>
        <button type="button" class="primary" @click="startQr">Show a new code</button>
      </template>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="button" class="quiet" @click="closeQr">Sign in with a password instead</button>
    </section>
    <form v-else @submit.prevent="signIn">
      <p class="muted">Sign in with your Zollify account. Files and print settings stay on this computer.</p>
      <label><span>Zollify server</span><input v-model="login.server" type="url" required placeholder="https://zollify.example.com" /></label>
      <label><span>Email</span><input v-model="login.email" type="email" required autocomplete="username" /></label>
      <label><span>Password</span><input v-model="login.password" type="password" required autocomplete="current-password" /></label>
      <label v-if="login.needs2fa"><span>Authenticator code</span><input v-model="login.code" inputmode="numeric" autocomplete="one-time-code" /></label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="primary" :disabled="!!busy">{{ busy || 'Sign in' }}</button>
      <button type="button" class="quiet" :disabled="!!busy" @click="startQr">Sign in from another device with a QR code</button>
    </form>
  </main>

  <main v-else class="desk">
    <header>
      <div>
        <strong>{{ session.email }}</strong>
        <button type="button" class="quiet" @click="signOut">Sign out</button>
        <button type="button" class="quiet" :disabled="!!busy" @click="refreshCatalog">Reload catalogue</button>
        <span v-if="syncedAt" class="muted synced" :title="`Stock is read from Zollify every ${RESYNC_MS / 1000} s and when this window comes to the front`">Stock synced {{ syncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
      </div>
      <div class="exe">
        <span class="muted">photocraft-cli:</span>
        <code :title="settings?.photocraft">{{ settings?.photocraft || 'not found' }}</code>
        <button type="button" class="quiet" @click="pickExe">Browse</button>
      </div>
    </header>

    <!-- Toasts float over the page in a corner, so a message never moves the toolbar or the table. -->
    <div class="toasts">
      <p v-if="error" class="toast error" role="alert">{{ error }} <button type="button" class="quiet" aria-label="Dismiss" @click="error = ''">×</button></p>
      <p v-if="notice" class="toast notice" role="status" @mouseenter="holdNotice" @mouseleave="fadeNotice">{{ notice }} <button type="button" class="quiet" aria-label="Dismiss" @click="notice = ''">×</button></p>
    </div>

    <nav class="views" aria-label="View">
      <button type="button" class="chip" :aria-pressed="view === 'prints'" @click="view = 'prints'">Prints</button>
      <button type="button" class="chip" :aria-pressed="view === 'cards'" @click="view = 'cards'">Price cards</button>
    </nav>

    <template v-if="view === 'prints'">
    <div class="toolbar">
      <input v-model="filter" type="search" placeholder="Filter products" />
      <div v-if="tableSizes.length > 1" class="size-filter" role="group" aria-label="Paper size">
        <button type="button" class="chip" :aria-pressed="!onlySize" @click="onlySize = ''">All</button>
        <button v-for="size in tableSizes" :key="size" type="button" class="chip" :aria-pressed="onlySize === size" :title="`Show and print only ${sizeLabel(size)}`" @click="onlySize = onlySize === size ? '' : size">
          {{ size === 'custom' ? 'Custom' : sizeLabel(size) }}
        </button>
      </div>
      <span class="spacer"></span>
      <Menu label="Fill" title="Set the print counts" :disabled="!!busy || !rows.length">
        <button type="button" role="menuitem" @click="fillFromLastEvent">Fill from last event<small>The copies the last closed event sold</small></button>
        <button type="button" role="menuitem" @click="fillToTarget">Fill to target<small>What each item needs to reach its target stock</small></button>
        <hr />
        <button type="button" role="menuitem" @click="showSizeTargets = !showSizeTargets">{{ showSizeTargets ? 'Close the targets' : 'Targets…' }}<small>Main target {{ settings?.target ?? 0 }}, and per paper size</small></button>
      </Menu>
      <Menu label="Setup" title="Print settings, paper and stock" align="right">
        <button type="button" role="menuitem" @click="open = open === GLOBAL ? null : GLOBAL">Global print settings{{ globalParams ? ' (on)' : '' }}<small>One set for every item, each on its own paper</small></button>
        <button type="button" role="menuitem" @click="open = open === PAPER ? null : PAPER">Paper and ink stock<small>{{ paperVia ? 'Paper is taken off Zollify materials' : 'Take printed paper off Zollify materials' }}</small></button>
        <button type="button" role="menuitem" :disabled="!!busy || !rows.length" @click="detectSizes">Detect sizes<small>Each item's paper from the A size in its name</small></button>
        <hr />
        <label role="menuitemcheckbox" :aria-checked="!!settings?.addToStock"><input type="checkbox" :checked="settings?.addToStock" @change="toggleAddToStock(($event.target as HTMLInputElement).checked)" /> Add printed copies to Zollify stock</label>
        <label role="menuitemcheckbox" :aria-checked="!!settings?.allowRemote" title="Zollify's Print Desk module can always set the print counts; with this on, it can also start printing"><input type="checkbox" :checked="settings?.allowRemote" @change="toggleAllowRemote(($event.target as HTMLInputElement).checked)" /> Print when asked from Zollify</label>
      </Menu>
      <button v-if="hiddenKeys.size" type="button" class="quiet" :aria-pressed="showHidden" @click="showHidden = !showHidden">{{ showHidden ? `Leave out hidden (${hiddenKeys.size})` : `Show hidden (${hiddenKeys.size})` }}</button>
      <span class="muted" title="Timed from the sheets this desk printed, per item, else per paper size; waits to load a sheet and press OK are not counted">{{ queued.length }} items, {{ totalCopies }} copies{{ timeAhead ? `, ${timeAhead}` : '' }}</span>
      <button type="button" class="primary" :disabled="!!busy || !queued.length" @click="printAll">{{ busy || (onlySize ? `Print ${sizeLabel(onlySize)} only` : 'Print all') }}</button>
    </div>
    <div v-if="Object.keys(needs).length" class="plan" role="group" aria-label="Paper needed">
      <span class="muted">Paper needed:</span>
      <button type="button" class="chip" :aria-pressed="!onlySize" @click="onlySize = ''">All sizes</button>
      <button
        v-for="(n, size) in needs"
        :key="size"
        type="button"
        class="chip"
        :class="{ short: shortSizes.includes(String(size)) }"
        :aria-pressed="onlySize === size"
        :title="`Print only ${sizeLabel(String(size))}`"
        @click="onlySize = onlySize === size ? '' : String(size)"
      >
        {{ sizeLabel(String(size)) }}: {{ n }} {{ n === 1 ? 'sheet' : 'sheets' }}<template v-if="paperOnHand(String(size)) !== null"> · {{ paperOnHand(String(size)) }} on hand</template>
      </button>
      <Menu v-if="shortSizes.length" label="Fit to paper stock" :disabled="!!busy">
        <button type="button" role="menuitem" @click="smartFitToPaperStock">Smart fit<small>The paper to the copies most likely to sell at the next event, dearer prints first</small></button>
        <button type="button" role="menuitem" @click="fitToPaperStock">Proportional fit<small>Each item keeps its share of what it wanted</small></button>
      </Menu>
      <span v-if="!paperVia" class="muted">Set up Paper stock to see what is on hand.</span>
    </div>
    <div v-if="showSizeTargets" class="size-targets" role="group" aria-label="Target stock">
      <label class="inline target" title="Target stock for items without their own or their size's, kept between sessions">
        Main target
        <input type="number" min="0" max="999" :value="settings?.target ?? 0" @change="setTarget(($event.target as HTMLInputElement).valueAsNumber)" />
      </label>
      <span v-if="sizes.length" class="muted">Per size (empty: the main target)</span>
      <label v-for="s in sizes" :key="s" class="inline target">
        {{ s.toUpperCase() }}
        <input type="number" min="0" max="999" :value="settings?.sizeTargets?.[s] ?? ''" :placeholder="String(settings?.target ?? 0)" @change="setSizeTarget(s, ($event.target as HTMLInputElement).valueAsNumber)" />
      </label>
    </div>
    <section v-if="open === PAPER" class="global paper" aria-label="Paper stock">
      <template v-if="!paperVia">
        <p class="muted">Each printed copy can take its sheet off a material in Zollify (Sourcing → Materials).</p>
        <p v-if="paperWhy" class="muted">Your sign-in can't: {{ paperWhy }}</p>
        <p class="muted">An admin can make a printer key under <strong>Sourcing → Materials → Printing app</strong> to paste here instead.</p>
        <form class="key" @submit.prevent="saveKey">
          <input v-model="keyInput" type="password" autocomplete="off" placeholder="zpk_…" aria-label="Printer key" />
          <button type="submit" class="primary" :disabled="!keyInput.trim()">Save key</button>
        </form>
      </template>
      <template v-else>
        <p class="muted">
          Each copy that comes out of the printer takes one sheet off the material set for its paper size. A cancelled print takes only what printed.
          {{ paperVia === 'session' ? 'Through your Zollify sign-in.' : `Through the printer key${paperWhy ? ` (your sign-in can't: ${paperWhy})` : ''}.` }}
        </p>
        <div class="paper-sizes">
          <label v-for="size in paperSizes" :key="size">
            <span>{{ paperLabel(size) }}</span>
            <select :value="settings?.paperMaterials?.[size] ?? ''" @change="setPaperMaterial(size, ($event.target as HTMLSelectElement).value)">
              <option value="">Don't take off</option>
              <option v-for="m in materials" :key="m.id" :value="m.id">{{ m.name }} ({{ m.onHand }} {{ m.unit }}{{ m.onHand === 1 ? '' : 's' }})</option>
              <option v-if="settings?.paperMaterials?.[size] && !materialOf(settings.paperMaterials[size])" :value="settings.paperMaterials[size]">(a material Zollify no longer lists)</option>
            </select>
          </label>
          <p v-if="!paperSizes.length" class="muted">No item has a named paper size yet.</p>
        </div>
        <h3 class="supplies-head">Ink and maintenance cartridge</h3>
        <p v-if="!supplies" class="muted">{{ deskPrinter ? `${deskPrinter} does not say its ink levels (Print Desk reads them from a Canon printer on the network).` : 'No printer chosen.' }}</p>
        <template v-else>
          <p class="muted">Link each to its material: a warning then says whether one is in stock, and a tank swapped for a new one takes one off.</p>
          <div class="paper-sizes">
            <label v-for="s in supplies" :key="s.id" :class="['supply-row', `is-${s.state}`]">
              <span>{{ supplyLabel(s) }} <small>{{ supplyLevel(s) }}{{ s.state === 'low' || s.state === 'out' ? ` · ${supplyWarning(s)}` : '' }}</small></span>
              <select :value="settings?.supplyMaterials?.[s.id] ?? ''" @change="setSupplyMaterial(s, ($event.target as HTMLSelectElement).value)">
                <option value="">No material</option>
                <option v-for="m in materials" :key="m.id" :value="m.id">{{ m.name }} ({{ m.onHand }} {{ m.unit }}{{ m.onHand === 1 ? '' : 's' }})</option>
                <option v-if="settings?.supplyMaterials?.[s.id] && !materialOf(settings.supplyMaterials[s.id])" :value="settings.supplyMaterials[s.id]">(a material Zollify no longer lists)</option>
              </select>
            </label>
          </div>
        </template>
        <button v-if="settings?.hasPrinterKey" type="button" class="quiet" @click="removeKey">{{ paperVia === 'session' ? 'Remove the printer key (not needed with your sign-in)' : 'Remove the printer key' }}</button>
      </template>
      <p v-if="paperNote" class="error" role="alert">{{ paperNote }}</p>
    </section>
    <section v-if="open === GLOBAL" class="global" aria-label="Global print settings">
      <p class="muted">
        Every item without its own settings prints with these. Each still gets its own paper (from the A size in its name, else its own) and orientation (from its image),
        and the driver settings are set to that paper when it prints, keeping media, quality and borderless.
      </p>
      <PrintSettings :params="globalParams ?? defaultParams()" :printers="printers" :size="null" :units="units" no-apply @update="saveGlobal" @units="setUnits" />
      <button v-if="globalParams" type="button" class="quiet" @click="saveGlobal(null)">Stop using global settings</button>
    </section>
    <p v-for="s in lowSupplies" :key="s.id" :class="['supply-warn', { none: supplyMaterial(s)?.onHand === 0 }]" role="status">
      <Icon name="alert-triangle" :size="14" /> {{ supplyLabel(s) }} {{ supplyWarning(s) }} ({{ supplyLevel(s) }})<template v-if="supplyMaterial(s)"> - {{ supplyMaterial(s)!.onHand > 0 ? `${supplyMaterial(s)!.onHand} in stock` : `none in stock: order ${supplyMaterial(s)!.name}` }}</template>
    </p>
    <p v-if="copiesLeft !== null" class="queue" role="status">Printing: <strong>{{ copiesLeft }}</strong> {{ copiesLeft === 1 ? 'copy' : 'copies' }} left, as the print queue reports it</p>

    <table>
      <thead>
        <tr><th class="grip-cell"><span class="sr-only">Print order</span></th><th>Product</th><th v-if="hasSku">SKU</th><th>On hand</th><th title="Stock to print up to. Empty: the size's or the main target, shown in grey">Target</th><th>File</th><th>Printer / paper</th><th><span class="sr-only">Actions</span></th><th>Print</th><th>Result</th></tr>
      </thead>
      <tbody>
        <template v-for="(row, i) in shown" :key="row.key">
          <tr
            :class="{
              drop: dropRow === row.key,
              hidden: isHidden(row),
              alt: i % 2 === 1,
              moving: moving === row.key,
              'land-before': landing?.key === row.key && !landing.after && moving !== row.key,
              'land-after': landing?.key === row.key && landing.after && moving !== row.key,
            }"
            @dragenter="dragOver(row, $event)"
            @dragover="dragOver(row, $event)"
            @dragleave="dragLeave(row, $event)"
            @drop="drop(row, $event)"
          >
            <td class="grip-cell">
              <button
                type="button"
                class="grip"
                draggable="true"
                :data-grip="row.key"
                :aria-label="`Move ${row.variant ? `${row.title} ${row.variant}` : row.title} in the print order (drag, or arrow keys)`"
                title="Drag to set the print order (or arrow keys): items print top to bottom"
                @dragstart="startMove(row, $event)"
                @dragend="endMove"
                @keydown="moveByKey(row, $event)"
              >
                <Icon name="grip" />
              </button>
            </td>
            <td><div>{{ row.title }}</div><div v-if="row.variant" class="muted">{{ row.variant }}</div></td>
            <td v-if="hasSku"><code>{{ row.sku }}</code></td>
            <td>{{ row.onHand }}</td>
            <td>
              <input
                class="target-cell"
                type="number"
                min="0"
                max="999"
                :aria-label="`Target stock for ${row.variant ? `${row.title} ${row.variant}` : row.title}`"
                :value="itemTargets[row.key] ?? ''"
                :placeholder="String(fallbackTargetOf(row))"
                @change="setItemTarget(row, ($event.target as HTMLInputElement).valueAsNumber)"
              />
            </td>
            <td>
              <button
                v-if="links[row.key]?.file || dropRow === row.key"
                type="button"
                class="quiet"
                :title="`${links[row.key]?.file ? `${links[row.key]!.file}\n` : ''}Click to choose a file, or drop one on this row`"
                @click="pickFile(row)"
              >
                {{ dropRow === row.key ? 'Drop to link' : links[row.key]!.file.split(/[\\/]/).pop() }}
              </button>
              <!-- An item with no file can't print: its file cell says so, in the warning colour. -->
              <button v-else type="button" class="no-file" title="No file linked, so this item can't print. Click to choose one, or drop one on this row" @click="pickFile(row)">
                <Icon name="alert-triangle" />
                No file, link one
              </button>
            </td>
            <td>
              <span v-if="links[row.key] || usesGlobal(row)">{{ paramsFor(row).printer || 'default printer' }}, {{ paperLabel(paramsFor(row).paper) }} {{ paramsFor(row).orientation || '' }}{{ usesGlobal(row) ? (Object.keys(links[row.key]?.overrides ?? {}).length ? ' · global, changed' : ' · global') : '' }}</span>
              <div v-if="sheetTime(row)" class="muted" :title="sheetTime(row)!.own ? `Mean of the last ${printTimes[row.key]!.n} sheets printed` : 'Not timed yet: the mean of its paper size'">{{ duration(sheetTime(row)!.ms) }} a sheet{{ sheetTime(row)!.own ? '' : ` (${sizeLabel(printSize(row))} average)` }}</div>
            </td>
            <td class="actions-cell">
              <div class="row-actions">
                <button
                  type="button"
                  class="icon-button"
                  :aria-pressed="open === row.key"
                  :aria-label="`Print settings for ${row.variant ? `${row.title} ${row.variant}` : row.title}`"
                  :title="open === row.key ? 'Close the print settings' : 'Print settings'"
                  @click="open = open === row.key ? null : row.key"
                >
                  <Icon name="settings" />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  :aria-pressed="isHidden(row)"
                  :aria-label="`${isHidden(row) ? 'Unhide' : 'Hide'} ${row.variant ? `${row.title} ${row.variant}` : row.title}`"
                  :title="isHidden(row) ? 'Hidden: printed elsewhere. Click to print it here again' : 'Hide: printed elsewhere (outsourced), so out of the fills and the print run'"
                  @click="setHidden(row, !isHidden(row))"
                >
                  <Icon :name="isHidden(row) ? 'eye-off' : 'eye'" />
                </button>
              </div>
            </td>
            <td>
              <input
                v-model.number="qty[row.key]"
                type="number"
                min="0"
                max="999"
                :disabled="!links[row.key]?.file || isHidden(row)"
                :title="!links[row.key]?.file ? 'No file linked, so this item does not print. Link a file first.' : isHidden(row) ? 'Hidden: printed elsewhere' : ''"
              />
            </td>
            <td>
              <template v-if="progress[row.key]">
                <span v-if="progress[row.key]!.failed" class="error">{{ progress[row.key]!.status }}</span>
                <span v-else-if="progress[row.key]!.cancelled" class="warn">{{ progress[row.key]!.status }}</span>
                <span v-else-if="progress[row.key]!.done" class="ok" :title="progress[row.key]!.status">{{ progress[row.key]!.printed }} printed</span>
                <template v-else>
                  <progress :max="progress[row.key]!.copies" :value="progress[row.key]!.copies - progress[row.key]!.left"></progress>
                  <div>{{ progress[row.key]!.copies - progress[row.key]!.left }} / {{ progress[row.key]!.copies }} · {{ progress[row.key]!.status }}</div>
                </template>
              </template>
            </td>
          </tr>
          <tr v-if="open === row.key" class="settings" :class="{ alt: i % 2 === 1 }">
            <td :colspan="hasSku ? 10 : 9">
              <label class="copy-from">
                <span class="muted">Copy print settings from</span>
                <select :value="''" @change="copySettings(row, ($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
                  <option value="">another item…</option>
                  <option v-for="r in copySources(row)" :key="r.key" :value="r.key">{{ r.variant ? `${r.title} ${r.variant}` : r.title }} · {{ settingsKind(r) }}</option>
                </select>
              </label>
              <ItemOverrides
                v-if="usesGlobal(row)"
                :base="effectiveParams(links[row.key], globalParams, sizeOf(row), false) ?? {}"
                :overrides="links[row.key]?.overrides ?? {}"
                :image="imageOf(row)"
                :units="units"
                :size-from-name="sizeOf(row)"
                :from-image="!!links[row.key]?.params.orientation"
                @update="setOverrides(row, $event)"
                @units="setUnits"
                @own="setOwn(row, true)"
              />
              <template v-else>
                <PrintSettings
                  :params="paramsOf(row.key)"
                  :printers="printers"
                  :size="sizeOf(row)"
                  :no-apply="!!globalParams"
                  :image="imageOf(row)"
                  :units="units"
                  @units="setUnits"
                  @update="saveLink(row.key, { ...links[row.key], file: links[row.key]?.file ?? '', params: $event })"
                  @apply="(params, scope) => applySettings(row, params, scope)"
                />
                <button v-if="globalParams" type="button" class="quiet" @click="setOwn(row, false)">Use the global settings</button>
              </template>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <p v-if="!rows.length && !busy" class="muted">No art prints yet. Give products the type "Art Print" in Zollify's catalogue, then reload.</p>
    </template>
    <PriceCards v-else-if="settings" :settings="settings" :session="session" :printers="printers" @settings="settings = $event" @error="error = $event" @notice="notice = $event" />
  </main>
</template>

<style scoped>
.theme { position: fixed; right: 1rem; bottom: 1rem; flex-direction: row; align-items: center; gap: .4rem; z-index: 1; }
.login { max-width: 24rem; margin: 10vh auto; padding: 1.5rem; background: var(--zfy-surface); border-radius: 12px; }
.login form { display: flex; flex-direction: column; gap: .8rem; }
.login h1 { margin: 0 0 .25rem; font-size: 1.3rem; }
.login .muted { margin: 0; }
.qr-panel { display: flex; flex-direction: column; align-items: center; gap: .8rem; text-align: center; }
.qr-wait { display: block; width: 220px; height: 220px; border-radius: 12px; background: #fff; opacity: .5; }
.desk { padding: 1rem; display: flex; flex-direction: column; gap: .8rem; }
header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.synced { font-size: .8rem; }
.exe { display: flex; align-items: center; gap: .4rem; }
.exe code { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.views { display: flex; gap: .4rem; }
.toolbar input[type='search'] { flex: 0 1 18rem; min-width: 10rem; }
.target input, .target-cell { width: 4.5rem; }
.size-targets { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface); border-radius: 10px; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--zfy-line); vertical-align: middle; }
th { font-size: .8rem; color: var(--zfy-muted); font-weight: 600; }
/* Every other item a shade off the surface, so a row reads across; its settings panel shares it. */
tr.alt td { background: color-mix(in srgb, var(--zfy-ink) 4%, var(--zfy-surface)); }
tr.settings td { background: var(--zfy-bg); }
tr.settings.alt td { background: color-mix(in srgb, var(--zfy-ink) 4%, var(--zfy-bg)); }
.actions-cell { width: 1%; white-space: nowrap; }
.no-file { display: inline-flex; align-items: center; gap: .4rem; padding: .3rem .6rem; border: 1px dashed var(--zfy-warning); border-radius: 8px; background: color-mix(in srgb, var(--zfy-warning) 10%, transparent); color: var(--zfy-warning); }
.no-file:hover { background: color-mix(in srgb, var(--zfy-warning) 18%, transparent); }
.row-actions { display: flex; gap: .35rem; }
.icon-button { display: inline-grid; place-items: center; width: 2rem; height: 2rem; padding: 0; border-radius: 8px; color: var(--zfy-muted); }
.icon-button:hover { color: var(--zfy-ink); border-color: color-mix(in srgb, var(--zfy-ink) 30%, var(--zfy-line)); }
.icon-button[aria-pressed='true'] { color: var(--zfy-primary); border-color: var(--zfy-primary); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.grip-cell { width: 1%; padding-left: .3rem; padding-right: 0; }
.grip { display: inline-grid; place-items: center; width: 1.6rem; height: 2rem; padding: 0; border: 0; background: transparent; color: var(--zfy-muted); cursor: grab; }
.grip:hover, .grip:focus-visible { color: var(--zfy-ink); }
.grip:active { cursor: grabbing; }
tr.moving td { opacity: .45; }
/* Where a dragged row lands: a line above or below the row under the pointer. */
tr.land-before td { box-shadow: inset 0 3px 0 var(--zfy-primary); }
tr.land-after td { box-shadow: inset 0 -3px 0 var(--zfy-primary); }
.copy-from { flex-direction: row; align-items: center; gap: .5rem; margin-bottom: .6rem; }
tr.drop td { background: color-mix(in srgb, var(--zfy-primary) 18%, var(--zfy-surface)); }
tr.drop td:first-child { box-shadow: inset 3px 0 0 var(--zfy-primary); }
.queue { margin: 0; }
.supply-warn { margin: 0; display: flex; align-items: center; gap: .35rem; color: var(--zfy-warning); font-size: .9rem; }
.supply-warn.none { color: var(--zfy-danger); font-weight: 600; }
.supplies-head { margin: .8rem 0 .2rem; font-size: .95rem; }
.supply-row.is-low span, .supply-row.is-out span { color: var(--zfy-warning); }
.toasts { position: fixed; left: 1rem; bottom: 1rem; z-index: 20; display: flex; flex-direction: column; gap: .5rem; max-width: min(36rem, calc(100vw - 12rem)); pointer-events: none; }
.toast { pointer-events: auto; margin: 0; padding: .6rem .75rem; border-radius: 10px; background: var(--zfy-surface); border: 1px solid var(--zfy-line); box-shadow: 0 8px 24px rgb(0 0 0 / 18%); }
.toast.error { border-color: var(--zfy-danger); }
.toast button { padding: 0 .4rem; }
.global { padding: .6rem .8rem; border-radius: 10px; background: var(--zfy-surface); }
.global > p { margin: 0 0 .4rem; }
.paper .key { display: flex; gap: .5rem; margin: .4rem 0; }
.paper .key input { flex: 1; max-width: 24rem; }
.paper-sizes { display: flex; flex-wrap: wrap; gap: .6rem .9rem; margin: .4rem 0; }
.size-filter { display: flex; gap: .3rem; }
.toolbar .spacer { flex: 1; }
.plan { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.chip { padding: .25rem .65rem; border-radius: 999px; }
.chip[aria-pressed='true'] { border-color: var(--zfy-primary); box-shadow: inset 0 0 0 1px var(--zfy-primary); }
.chip.short { border-color: var(--zfy-danger); color: var(--zfy-danger); }
tr.hidden td:not(.actions-cell) { opacity: .55; }
.uses-global { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
td progress { width: 8rem; accent-color: var(--zfy-primary); }
</style>
