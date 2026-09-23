import { getServerUrl, isNative } from './native';

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
  download(opts: { url: string; version: string }): Promise<BundleInfo>;
  next(opts: { id: string }): Promise<BundleInfo>;
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
}

/**
 * Read-only half of the flow, for a "Check for updates" button that wants to
 * show a result either way (a settings screen), unlike the silent
 * background check below. Null when there's nothing to report at all: not
 * native, offline, or the server has never published a bundle.
 */
export async function checkShellUpdate(): Promise<ShellUpdateCheck | null> {
  const plugin = updater();
  const server = getServerUrl();
  if (!plugin || !server) return null;
  const current = await plugin.current();
  const res = await fetch(`${server}/api/shell/latest`);
  if (!res.ok) return null;
  const latest = (await res.json()) as ShellManifest;
  if (!latest.version) return null;
  return { currentVersion: current.bundle.version, latestVersion: latest.version, available: latest.version !== current.bundle.version, url: latest.url };
}

/** Downloads and queues (next(), not set()) the update a checkShellUpdate() call found - same "never mid-sale" reasoning as checkAndQueueShellUpdate(). */
export async function queueShellUpdate(check: ShellUpdateCheck): Promise<void> {
  const plugin = updater();
  const server = getServerUrl();
  if (!plugin || !server) return;
  const downloaded = await plugin.download({ url: `${server}${check.url}`, version: check.latestVersion });
  await plugin.next({ id: downloaded.id });
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
export async function checkAndQueueShellUpdate(): Promise<string | null> {
  try {
    const check = await checkShellUpdate();
    if (!check?.available) return null;
    await queueShellUpdate(check);
    return check.latestVersion;
  } catch {
    /* background convenience, never an error the user has to see */
    return null;
  }
}
