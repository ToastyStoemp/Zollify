import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '@zollify/sdk';

/**
 * The live channel's reconnect costs a TLS handshake each time, so it must
 * not spin: a refused (expired) token is refreshed before trying again, and
 * the backoff only resets once the server has actually accepted the socket.
 * And a till must not broadcast its cart when no display is listening.
 */

const account: AccountSnapshot = {
  accountId: 'acct-rt',
  accountName: 'RT',
  userId: 'u-1',
  email: 'o@example.com',
  role: 'owner',
  allowedEventIds: null,
  profile: { setupCompletedAt: 1, artist: { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '', vatId: '', eori: '' }, defaultCurrency: 'CHF' },
};

let token = 'stale';
const refresh = vi.fn(async () => {
  token = 'fresh';
  return true;
});

vi.mock('../session', () => ({
  getAccount: () => account,
  getAccessToken: () => token,
  getApiBase: () => 'https://booth.example/api',
  refreshAccessToken: () => refresh(),
  onAccountChange: () => () => {},
  authFetch: async () => ({ ops: [], latestSeq: 0 }),
}));
vi.mock('../shell-updates', () => ({ announceShellUpdate: async () => {} }));

class FakeSocket {
  static all: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (ev: { data: string }) => void;
  onclose?: (ev: { code: number }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  // Test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const rt = await import('../core/realtime');
// A real macrotask (fake timers only replace setTimeout), so IndexedDB work can finish.
const nextMacrotask = (globalThis as unknown as { setImmediate(cb: () => void): void }).setImmediate;
const tick = () => new Promise<void>((r) => nextMacrotask(r));
const latest = () => FakeSocket.all[FakeSocket.all.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  FakeSocket.all = [];
  token = 'stale';
  refresh.mockClear();
});
afterEach(() => {
  rt.stopRealtime();
  vi.useRealTimers();
});

async function connect(): Promise<FakeSocket> {
  rt.startRealtime();
  for (let i = 0; i < 500 && !FakeSocket.all.length; i++) await tick();
  return latest();
}

describe('reconnecting', () => {
  it('refreshes a refused token before trying again, instead of retrying with it', async () => {
    const first = await connect();
    expect(first.url).toContain('token=stale');
    first.open();
    first.drop(4001); // the server refused the token
    await tick();
    expect(refresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 500 && FakeSocket.all.length < 2; i++) await tick();
    expect(latest().url).toContain('token=fresh');
  });

  it('backs off on sockets that open but are never accepted', async () => {
    const first = await connect();
    first.open();
    first.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 500 && FakeSocket.all.length < 2; i++) await tick();
    const second = latest();
    second.open(); // opened, but the server never said a word
    second.drop();
    // Second attempt waits 2s, not 1s again: the open alone did not reset it.
    await vi.advanceTimersByTimeAsync(1_500);
    for (let i = 0; i < 500; i++) await tick();
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600);
    for (let i = 0; i < 500 && FakeSocket.all.length < 3; i++) await tick();
    expect(FakeSocket.all).toHaveLength(3);
  });
});

describe('customer display carts', () => {
  const cart = { deviceName: '', eventName: 'Con', currency: 'CHF', lines: [], discounts: [], total: 0, ts: 1 };
  const carts = (s: FakeSocket) => s.sent.filter((m) => m.type === 'display.cart');

  it('sends nothing while no display listens, and the current cart the moment one appears', async () => {
    const ws = await connect();
    ws.open();
    expect(ws.sent[0]).toEqual({ type: 'display.subscribe', on: false });
    ws.receive({ type: 'display.listeners', count: 0 });

    rt.sendDisplayCart(cart);
    rt.sendDisplayCart({ ...cart, total: 12 });
    expect(carts(ws)).toHaveLength(0);

    ws.receive({ type: 'display.listeners', count: 1 });
    expect(carts(ws)).toHaveLength(1);
    expect((carts(ws)[0]!.cart as { total: number }).total).toBe(12);

    rt.sendDisplayCart(cart);
    expect(carts(ws)).toHaveLength(2);
  });

  it('keeps sending to a server too old to say who is listening', async () => {
    const ws = await connect();
    ws.open();
    ws.receive({ type: 'shell.update' });
    rt.sendDisplayCart(cart);
    expect(carts(ws)).toHaveLength(1);
  });

  it('tells the server when this device shows a display', async () => {
    const ws = await connect();
    ws.open();
    rt.setDisplaySubscribed(true);
    expect(ws.sent.at(-1)).toEqual({ type: 'display.subscribe', on: true });
    rt.setDisplaySubscribed(false);
  });
});
