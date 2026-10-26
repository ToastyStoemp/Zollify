import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Go2 over Wi-Fi loses its link while the phone sleeps, and the myPOS SDK
 * never says so. The till checks the link before a payment and reopens it on
 * waking - against a pretend terminal here.
 */

const h = vi.hoisted(() => ({
  term: {
    connected: false,
    alive: true,
    /** Answers a connect only from this attempt on (Wi-Fi still waking before). */
    answersFrom: 1,
    connects: 0,
    payments: 0,
    paymentDone: null as null | (() => void),
  },
  settings: {} as Record<string, unknown>,
}));
const { term, settings } = h;

vi.mock('../native/plugins', () => ({
  hasNativePlugin: () => true,
  MyPos: {
    getStatus: async () => ({ connected: h.term.connected, alive: h.term.alive }),
    connectTerminal: async () => {
      h.term.connects++;
      h.term.connected = false;
      if (h.term.connects >= h.term.answersFrom) {
        setTimeout(() => {
          h.term.connected = true;
          h.term.alive = true;
        }, 500);
      }
      return { granted: true };
    },
    startPayment: () =>
      new Promise((resolve) => {
        h.term.payments++;
        h.term.paymentDone = () => resolve({ approved: true, transactionId: 't1' });
      }),
    cancelPayment: async () => {},
  },
}));
vi.mock('../lib/settings', () => ({ getSetting: async (key: string) => h.settings[key] }));

const go2 = await import('../payments/mypos-go2');
const { ensureGo2Ready, myposGo2Provider, watchGo2Wake, resetGo2Watch, GO2_TRANSPORT_SETTING, GO2_HOST_SETTING } = go2;

function wifi(): void {
  settings[GO2_TRANSPORT_SETTING] = 'wifi';
  settings[GO2_HOST_SETTING] = '192.168.1.40';
}

beforeEach(() => {
  vi.useFakeTimers();
  resetGo2Watch();
  Object.assign(term, { connected: true, alive: true, answersFrom: 1, connects: 0, payments: 0, paymentDone: null });
  for (const k of Object.keys(settings)) delete settings[k];
  wifi();
});
afterEach(() => {
  vi.useRealTimers();
});

async function settle<T>(p: Promise<T>, ms = 12_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe('before a payment', () => {
  it('leaves a live link alone', async () => {
    expect(await settle(ensureGo2Ready())).toBe(true);
    expect(term.connects).toBe(0);
  });

  it('reopens a link that died while the phone slept', async () => {
    term.alive = false;
    expect(await settle(ensureGo2Ready())).toBe(true);
    expect(term.connects).toBe(1);
  });

  it('reopens it when the terminal is not ready at all', async () => {
    term.connected = false;
    expect(await settle(ensureGo2Ready())).toBe(true);
    expect(term.connects).toBe(1);
  });

  it('keeps trying while the phone’s Wi-Fi wakes up', async () => {
    term.connected = false;
    term.answersFrom = 2;
    expect(await settle(ensureGo2Ready())).toBe(true);
    expect(term.connects).toBe(2);
  });

  it('gives up after ten seconds with a message saying where it looked, and charges nothing', async () => {
    term.connected = false;
    term.answersFrom = 99;
    const result = await settle(myposGo2Provider.startPayment({ amount: 12.5, currency: 'EUR', reference: 's1' }));
    expect(result.approved).toBe(false);
    expect(result.error).toContain('192.168.1.40');
    expect(term.connects).toBe(3);
    expect(term.payments).toBe(0);
  });

  it('pays once the link is back', async () => {
    term.alive = false;
    const paying = myposGo2Provider.startPayment({ amount: 12.5, currency: 'EUR', reference: 's1' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(term.payments).toBe(1);
    term.paymentDone?.();
    expect((await paying).approved).toBe(true);
  });

  it('shares one attempt between overlapping checks', async () => {
    term.connected = false;
    const [a, b] = await settle(Promise.all([ensureGo2Ready(), ensureGo2Ready()]));
    expect([a, b]).toEqual([true, true]);
    expect(term.connects).toBe(1);
  });

  it('never reconnects Bluetooth - that would open the terminal picker', async () => {
    settings[GO2_TRANSPORT_SETTING] = 'bluetooth';
    term.connected = false;
    expect(await settle(ensureGo2Ready({ force: true }))).toBe(false);
    expect(term.connects).toBe(0);
  });
});

describe('when the app comes back', () => {
  const fakeDocument = () => Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' });
  let doc = fakeDocument();
  beforeEach(() => {
    // A fresh one each time: listeners from the test before must not answer.
    doc = fakeDocument();
    (globalThis as { document?: unknown }).document = doc;
  });
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });
  const flip = (state: 'visible' | 'hidden'): void => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event('visibilitychange'));
  };

  it('opens a fresh link after a real sleep, even one that looks alive', async () => {
    watchGo2Wake(async () => true);
    flip('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    flip('visible');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(term.connects).toBe(1);
  });

  it('only checks the link after a glance away', async () => {
    watchGo2Wake(async () => true);
    flip('hidden');
    await vi.advanceTimersByTimeAsync(2_000);
    flip('visible');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(term.connects).toBe(0);
  });

  it('does nothing once another terminal is in use', async () => {
    watchGo2Wake(async () => false);
    flip('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    flip('visible');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(term.connects).toBe(0);
  });

  it('never cuts a payment in progress', async () => {
    watchGo2Wake(async () => true);
    const paying = myposGo2Provider.startPayment({ amount: 12.5, currency: 'EUR', reference: 's1' });
    await vi.advanceTimersByTimeAsync(100);
    flip('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    flip('visible');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(term.connects).toBe(0);
    term.paymentDone?.();
    await paying;
  });
});
