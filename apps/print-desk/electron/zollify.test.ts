import { afterEach, describe, expect, it, vi } from 'vitest';
import { Zollify } from './zollify.js';

/**
 * A stand-in Zollify server: an op log with server sequence numbers, sync pull from a sequence,
 * and sync push appending ops. Records every pull's `since`.
 */
function fakeServer() {
  const log: { serverSeq: number; type: string; payload: unknown }[] = [];
  const pulls: number[] = [];
  const add = (type: string, payload: unknown): void => void log.push({ serverSeq: log.length + 1, type, payload });
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/api/auth/refresh') return json({ accessToken: 'a', refreshToken: 'r', user: { accountId: 'acc', email: 'e@x' } });
    if (u.pathname === '/api/sync/pull') {
      const since = Number(u.searchParams.get('since'));
      pulls.push(since);
      return json({ ops: log.filter((o) => o.serverSeq > since), latestSeq: log.length });
    }
    if (u.pathname === '/api/sync/push') {
      for (const op of JSON.parse(String(init?.body)).ops) add(op.type, op.payload);
      return json({ accepted: 1 });
    }
    return new Response('{}', { status: 404 });
  });
  return { add, pulls };
}

const product = { id: 'p', title: 'Kyoto', type: 'Art Print', variants: [{ id: 'a3', name: 'A3' }], updatedAt: 1 };

describe('Zollify stock sync', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pulls only what is new, and sees stock counted elsewhere', async () => {
    const server = fakeServer();
    server.add('product.upsert', product);
    server.add('inventory.set', { productId: 'p', variantId: 'a3', onHand: 4, updatedAt: 1 });
    const z = new Zollify('http://zollify.test', 'r', 'dev', () => {});
    await z.resume();
    expect((await z.catalog())[0]!.onHand).toBe(4);
    // A stock count in the Zollify app.
    server.add('inventory.set', { productId: 'p', variantId: 'a3', onHand: 10, updatedAt: 2 });
    expect((await z.catalog())[0]!.onHand).toBe(10);
    expect(server.pulls).toEqual([0, 2]);
  });

  it('adds printed copies onto the count as Zollify has it now', async () => {
    const server = fakeServer();
    server.add('product.upsert', product);
    server.add('inventory.set', { productId: 'p', variantId: 'a3', onHand: 4, updatedAt: 1 });
    const z = new Zollify('http://zollify.test', 'r', 'dev', () => {});
    await z.resume();
    await z.catalog(); // the app saw 4
    server.add('inventory.set', { productId: 'p', variantId: 'a3', onHand: 10, updatedAt: Date.now() - 1000 }); // counted to 10 elsewhere
    expect(await z.addOnHand([{ productId: 'p', variantId: 'a3', add: 2 }])).toEqual([{ key: 'p:a3', onHand: 12 }]);
    expect((await z.catalog())[0]!.onHand).toBe(12);
  });

  it('runs one pull at a time, so ops are never added twice', async () => {
    const server = fakeServer();
    server.add('product.upsert', product);
    const z = new Zollify('http://zollify.test', 'r', 'dev', () => {});
    await z.resume();
    const [a, b] = await Promise.all([z.catalog(), z.catalog()]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(server.pulls).toEqual([0, 1]);
  });
});
