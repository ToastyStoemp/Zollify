<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
// Straight from its file, not the @zollify/ui barrel: the barrel pulls in @zollify/shared and zod.
import QrCode from '@zollify/ui/QrCode.vue';
import type { Material } from '../electron/materials';
import type { CatalogRow, CopyProgress, ImageInfo, PrintLink, Printer, Session, Settings, Theme, Units } from '../electron/shared';
import { effectiveParams, fitToStock, isPrintFile, paperName, paperNeeds, paperParam, orientFor, settingsFor, sizeFromName, targetFor } from '../electron/shared';
import ItemOverrides from './ItemOverrides.vue';
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

const login = reactive({ server: '', email: '', password: '', code: '', needs2fa: false });

const links = computed<Record<string, PrintLink>>(() => (session.value && settings.value ? (settings.value.links[session.value.accountId] ?? {}) : {}));
/** Over the whole catalogue, not the filtered rows, so the column does not come and go while typing a filter. */
const hasSku = computed(() => rows.value.some((r) => r.sku));
/** Items printed elsewhere (outsourced): out of the table, the fills and the print run. */
const hiddenKeys = computed(() => new Set(session.value ? (settings.value?.hidden?.[session.value.accountId] ?? []) : []));
const isHidden = (r: CatalogRow): boolean => hiddenKeys.value.has(r.key);
const showHidden = ref(false);
/** The items printed here. */
const active = computed(() => rows.value.filter((r) => !isHidden(r)));
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = showHidden.value ? rows.value : active.value;
  return q ? list.filter((r) => `${r.title} ${r.variant} ${r.sku}`.toLowerCase().includes(q)) : list;
});
/** The paper an item prints on ("a3"), or "custom". */
const printSize = (r: CatalogRow): string => paperName(paramsFor(r).paper) ?? 'custom';
/** Print only this paper size ('' every size). */
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
  if (session.value) await loadAll();
  api.photocraft.onQueue((p) => {
    progress[p.key] = p;
    void countPrinted(p);
  });
});

async function loadAll(): Promise<void> {
  await Promise.all([refreshCatalog(), refreshPrinters(), loadMaterials()]);
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
    await loadMaterials();
  } catch {
    /* offline for a moment: the next resync tries again */
  }
}
const resyncTimer = setInterval(() => void resync(), RESYNC_MS);
const onFocus = (): void => void resync();
window.addEventListener('focus', onFocus);
onBeforeUnmount(() => {
  clearInterval(resyncTimer);
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
function fitToPaperStock(): void {
  const items = queuedAll.value.map((r) => ({ key: r.key, size: printSize(r), copies: qty[r.key] ?? 0 }));
  const stock = Object.fromEntries(Object.keys(needs.value).flatMap((size) => (paperOnHand(size) === null ? [] : [[size, paperOnHand(size)!]])));
  const before = { ...needs.value };
  const fitted = fitToStock(items, stock);
  for (const [key, n] of Object.entries(fitted)) qty[key] = n;
  const cut = Object.keys(before).filter((size) => (needs.value[size] ?? 0) < before[size]!);
  notice.value = cut.length
    ? `Fitted to the paper on hand: ${cut.map((size) => `${sizeLabel(size)} ${before[size]} → ${needs.value[size] ?? 0} sheets`).join(', ')}. Each item keeps its share of what it wanted.`
    : 'Nothing to fit: every paper size has enough on hand, or no material is set for it under Paper stock.';
}
// A size picked for printing that has nothing left to print goes back to every size.
watch(needs, (n) => {
  if (onlySize.value && !(onlySize.value in n)) onlySize.value = '';
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
async function loadMaterials(): Promise<void> {
  if (!settings.value?.hasPrinterKey) return;
  try {
    materials.value = await api.materials.list();
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
function dragOver(row: CatalogRow, e: DragEvent): void {
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
  if (!material || !settings.value?.hasPrinterKey || delta <= 0) return;
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

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }} <button type="button" class="quiet" aria-label="Dismiss" @click="notice = ''">×</button></p>

    <div class="toolbar">
      <input v-model="filter" type="search" placeholder="Filter products" />
      <button type="button" :disabled="!!busy || !rows.length" title="Set each item's paper from an A0-A6 size in its variant or product name" @click="detectSizes">Detect sizes</button>
      <button type="button" :aria-expanded="open === GLOBAL" title="One set of print settings for every item; each keeps its own paper size and orientation" @click="open = open === GLOBAL ? null : GLOBAL">Global print settings{{ globalParams ? ' (on)' : '' }}</button>
      <button type="button" :aria-expanded="open === PAPER" title="Take the paper of each printed copy off its material in Zollify (Sourcing → Materials)" @click="open = open === PAPER ? null : PAPER">Paper stock</button>
      <button type="button" :disabled="!!busy || !rows.length" title="Set each item's print count to the copies the last closed event sold" @click="fillFromLastEvent">Fill from last event</button>
      <label class="inline target" title="Target stock for items without their own or their size's, kept between sessions">
        Main target
        <input type="number" min="0" max="999" :value="settings?.target ?? 0" @change="setTarget(($event.target as HTMLInputElement).valueAsNumber)" />
      </label>
      <button v-if="sizes.length" type="button" class="quiet" :aria-expanded="showSizeTargets" title="A target per A size; items without a size in their name use the main target" @click="showSizeTargets = !showSizeTargets">Per size</button>
      <button type="button" :disabled="!!busy || !rows.length" title="Set each item's print count to what it takes to reach its target stock" @click="fillToTarget">Fill to target</button>
      <label class="inline"><input type="checkbox" :checked="settings?.addToStock" @change="toggleAddToStock(($event.target as HTMLInputElement).checked)" /> Add printed copies to Zollify stock</label>
      <button v-if="hiddenKeys.size" type="button" class="quiet" :aria-pressed="showHidden" @click="showHidden = !showHidden">{{ showHidden ? `Leave out hidden (${hiddenKeys.size})` : `Show hidden (${hiddenKeys.size})` }}</button>
      <span class="muted">{{ queued.length }} items, {{ totalCopies }} copies</span>
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
      <button v-if="shortSizes.length" type="button" title="Cut the copies of each size short of paper to what is on hand, each item in proportion to what it wanted" @click="fitToPaperStock">Fit to paper stock</button>
      <span v-if="!settings?.hasPrinterKey" class="muted">Set up Paper stock to see what is on hand.</span>
    </div>
    <div v-if="showSizeTargets && sizes.length" class="size-targets" role="group" aria-label="Target stock per size">
      <span class="muted">Target stock per size (empty: {{ settings?.target ?? 0 }}, the main target)</span>
      <label v-for="s in sizes" :key="s" class="inline target">
        {{ s.toUpperCase() }}
        <input type="number" min="0" max="999" :value="settings?.sizeTargets?.[s] ?? ''" :placeholder="String(settings?.target ?? 0)" @change="setSizeTarget(s, ($event.target as HTMLInputElement).valueAsNumber)" />
      </label>
    </div>
    <section v-if="open === PAPER" class="global paper" aria-label="Paper stock">
      <template v-if="!settings?.hasPrinterKey">
        <p class="muted">Each printed copy can take its sheet off a material in Zollify. Make a printer key under <strong>Sourcing → Materials → Printing app</strong> and paste it here.</p>
        <form class="key" @submit.prevent="saveKey">
          <input v-model="keyInput" type="password" autocomplete="off" placeholder="zpk_…" aria-label="Printer key" />
          <button type="submit" class="primary" :disabled="!keyInput.trim()">Save key</button>
        </form>
      </template>
      <template v-else>
        <p class="muted">Each copy that comes out of the printer takes one sheet off the material set for its paper size. A cancelled print takes only what printed.</p>
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
        <button type="button" class="quiet" @click="removeKey">Remove the printer key</button>
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
    <p v-if="copiesLeft !== null" class="queue" role="status">Printing: <strong>{{ copiesLeft }}</strong> {{ copiesLeft === 1 ? 'copy' : 'copies' }} left, as the print queue reports it</p>

    <table>
      <thead>
        <tr><th>Product</th><th v-if="hasSku">SKU</th><th>On hand</th><th title="Stock to print up to. Empty: the size's or the main target, shown in grey">Target</th><th>File</th><th>Printer / paper</th><th>Print</th><th>Result</th></tr>
      </thead>
      <tbody>
        <template v-for="row in shown" :key="row.key">
          <tr :class="{ drop: dropRow === row.key, hidden: isHidden(row) }" @dragenter="dragOver(row, $event)" @dragover="dragOver(row, $event)" @dragleave="dragLeave(row, $event)" @drop="drop(row, $event)">
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
              <button type="button" class="quiet" :title="`${links[row.key]?.file ? `${links[row.key]!.file}\n` : ''}Click to choose a file, or drop one on this row`" @click="pickFile(row)">{{ dropRow === row.key ? 'Drop to link' : links[row.key]?.file ? links[row.key]!.file.split(/[\\/]/).pop() : 'Link a file' }}</button>
            </td>
            <td>
              <span v-if="links[row.key] || usesGlobal(row)">{{ paramsFor(row).printer || 'default printer' }}, {{ paperLabel(paramsFor(row).paper) }} {{ paramsFor(row).orientation || '' }}{{ usesGlobal(row) ? (Object.keys(links[row.key]?.overrides ?? {}).length ? ' · global, changed' : ' · global') : '' }}</span>
              <button type="button" class="quiet" @click="open = open === row.key ? null : row.key">{{ open === row.key ? 'Close' : 'Settings' }}</button>
              <button type="button" class="quiet" :title="isHidden(row) ? 'Print this item here again' : 'Printed elsewhere (outsourced): leave it out of the fills and the print run'" @click="setHidden(row, !isHidden(row))">{{ isHidden(row) ? 'Unhide' : 'Hide' }}</button>
            </td>
            <td><input v-model.number="qty[row.key]" type="number" min="0" max="999" :disabled="!links[row.key]?.file || isHidden(row)" /></td>
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
          <tr v-if="open === row.key" class="settings">
            <td :colspan="hasSku ? 8 : 7">
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
.toolbar input[type='search'] { flex: 1; min-width: 12rem; }
.target input, .target-cell { width: 4.5rem; }
.size-targets { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
table { width: 100%; border-collapse: collapse; background: var(--zfy-surface); border-radius: 10px; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--zfy-line); vertical-align: top; }
th { font-size: .8rem; color: var(--zfy-muted); font-weight: 600; }
tr.settings td { background: var(--zfy-bg); }
tr.drop td { background: color-mix(in srgb, var(--zfy-primary) 18%, var(--zfy-surface)); }
tr.drop td:first-child { box-shadow: inset 3px 0 0 var(--zfy-primary); }
.queue { margin: 0; }
.notice { margin: 0; padding: .5rem .75rem; border-radius: 8px; background: var(--zfy-surface); border: 1px solid var(--zfy-line); }
.notice button { padding: 0 .4rem; }
.global { padding: .6rem .8rem; border-radius: 10px; background: var(--zfy-surface); }
.global > p { margin: 0 0 .4rem; }
.paper .key { display: flex; gap: .5rem; margin: .4rem 0; }
.paper .key input { flex: 1; max-width: 24rem; }
.paper-sizes { display: flex; flex-wrap: wrap; gap: .6rem .9rem; margin: .4rem 0; }
.plan { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.chip { padding: .25rem .65rem; border-radius: 999px; }
.chip[aria-pressed='true'] { border-color: var(--zfy-primary); box-shadow: inset 0 0 0 1px var(--zfy-primary); }
.chip.short { border-color: var(--zfy-danger); color: var(--zfy-danger); }
tr.hidden td { opacity: .55; }
.uses-global { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
td progress { width: 8rem; accent-color: var(--zfy-primary); }
</style>
