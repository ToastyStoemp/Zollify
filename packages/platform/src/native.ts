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

/** Base64 per write: whole multiples of 3 bytes, so each piece decodes on its own. */
const SAVE_CHUNK = 3 * 256 * 1024;

/** Hands the user a file: a download on the web, the Android save dialog in the app. */
export async function saveFile(filename: string, content: string | Blob, mimeType: string): Promise<void> {
  const share = nativePlugin('FileShare');
  // A large file (a backup with every photo) goes to the device in pieces: as
  // one base64 string it can take more memory than the app has.
  if (share?.beginSave && typeof content !== 'string' && content.size > SAVE_CHUNK) {
    let opened: { opened?: boolean } | null = null;
    try {
      opened = (await share.beginSave({ filename, mimeType })) as { opened?: boolean };
    } catch {
      opened = null; // an app without chunked saving: the one-piece save below
    }
    if (opened) {
      if (!opened.opened) return; // cancelled in the save dialog
      try {
        for (let at = 0; at < content.size; at += SAVE_CHUNK) await share.writeChunk!({ data: await toBase64(content.slice(at, at + SAVE_CHUNK)) });
        await share.endSave!();
      } catch (err) {
        await share.abortSave?.().catch(() => undefined);
        throw err;
      }
      return;
    }
  }
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
    // Android picks a viewer by the bare type; a charset parameter matches
    // nothing but a plain-text editor, which shows the markup as text.
    const type = mimeType.split(';')[0]!.trim();
    try {
      await share.openFile({ filename, content, mimeType: type });
    } catch {
      await share.shareFile?.({ filename, content, mimeType: type });
    }
    return true;
  }
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const win = window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(win);
}

/**
 * Opens a binary file (a PDF ticket, a photo) in the device's own viewer: a
 * new tab on the web, the Android viewer in the app. Falls back to saving it
 * when nothing can show it, and returns false only if a web tab was blocked.
 */
export async function openFileBlob(filename: string, blob: Blob, mimeType: string): Promise<boolean> {
  const share = nativePlugin('FileShare');
  if (share?.openFile) {
    const body = { filename, content: await toBase64(blob), mimeType, encoding: 'base64' };
    try {
      await share.openFile(body);
    } catch {
      await share.shareFile?.(body);
    }
    return true;
  }
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(win);
}

/**
 * Puts text on the clipboard. The clipboard API where the WebView allows it,
 * else the old select-and-copy; false when neither did.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* blocked or missing: the fallback below */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
