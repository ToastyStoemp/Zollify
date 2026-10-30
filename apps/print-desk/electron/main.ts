import { BrowserWindow, app, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packSheets, type CardArt, type PriceFormat } from './cards.js';
import { decodeDevMode, describeDevMode, type DevModeSummary } from './devmode.js';
import { drawCard, drawSheets, findExe, imageSize, lastPrint, pngSize, print, printers, setCardTexts, sheetPdf } from './photocraft.js';
import { PRINT_FILE_EXTENSIONS, type CopyProgress, type PrintJob, type PrintResult, type Settings } from './shared.js';
import { driverOptions, fitDriverPaper, printerCaps } from './printercaps.js';
import { finishedOf, jobOutcome, newJob, progressOf, snapshot, targetPrinter } from './spooler.js';
import { Store } from './store.js';
import { listMaterials, sessionRefusal, useMaterial, type MaterialUse, type PaperAccess } from './materials.js';
import { Zollify, ZollifyError, type LoginInput } from './zollify.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const store = new Store(join(app.getPath('userData'), 'print-desk.json'));
if (!store.data.photocraft) store.data.photocraft = findExe();

/** A secret as stored: safeStorage's ciphertext (base64) when `encrypted`, else as it is. */
function readSecret(value: string | undefined, encrypted: boolean | undefined): string {
  if (!value) return '';
  if (!encrypted) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}
function sealSecret(secret: string): { value: string; encrypted: boolean } {
  const encrypted = !!secret && safeStorage.isEncryptionAvailable();
  return { value: encrypted ? safeStorage.encryptString(secret).toString('base64') : secret, encrypted };
}
const readRefresh = (): string => readSecret(store.data.refreshToken, store.data.refreshEncrypted);
function writeRefresh(token: string): void {
  const { value, encrypted } = sealSecret(token);
  store.data.refreshToken = value;
  store.data.refreshEncrypted = encrypted;
  store.save();
}
const readPrinterKey = (): string => readSecret(store.data.printerKey, store.data.printerKeyEncrypted);

/** IPC errors reach the renderer as a message only, so a 2FA prompt travels as a prefix. */
const fail = (err: unknown): never => {
  if (err instanceof ZollifyError && err.needs2fa) throw new Error(`2FA:${err.message}`);
  throw new Error(err instanceof Error ? err.message : String(err));
};

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    title: 'Zollify Print Desk',
    webPreferences: { preload: join(here, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  void win.loadFile(join(here, '..', 'dist', 'index.html'));
  return win;
}

void app.whenReady().then(() => {
  const zollify = new Zollify(store.data.server, readRefresh(), store.data.deviceId, writeRefresh);
  const owner = (e: Electron.IpcMainInvokeEvent): BrowserWindow => BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]!;

  // The page's prefers-color-scheme follows this, so the CSS needs no theme logic of its own.
  nativeTheme.themeSource = store.data.theme;

  ipcMain.handle('settings:get', (): Settings => store.settings());
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>): Settings => {
    Object.assign(store.data, patch);
    store.save();
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    return store.settings();
  });
  ipcMain.handle('pick:file', async (e) => {
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openFile'], filters: [{ name: 'Images', extensions: [...PRINT_FILE_EXTENSIONS] }] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('pick:exe', async (e) => {
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openFile'], title: 'Where is photocraft-cli?' });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('zollify:resume', () => zollify.resume());
  ipcMain.handle('zollify:login', async (_e, input: LoginInput) => {
    const session = await zollify.login(input).catch(fail);
    store.data.server = input.server;
    store.save();
    return session;
  });
  ipcMain.handle('zollify:linkStart', (_e, server: string) => zollify.linkStart(server).catch(fail));
  ipcMain.handle('zollify:linkPoll', async (_e, id: string, pollSecret: string) => {
    const r = await zollify.linkPoll(id, pollSecret).catch(fail);
    if (r.status === 'approved') {
      store.data.server = zollify.server;
      store.save();
    }
    return r;
  });
  ipcMain.handle('zollify:logout', () => zollify.logout());
  ipcMain.handle('zollify:catalog', () => zollify.catalog().catch(fail));
  ipcMain.handle('zollify:lastEventSold', () => zollify.lastEventSold().catch(fail));
  ipcMain.handle('zollify:forecast', (_e, today: string) => zollify.forecast(String(today)).catch(fail));

  // ── Zollify materials, through a printer key (Sourcing → Materials → Printing app) ──
  /** Stores a printer key once Zollify accepts it; '' removes it. */
  ipcMain.handle('materials:setKey', async (_e, key: string): Promise<Settings> => {
    const k = String(key ?? '').trim();
    if (k) await listMaterials(zollify.server, k).catch(fail);
    const { value, encrypted } = sealSecret(k);
    store.data.printerKey = value || undefined;
    store.data.printerKeyEncrypted = encrypted;
    store.save();
    return store.settings();
  });
  /**
   * The materials, through the sign-in when it may (an owner or admin, Sourcing on, a server with
   * the printing calls), else through a stored printer key. `note` says why neither works.
   */
  async function paperAccess(): Promise<PaperAccess> {
    let note = 'Sign in to Zollify first.';
    if (zollify.session) {
      try {
        return { via: 'session', materials: await zollify.printingMaterials(), note: '' };
      } catch (err) {
        note = err instanceof ZollifyError ? sessionRefusal(err.status, err.message) : String(err);
      }
    }
    const key = readPrinterKey();
    if (!key) return { via: null, materials: [], note };
    try {
      return { via: 'key', materials: await listMaterials(zollify.server, key), note };
    } catch (err) {
      return { via: null, materials: [], note: err instanceof Error ? err.message : String(err) };
    }
  }
  let paperVia: PaperAccess['via'] = null;
  ipcMain.handle('materials:list', async () => {
    const access = await paperAccess();
    paperVia = access.via;
    return access;
  });
  /**
   * Logs paper used. `job` names the copies (run, item, which copies), and the use's id is made
   * from it, so sending the same copies again counts once.
   */
  ipcMain.handle('materials:use', async (_e, use: Omit<MaterialUse, 'id'> & { job: string }) => {
    const u: MaterialUse = { material: use.material, qty: use.qty, note: use.note, id: `pd-${createHash('sha256').update(use.job).digest('hex').slice(0, 40)}` };
    // Through the sign-in when that is how the materials were read; the key otherwise, or when the
    // sign-in is refused. The id makes a use sent both ways count once.
    if (paperVia === 'session' && zollify.session) {
      try {
        return await zollify.printingUse(u);
      } catch (err) {
        if (!(err instanceof ZollifyError && [401, 402, 403, 404].includes(err.status) && readPrinterKey())) return fail(err);
      }
    }
    return useMaterial(zollify.server, readPrinterKey(), u).catch(fail);
  });
  ipcMain.handle('zollify:addOnHand', (_e, items: { productId: string; variantId: string; add: number }[]) => zollify.addOnHand(items).catch(fail));

  // ── Price cards: drawn, updated and laid out on A4 by photocraft-cli, into a folder on this computer ──
  ipcMain.handle('zollify:priceData', () => zollify.priceData().catch(fail));
  ipcMain.handle('pick:png', async (e) => {
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openFile'], filters: [{ name: 'PNG image', extensions: ['png'] }] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('pick:folder', async (e) => {
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  const cardsDir = async (): Promise<string> => {
    const dir = store.data.priceCards.outDir || join(app.getPath('documents'), 'Price cards');
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const fileSafe = (s: string): string => s.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 60) || 'Card';
  ipcMain.handle('cards:dir', () => cardsDir());
  ipcMain.handle('cards:draw', async (_e, card: Omit<CardArt, 'mascot'> & { id: string; mascot: string }, fmt: PriceFormat) => {
    let mascot: CardArt['mascot'] = null;
    if (card.mascot) {
      const size = await pngSize(card.mascot);
      if (!size) return fail(new Error(`The mascot is not a PNG that can be read: ${card.mascot}`));
      mascot = { path: card.mascot, ...size };
    }
    const file = join(await cardsDir(), `${fileSafe(card.title)} ${card.id.slice(0, 6)}.psd`);
    return drawCard(store.data.photocraft, { ...card, mascot }, fmt, file).catch(fail);
  });
  ipcMain.handle('cards:setTexts', (_e, file: string, texts: Record<string, string>) => setCardTexts(store.data.photocraft, file, texts).catch(fail));
  ipcMain.handle('cards:sheets', async (_e, cards: { key: string; file: string; width: number; height: number }[]) => {
    const files = new Map(cards.map((c) => [c.key, c.file]));
    const placed = packSheets(cards).map((p) => ({ ...p, file: files.get(p.key)! }));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    return drawSheets(store.data.photocraft, placed, join(await cardsDir(), `Sheet ${stamp}`)).catch(fail);
  });
  ipcMain.handle('cards:pdf', (_e, file: string) => sheetPdf(store.data.photocraft, file).catch(fail));
  ipcMain.handle('cards:print', async (_e, files: string[]): Promise<PrintResult[]> => {
    const results: PrintResult[] = [];
    for (const file of files) {
      // The price cards' own print settings, on A4 unless they say otherwise; else the global ones' printer and driver, on A4 at the sheet's own size.
      const own = store.data.priceCards.print;
      const base = own ? { paper: 'a4', orientation: 'portrait', ...own } : { ...(store.data.global ?? {}), paper: 'a4', orientation: 'portrait', scaleToFit: false, scale: 100 };
      const params = await fitDriverPaper(base).catch(fail);
      results.push(await print(store.data.photocraft, { key: file, file, params, copies: 1 }));
    }
    return results;
  });
  /** A preview PNG as a data: URL: the page's CSP lets images in from 'self' and data: only. */
  ipcMain.handle('cards:image', async (_e, file: string) => `data:image/png;base64,${(await readFile(file)).toString('base64')}`);
  ipcMain.handle('cards:open', (_e, file: string) => shell.openPath(file));

  ipcMain.handle('photocraft:printers', () => printers(store.data.photocraft).catch(fail));
  ipcMain.handle('photocraft:size', (_e, file: string) => imageSize(store.data.photocraft, file).catch(fail));
  ipcMain.handle('photocraft:lastPrint', () => lastPrint(store.data.photocraft).catch(fail));
  // Driver settings hex as names; the printer's own names and options when its driver answers, codes otherwise.
  ipcMain.handle('photocraft:describeSettings', async (_e, hex: string): Promise<DevModeSummary[] | null> => {
    const dm = decodeDevMode(String(hex));
    if (!dm) return null;
    const [caps, options] = await Promise.all([printerCaps(dm.device).catch(() => undefined), driverOptions(dm.device, String(hex)).catch(() => ({}))]);
    return describeDevMode(dm, caps, options);
  });
  // ── Print queue tracking: jobs we sent, followed in the Windows spooler until they leave it ──
  /** `sent`: pages the driver last reported; `goneAt`: when the job left the queue, while its outcome is looked up. */
  const tracked = new Map<string, { printer: string; id: number; copies: number; since: number; sent: number; goneAt?: number }>();
  /** How long to wait for Windows to log a job that left the queue before taking it as printed. */
  const LOG_WAIT_MS = 15_000;
  let watcher: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const report = (p: CopyProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('spooler:progress', p);
  };
  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const snap = await snapshot();
      if (!snap) return; // the query failed this time; keep the jobs and try again
      for (const [key, t] of tracked) {
        const job = snap.jobs.find((j) => j.printer === t.printer && j.id === t.id);
        if (job) {
          const p = progressOf(key, t.copies, job, snap.printers.find((pr) => pr.name === t.printer));
          t.sent = p.printed;
          report(p);
          continue;
        }
        // Left the queue: printed or cancelled, which only Windows' print log tells apart.
        t.goneAt ??= Date.now();
        const outcome = await jobOutcome(t.printer, t.id, t.since);
        if (!outcome && Date.now() - t.goneAt < LOG_WAIT_MS) {
          report({ key, copies: t.copies, printed: t.sent, left: t.copies - t.sent, status: 'Finishing', done: false });
          continue;
        }
        report(finishedOf(key, t.copies, t.sent, outcome));
        tracked.delete(key);
      }
    } finally {
      polling = false;
      if (!tracked.size) {
        clearInterval(watcher);
        watcher = undefined;
      }
    }
  }

  ipcMain.handle('photocraft:print', async (_e, jobs: PrintJob[]): Promise<PrintResult[]> => {
    // One at a time: the printer queue is sequential anyway, and the results stay in order.
    const results: PrintResult[] = [];
    for (const asked of jobs) {
      report({ key: asked.key, copies: asked.copies, printed: 0, left: asked.copies, status: 'Sending to PhotoCraft', done: false });
      let job: PrintJob;
      try {
        job = { ...asked, params: await fitDriverPaper(asked.params) };
      } catch (err) {
        const message = `Driver settings: ${err instanceof Error ? err.message : String(err)}`;
        results.push({ key: asked.key, ok: false, message });
        report({ key: asked.key, copies: asked.copies, printed: 0, left: 0, status: message, done: true, failed: true });
        continue;
      }
      // A few seconds early, so the print log's events for this job are surely after it.
      const since = Date.now() - 5000;
      const before = await snapshot();
      const r = await print(store.data.photocraft, job);
      results.push(r);
      if (!r.ok) {
        report({ key: job.key, copies: job.copies, printed: 0, left: 0, status: r.message, done: true, failed: true });
        continue;
      }
      const after = before && (await snapshot());
      const printer = after ? targetPrinter(after, job.params.printer) : '';
      const spooled = before && after ? newJob(before, after, printer, basename(job.file)) : undefined;
      if (!spooled) {
        // No Windows queue to follow, or the job already left it: sent is as far as we can see.
        report({ key: job.key, copies: job.copies, printed: job.copies, left: 0, status: r.message, done: true });
        continue;
      }
      tracked.set(job.key, { printer: spooled.printer, id: spooled.id, copies: job.copies, since, sent: Math.min(job.copies, spooled.pagesPrinted) });
      report(progressOf(job.key, job.copies, spooled, after!.printers.find((p) => p.name === spooled.printer)));
      watcher ??= setInterval(() => void poll(), 2000);
    }
    return results;
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
