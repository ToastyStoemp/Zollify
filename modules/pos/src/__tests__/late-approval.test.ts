import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesEvent } from '@zollify/shared';
import type { Sdk } from '@zollify/sdk';
import type { PaymentProvider, PaymentResult } from '../payments/provider';

/**
 * A terminal can approve a card after the seller gave up on the payment. The
 * sale is not recorded then (a retry may be running), but the card was
 * charged: the seller is told at once, and the warning is still there after
 * a reload, until someone marks it as dealt with.
 */

const h = vi.hoisted(() => ({ answer: null as null | ((r: PaymentResult) => void) }));
const terminal: PaymentProvider = {
  id: 'mypos-go2',
  label: 'MyPOS GO2',
  isAvailable: async () => true,
  getStatus: async () => ({ connected: true }),
  startPayment: () => new Promise<PaymentResult>((resolve) => (h.answer = resolve)),
  // The terminal does not let go: its answer still arrives later.
  cancel: async () => {},
};
vi.mock('../payments/registry', () => ({ getProvider: () => terminal }));

const { setSdk } = await import('../runtime');
const { addMisc, cancelCheckout, checkout, clear, setCartEvent } = await import('../cart');
const { dismissLateApproval, lateApprovalText, lateApprovals, loadLateApprovals } = await import('../lib/late-approvals');

const store: Record<string, unknown> = {};
const toasts: { message: string; kind?: string }[] = [];
const sales: unknown[] = [];
const empty = (): unknown => new Proxy(() => [], { get: (_t, k) => (k === 'then' ? undefined : empty()), apply: () => [] });
const fake = new Proxy(
  {
    data: new Proxy({ events: { sellLock: () => null, list: () => [], get: () => undefined } } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : empty()) }),
    events: { emit: (_name: string, sale: unknown) => sales.push(sale) },
    ui: { toast: (message: string, options?: { kind?: string }) => toasts.push({ message, kind: options?.kind }) },
    config: {
      get: async (key: string) => store[key],
      set: async (key: string, value: unknown) => void (store[key] = JSON.parse(JSON.stringify(value))),
    },
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : empty()) },
) as unknown as Sdk;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r));

beforeEach(() => {
  setSdk(fake);
  for (const key of Object.keys(store)) delete store[key];
  toasts.length = 0;
  sales.length = 0;
  lateApprovals.value = [];
  clear();
  setCartEvent({ id: 'con', name: 'con', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 } as SalesEvent, 'EUR');
});

/** Seller starts a 25 EUR card payment, cancels, and the terminal approves anyway. */
async function approveAfterCancel(): Promise<void> {
  addMisc('Print', 25, 1);
  const run = checkout('s1', { method: 'card', terminal: { providerId: 'mypos-go2' } });
  await tick();
  await cancelCheckout();
  h.answer!({ approved: true, provider: 'mypos-go2', txRef: 'TX-4711' });
  expect(await run).toMatchObject({ approved: false, cancelled: true });
  await tick();
}

describe('a card approved after the seller cancelled', () => {
  it('records no sale but tells the seller: which terminal, how much, which reference', async () => {
    await approveAfterCancel();
    expect(sales).toHaveLength(0);
    expect(lateApprovals.value).toHaveLength(1);
    expect(lateApprovals.value[0]).toMatchObject({ terminal: 'MyPOS GO2', amount: 25, currency: 'EUR', txRef: 'TX-4711' });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe('error');
    const text = lateApprovalText(lateApprovals.value[0]!);
    expect(toasts[0]!.message).toBe(text);
    expect(text).toContain('MyPOS GO2');
    expect(text).toContain('25');
    expect(text).toContain('TX-4711');
  });

  it('is still shown after a reload, until it is marked as dealt with', async () => {
    await approveAfterCancel();
    const id = lateApprovals.value[0]!.id;

    // Reload: memory is gone, the device's settings are not.
    lateApprovals.value = [];
    await loadLateApprovals();
    expect(lateApprovals.value.map((a) => a.id)).toEqual([id]);

    await dismissLateApproval(id);
    lateApprovals.value = [];
    await loadLateApprovals();
    expect(lateApprovals.value).toEqual([]);
  });

  it('a decline after cancel is nothing to warn about', async () => {
    addMisc('Print', 25, 1);
    const run = checkout('s1', { method: 'card', terminal: { providerId: 'mypos-go2' } });
    await tick();
    await cancelCheckout();
    h.answer!({ approved: false, provider: 'mypos-go2', error: 'Cancelled on terminal' });
    await run;
    await tick();
    expect(lateApprovals.value).toEqual([]);
    expect(toasts).toEqual([]);
  });
});
