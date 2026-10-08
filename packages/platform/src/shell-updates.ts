import { getServerUrl, isNative } from './native';
import { createShellUi } from './shell-ui';

/**
 * Content-only self-update of the Android shell, through @capgo/capacitor-updater
 * (self-hosted, manual mode - see capacitor.config.ts's CapacitorUpdater
 * block and packages/server-core/src/routes/shell-updates.ts).
 *
 * Unlike updates.ts's full-APK flow, this swaps only the WebView's own JS/HTML/
 * CSS, needs no "install unknown app" dialog, and is available on every
 * flavour including carbon - a myPOS Carbon terminal takes its APK through
 * myPOS's own channel, but this never looks like an app update to begin with,
 * just the app fetching content over HTTPS the way it already fetches API data.
 *
 * A native change (new plugin, permission, manifest edit) still needs a real
 * APK build - this can only ever replace what already runs inside one.
 */

interface BundleInfo {
  id: string;
  version: string;
}

interface CapacitorUpdaterPlugin {
  notifyAppReady(): Promise<{ bundle: BundleInfo }>;
  current(): Promise<{ bundle: BundleInfo; native: boolean }>;
  download(opts: { url: string; version: string; checksum: string }): Promise<BundleInfo>;
  next(opts: { id: string }): Promise<BundleInfo>;
  /** The bundle next() queued, or null when none is - the plugin's own record, unlike our localStorage note. */
  getNextBundle?(): Promise<BundleInfo | null>;
  set(opts: { id: string }): Promise<void>;
  list(): Promise<{ bundles: (BundleInfo & { status?: string })[] }>;
  /** Applies whatever next() queued right now instead of waiting for the app's own next cold start. */
  reload(): Promise<void>;
}

function updater(): CapacitorUpdaterPlugin | null {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; isPluginAvailable?: (n: string) => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
  if (!isNative() || !cap) return null;
  if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('CapacitorUpdater')) return null;
  return (cap.Plugins?.CapacitorUpdater as CapacitorUpdaterPlugin | undefined) ?? null;
}

/**
 * Confirms this boot loaded correctly. Must run once per successful start -
 * the plugin auto-rolls back to the previous bundle if it never hears this,
 * on the assumption a bundle that never reports ready crashed on load.
 */
export async function notifyShellUpdateReady(): Promise<void> {
  await updater()?.notifyAppReady();
}

interface ShellManifest {
  version: string;
  url: string;
  integrity: string;
  sizeBytes: number;
}

/** Just what's active right now, for a settings screen to show even before checking anything. Null outside the native app. */
export async function currentShellVersion(): Promise<string | null> {
  const current = await updater()?.current();
  return current?.bundle.version ?? null;
}

export interface ShellUpdateCheck {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  url: string;
  /** SHA-256 hex of bundle.zip - the plugin's own download() rejects outright with "Checksum required" if this is missing, before even attempting the request. */
  integrity: string;
}

/**
 * Read-only half of the flow, for a "Check for updates" button that wants to
 * show a result either way (a settings screen), unlike the silent
 * background check below. Null when there's nothing to report at all: not
 * native, offline, or the server has never published a bundle.
 */
/**
 * The version downloaded and queued with next(), until a restart activates it.
 * current() keeps reporting the old bundle until then, so without this every
 * later check saw "update available" and downloaded the whole bundle again -
 * on every reconnect, all shift long, on a terminal nobody restarts.
 * Persisted so a reload of the page (not of the bundle) remembers too.
 */
const QUEUED_KEY = 'zollify.shellQueued';
function queuedVersion(): string | null {
  try {
    return localStorage.getItem(QUEUED_KEY);
  } catch {
    return null;
  }
}
function rememberQueued(version: string | null): void {
  try {
    if (version) localStorage.setItem(QUEUED_KEY, version);
    else localStorage.removeItem(QUEUED_KEY);
  } catch {
    /* no storage - the in-memory throttle still limits checks */
  }
}

export async function checkShellUpdate(): Promise<ShellUpdateCheck | null> {
  const plugin = updater();
  const server = getServerUrl();
  if (!plugin || !server) return null;
  const current = await plugin.current();
  const res = await fetch(`${server}/api/shell/latest`);
  if (!res.ok) return null;
  const latest = (await res.json()) as ShellManifest;
  if (!latest.version) return null;
  // Running what was queued: the restart happened, nothing is pending any more.
  if (queuedVersion() === current.bundle.version) rememberQueued(null);
  return { currentVersion: current.bundle.version, latestVersion: latest.version, available: latest.version !== current.bundle.version, url: latest.url, integrity: latest.integrity };
}

/**
 * Downloads and queues (next(), not set()) the update a checkShellUpdate()
 * call found - same "never mid-sale" reasoning as checkAndQueueShellUpdate().
 *
 * checksum is required, not optional: the plugin's manual download() throws
 * "Checksum required" and never even starts the HTTP request without one -
 * confirmed live, this was missing and every attempt failed before it left
 * the device, which looked exactly like a network/download failure
 * ("Failed to download from: <url>", the plugin's own generic wrapper
 * around whatever it threw) with no indication it was actually a
 * pre-flight validation error. Server already computes this SHA-256 for
 * its own manifest.json - same algorithm the plugin's own
 * CryptoCipher.calcChecksum() uses, so no separate computation is needed here.
 */
export async function queueShellUpdate(check: ShellUpdateCheck): Promise<void> {
  const plugin = updater();
  const server = getServerUrl();
  if (!plugin || !server) return;
  const downloaded = await plugin.download({ url: `${server}${check.url}`, version: check.latestVersion, checksum: check.integrity });
  await plugin.next({ id: downloaded.id });
  rememberQueued(check.latestVersion);
}

/**
 * True when this exact version is downloaded and the plugin really has it
 * queued. Our localStorage note alone is not enough: if the app restarted into
 * the bundle and it never reported ready the plugin rolls back and forgets the
 * queue, but the note stays - every check then said "downloaded, ready" about
 * an update that was gone, and "Reload now" reloaded the old bundle forever.
 */
export async function shellUpdateQueued(version: string): Promise<boolean> {
  if (queuedVersion() !== version) return false;
  const plugin = updater();
  if (!plugin?.getNextBundle) return true;
  try {
    const next = await plugin.getNextBundle();
    if (next?.version === version) return true;
  } catch {
    return true; // cannot tell - keep the old behaviour rather than re-download every time
  }
  rememberQueued(null);
  return false;
}

/**
 * Applies a queued update right now instead of waiting for the app's next
 * cold start - for a "Reload now" toast action, so a cashier can pick a
 * moment between customers rather than the update landing silently whenever
 * the terminal next happens to restart (which, left running all shift, might
 * be days). No-op outside the native app.
 */
export async function reloadShellNow(): Promise<void> {
  const plugin = updater();
  if (!plugin) return;
  const queued = queuedVersion();
  // Nothing queued means reload() would just restart the bundle already running.
  if (plugin.getNextBundle) {
    const next = await plugin.getNextBundle();
    if (!next) {
      rememberQueued(null);
      throw new Error('The update is no longer queued - check for updates again.');
    }
  }
  const before = (await plugin.current()).bundle.version;
  await plugin.reload();
  // A successful reload tears this page down. Still here a moment later: it did not apply.
  await new Promise((r) => setTimeout(r, 4000));
  const after = (await plugin.current()).bundle.version;
  if (after === before) {
    rememberQueued(null);
    throw new Error(`Could not switch to ${queued ?? 'the new content'}${after ? ` - still on ${after}` : ''}. Check for updates to download it again.`);
  }
}

/**
 * Background convenience only, same as checkForUpdate() in updates.ts: never
 * throws somewhere the caller has to notice, and does nothing at all outside
 * the native app. Downloads a newer bundle and queues it with next() rather
 * than set(), so it activates on the app's next cold start instead of
 * reloading out from under whatever the till is doing right now.
 *
 * Returns the queued version so the caller can tell the user, or null when
 * there was nothing to queue (already current, offline, not native, or the
 * check/download itself failed).
 */
/** Background checks at most this often; the server only changes on a redeploy. */
const CHECK_EVERY_MS = 30 * 60_000;
let lastBackgroundCheck = 0;

export async function checkAndQueueShellUpdate(): Promise<string | null> {
  if (Date.now() - lastBackgroundCheck < CHECK_EVERY_MS) return null;
  lastBackgroundCheck = Date.now();
  try {
    const check = await checkShellUpdate();
    if (!check?.available || (await shellUpdateQueued(check.latestVersion))) return null;
    await queueShellUpdate(check);
    return check.latestVersion;
  } catch {
    /* background convenience, never an error the user has to see */
    return null;
  }
}

/**
 * checkAndQueueShellUpdate() plus the user-facing toast, with a "Reload now"
 * action - shared by every trigger that should surface the same result: the
 * boot-time check and the WS shell.update doorbell (server sends this once
 * per connection, since the shell store only ever changes by redeploying the
 * whole server - see ws.ts). Both just call this; no separate toast wiring
 * per trigger.
 */
export async function announceShellUpdate(): Promise<void> {
  const queuedVersion = await checkAndQueueShellUpdate();
  if (!queuedVersion) return;
  createShellUi('shell').toast(`Update ${queuedVersion} downloaded - it'll be ready next time the app opens.`, {
    timeoutMs: 0,
    action: { label: 'Reload now', onClick: () => void reloadShellNow().catch((err) => createShellUi('shell').toast(err instanceof Error ? err.message : 'Could not reload.', { kind: 'error' })) },
  });
}
