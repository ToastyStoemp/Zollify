import { reactive } from 'vue';
import { getServerUrl, isNative } from './native';

/**
 * Self-update of the Android app, through the Updater plugin.
 *
 * The server publishes one version and an APK per flavour; the app compares
 * that with its own build, downloads in the background, and installs only
 * when the user taps - the system's "install unknown app" dialog would be
 * disruptive mid-sale otherwise. The carbon flavour never updates from here:
 * a myPOS Carbon terminal takes its apps through myPOS's own channel.
 */

export type Flavor = 'carbon' | 'compat' | 'full';

interface UpdaterPlugin {
  getCurrentVersion(): Promise<{ versionCode: number; versionName: string; flavor: string }>;
  download(opts: { url: string }): Promise<void>;
  install(): Promise<void>;
  addListener(event: 'updateDownloadProgress', handler: (e: { bytesWritten: number; totalBytes: number }) => void): Promise<unknown>;
}

function updater(): UpdaterPlugin | null {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; isPluginAvailable?: (n: string) => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
  if (!isNative() || !cap) return null;
  if (typeof cap.isPluginAvailable === 'function' && !cap.isPluginAvailable('Updater')) return null;
  return (cap.Plugins?.Updater as UpdaterPlugin | undefined) ?? null;
}

export interface UpdateCheck {
  versionCode: number;
  versionName: string;
  currentVersionCode: number;
  currentVersionName: string;
  flavor: Flavor;
  available: boolean;
  downloadUrl: string;
}

/** True when this install can update itself at all: the app, not the web, and not a Carbon terminal. */
export async function selfUpdates(): Promise<boolean> {
  const plugin = updater();
  if (!plugin) return false;
  const { flavor } = await plugin.getCurrentVersion();
  return flavor !== 'carbon';
}

/** Compares this install against what the server publishes; null when self-update is not possible here. */
export async function checkForUpdate(): Promise<UpdateCheck | null> {
  const plugin = updater();
  const server = getServerUrl();
  if (!plugin || !server) return null;
  const current = await plugin.getCurrentVersion();
  const flavor = current.flavor as Flavor;
  if (flavor === 'carbon') return null;
  const res = await fetch(`${server}/api/updates/latest`);
  if (!res.ok) return null;
  const latest = (await res.json()) as { versionCode: number; versionName: string };
  return {
    versionCode: latest.versionCode,
    versionName: latest.versionName,
    currentVersionCode: Number(current.versionCode),
    currentVersionName: current.versionName,
    flavor,
    available: latest.versionCode > Number(current.versionCode),
    downloadUrl: `${server}/api/updates/download/${flavor}`,
  };
}

/** One download state shared by the background check and the settings panel. */
export const updateDownload = reactive({
  active: false,
  /** Downloaded and waiting for the user to install. */
  ready: false,
  bytesWritten: 0,
  /** -1 until the server says. */
  totalBytes: -1,
  error: '',
  /** Which version the downloaded file is, so a newer publish is noticed. */
  versionName: '',
});

let listening = false;

/** No-op when a download is already running or this version is already waiting to install. */
export async function downloadUpdate(check: UpdateCheck): Promise<void> {
  const plugin = updater();
  if (!plugin) return;
  if (updateDownload.active || (updateDownload.ready && updateDownload.versionName === check.versionName)) return;
  if (!listening) {
    listening = true;
    void plugin.addListener('updateDownloadProgress', (e) => {
      updateDownload.bytesWritten = e.bytesWritten;
      updateDownload.totalBytes = e.totalBytes;
    });
  }
  Object.assign(updateDownload, { active: true, ready: false, error: '', bytesWritten: 0, totalBytes: -1, versionName: check.versionName });
  try {
    await plugin.download({ url: check.downloadUrl });
    updateDownload.ready = true;
  } catch (err) {
    updateDownload.error = err instanceof Error ? err.message : String(err);
  } finally {
    updateDownload.active = false;
  }
}

export async function installDownloadedUpdate(): Promise<void> {
  await updater()?.install();
}
