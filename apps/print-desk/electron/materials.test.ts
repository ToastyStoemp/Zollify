import { afterEach, describe, expect, it, vi } from 'vitest';
import { listMaterials, useMaterial } from './materials.js';

describe('materials client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the printer API with the key, and logs a use', async () => {
    const calls: { url: string; auth: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: String((init?.headers as Record<string, string>).authorization), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = url.endsWith('/materials')
        ? { materials: [{ id: 'm1', name: 'German Etching A3', type: 'paper', unit: 'sheet', onHand: 40, onOrder: 0 }] }
        : { material: { id: 'm1', name: 'German Etching A3', type: 'paper', unit: 'sheet', onHand: 38, onOrder: 0 }, duplicate: false };
      return new Response(JSON.stringify(json), { status: 200 });
    });
    expect((await listMaterials('https://z.test/', 'zpk_abc'))[0]!.onHand).toBe(40);
    const r = await useMaterial('https://z.test', 'zpk_abc', { material: 'm1', qty: 2, note: 'Kyoto A3 · Print Desk', id: 'pd-0123456789' });
    expect(r).toMatchObject({ material: { onHand: 38 }, duplicate: false });
    expect(calls).toEqual([
      { url: 'https://z.test/p/sourcing/materials', auth: 'Bearer zpk_abc', body: undefined },
      { url: 'https://z.test/p/sourcing/usage', auth: 'Bearer zpk_abc', body: { material: 'm1', qty: 2, note: 'Kyoto A3 · Print Desk', id: 'pd-0123456789' } },
    ]);
  });

  it("says why, in Zollify's words, and never calls without a key", async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'unauthorized', message: 'That printer key is not valid.' }), { status: 401 }));
    await expect(listMaterials('https://z.test', 'zpk_old')).rejects.toThrow('That printer key is not valid.');
    await expect(listMaterials('https://z.test', '')).rejects.toThrow(/No printer key/);
  });
});
