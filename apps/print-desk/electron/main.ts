import { BrowserWindow, app, dialog, ipcMain, nativeTheme, safeStorage } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExe, print, printers } from './photocraft.js';
import type { PrintJob, PrintResult, Settings } from './shared.js';
import { Store } from './store.js';
import { Zollify, ZollifyError, type LoginInput } from './zollify.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const store = new Store(join(app.getPath('userData'), 'print-desk.json'));
if (!store.data.photocraft) store.data.photocraft = findExe();

function readRefresh(): string {
  const { refreshToken, refreshEncrypted } = store.data;
  if (!refreshToken) return '';
  if (!refreshEncrypted) return refreshToken;
  try {
    return safeStorage.decryptString(Buffer.from(refreshToken, 'base64'));
  } catch {
    return '';
  }
}
function writeRefresh(token: string): void {
  store.data.refreshEncrypted = !!token && safeStorage.isEncryptionAvailable();
  store.data.refreshToken = store.data.refreshEncrypted ? safeStorage.encryptString(token).toString('base64') : token;
  store.save();
}

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
    const r = await dialog.showOpenDialog(owner(e), { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['psd', 'psb', 'pcraft', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'] }] });
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
  ipcMain.handle('zollify:setOnHand', (_e, items: { productId: string; variantId: string; onHand: number }[]) => zollify.setOnHand(items).catch(fail));

  ipcMain.handle('photocraft:printers', () => printers(store.data.photocraft).catch(fail));
  ipcMain.handle('photocraft:print', async (e, jobs: PrintJob[]): Promise<PrintResult[]> => {
    // One at a time: the printer queue is sequential anyway, and the results stay in order.
    const results: PrintResult[] = [];
    for (const job of jobs) {
      const r = await print(store.data.photocraft, job);
      results.push(r);
      e.sender.send('photocraft:progress', r);
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
