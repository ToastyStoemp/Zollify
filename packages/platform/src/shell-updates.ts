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

/**
 * Background convenience only, same as checkForUpdate() in updates.ts: never
 * throws somewhere the caller has to notice, and does nothing at all outside
 * the native app. Downloads a newer bundle and queues it with next() rather
 * than set(), so it activates on the app's next cold start instead of
 * reloading out from under whatever the till is doing right now.
 */
export async function checkAndQueueShellUpdate(): Promise<void> {
  const plugin = updater();
  const server = getServerUrl();
  if (!plugin || !server) return;
  try {
    const current = await plugin.current();
    const res = await fetch(`${server}/api/shell/latest`);
    if (!res.ok) return;
    const latest = (await res.json()) as ShellManifest;
    if (!latest.version || latest.version === current.bundle.version) return;

    const downloaded = await plugin.download({ url: `${server}${latest.url}`, version: latest.version });
    await plugin.next({ id: downloaded.id });
  } catch {
    /* background convenience, never an error the user has to see */
  }
}
