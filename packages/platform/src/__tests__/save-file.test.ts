import { afterEach, describe, expect, it } from 'vitest';
import { saveFile } from '../native';

/** A large file goes to Android in pieces, never as one base64 string the app may not have room for. */
const calls: { name: string; arg?: unknown }[] = [];
function fakeApp(methods: Record<string, (arg?: unknown) => Promise<unknown>>): void {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    isPluginAvailable: () => true,
    Plugins: { FileShare: Object.fromEntries(Object.entries(methods).map(([k, fn]) => [k, (arg?: unknown) => (calls.push({ name: k, arg }), fn(arg))])) },
  };
}
afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  calls.length = 0;
});

describe('saving a file in the app', () => {
  const big = new Blob([new Uint8Array(2 * 1024 * 1024 + 5).fill(7)], { type: 'application/zip' });

  it('writes a large file in chunks that decode back to the same bytes', async () => {
    const written: Uint8Array[] = [];
    fakeApp({
      beginSave: async () => ({ opened: true }),
      writeChunk: async (arg) => void written.push(Uint8Array.from(atob((arg as { data: string }).data), (c) => c.charCodeAt(0))),
      endSave: async () => ({ saved: true }),
      saveToDevice: async () => ({}),
    });
    await saveFile('b.zip', big, 'application/zip');
    expect(calls.map((c) => c.name).filter((n) => n !== 'writeChunk')).toEqual(['beginSave', 'endSave']);
    expect(written.length).toBeGreaterThan(1);
    const total = written.reduce((n, w) => n + w.length, 0);
    expect(total).toBe(big.size);
    expect(written.every((w) => w.every((b) => b === 7))).toBe(true);
  });

  it('does nothing more when the save dialog is cancelled', async () => {
    fakeApp({ beginSave: async () => ({ opened: false, cancelled: true }), saveToDevice: async () => ({}) });
    await saveFile('b.zip', big, 'application/zip');
    expect(calls.map((c) => c.name)).toEqual(['beginSave']);
  });

  it('falls back to the one-piece save on an app without chunked saving', async () => {
    fakeApp({ beginSave: async () => Promise.reject(new Error('not implemented')), saveToDevice: async () => ({ saved: true }) });
    await saveFile('b.zip', big, 'application/zip');
    expect(calls.map((c) => c.name)).toEqual(['beginSave', 'saveToDevice']);
  });
});
