/**
 * The Android shell.
 *
 * Zollify is a web app first. Wrapped in Capacitor it runs from local assets
 * at http://localhost, which changes three things and nothing else:
 *   - the API lives on a server the user names once (the web app is same-origin);
 *   - the refresh token comes back in the body and is kept on the device,
 *     because a cross-origin cookie would never be sent;
 *   - "download" means the Android save/share sheet, via the FileShare plugin.
 */

interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    isPluginAvailable?: (name: string) => boolean;
    Plugins?: Record<string, unknown>;
  };
}

const cap = (): CapacitorGlobal['Capacitor'] | undefined => (globalThis as CapacitorGlobal).Capacitor;

export function isNative(): boolean {
  return cap()?.isNativePlatform?.() === true;
}

function nativePlugin(name: string): Record<string, (...a: unknown[]) => Promise<unknown>> | null {
  const c = cap();
  if (!c || c.isNativePlatform?.() !== true) return null;
  if (typeof c.isPluginAvailable === 'function' && !c.isPluginAvailable(name)) return null;
  return (c.Plugins?.[name] as Record<string, (...a: unknown[]) => Promise<unknown>> | undefined) ?? null;
}

// ── Server address ──────────────────────────────────────────────────────────

const SERVER_KEY = 'zollify.serverUrl';

/** The server this device talks to; '' until the user has entered one. */
export function getServerUrl(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setServerUrl(url: string): void {
  const clean = url.trim().replace(/\/+$/, '');
  try {
    if (clean) localStorage.setItem(SERVER_KEY, clean);
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* no storage */
  }
}

// ── Refresh token on the device ─────────────────────────────────────────────
// ponytail: localStorage; move to @capacitor/preferences (Keystore-backed) if
// a device audit ever asks for it. The token is only ever used from this app.

const REFRESH_KEY = 'zollify.refreshToken';

export function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function storeRefreshToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* no storage */
  }
}

// ── Files ───────────────────────────────────────────────────────────────────

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Hands the user a file: a download on the web, the Android save dialog in the app. */
export async function saveFile(filename: string, content: string | Blob, mimeType: string): Promise<void> {
  const share = nativePlugin('FileShare');
  if (share?.saveToDevice) {
    const body = typeof content === 'string' ? { filename, content, mimeType } : { filename, content: await toBase64(content), mimeType, encoding: 'base64' };
    await share.saveToDevice(body);
    return;
  }
  downloadBlob(filename, typeof content === 'string' ? new Blob([content], { type: mimeType }) : content);
}

/**
 * Opens a document for reading or printing: a new tab on the web, the
 * device's own viewer in the app. Returns false when the web tab was blocked
 * so the caller can show the content inline instead.
 */
export async function openDocument(filename: string, content: string, mimeType = 'text/html;charset=utf-8'): Promise<boolean> {
  const share = nativePlugin('FileShare');
  if (share?.openFile) {
    try {
      await share.openFile({ filename, content, mimeType });
    } catch {
      await share.shareFile?.({ filename, content, mimeType });
    }
    return true;
  }
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const win = window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(win);
}
