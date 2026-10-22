import { beforeEach, describe, expect, it } from 'vitest';
import type { Sdk } from '@zollify/sdk';
import { setSdk } from '../runtime';
import { addLine, addModuleLine, baseTotal, cart, checkout, clear, findModuleLine, replaceModuleLine, setCartEvent, setCustomDiscount, settledTotal, total } from '../cart';
import { applySettlements } from '../discounts';

/**
 * A settling line is money paid earlier (a gift card) spent on this sale: it
 * comes off the total, no discount reaches it, it carries no VAT, and the sale
 * records only what it actually covered - so a card worth more than the sale
 * keeps the rest.
 */

const emitted: unknown[] = [];
const empty = (): unknown => new Proxy(() => [], { get: (_t, k) => (k === 'then' ? undefined : empty()), apply: () => [] });
const fake = new Proxy(
  {
    data: new Proxy(
      {
        events: { sellLock: () => null, list: () => [], get: () => undefined },
        transactions: { recent: () => [] },
        discounts: { active: () => [] },
        products: { get: () => undefined },
      } as Record<string, unknown>,
      { get: (t, k: string) => (k in t ? t[k] : empty()) },
    ),
    events: { emit: (_name: string, sale: unknown) => emitted.push(sale), on: () => () => {} },
    config: { get: async () => undefined, set: async () => {} },
  } as Record<string, unknown>,
  { get: (t, k: string) => (k in t ? t[k] : empty()) },
) as unknown as Sdk;

const pin = (price = 30) => addLine({ productId: 'pin', sku: null, name: 'Pin', qty: 1, unitPrice: price });
const card = (amount: number) => addModuleLine({ key: 'gift-card:redeem:c1', name: 'Gift card ABCD', qty: 1, unitPrice: amount, settles: true, ref: { moduleId: 'gift-cards', kind: 'redeem', id: 'c1' } });

beforeEach(() => {
  setSdk(fake);
  clear();
  emitted.length = 0;
  setCartEvent({ id: 'shop', name: 'Shop', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 } as never, 'EUR');
});

describe('applySettlements', () => {
  it('uses each settling amount in order, never past the goods, and keeps zeros', () => {
    expect(applySettlements([0, 50, 0], 30)).toEqual([0, 30, 0]);
    expect(applySettlements([20, 20], 30)).toEqual([20, 10]);
    expect(applySettlements([20], 0)).toEqual([0]);
    expect(applySettlements([], 30)).toEqual([]);
  });
});

describe('a settling line in the cart', () => {
  it('comes off the total and is kept negative, but reads back as the amount it applies', () => {
    pin();
    card(10);
    expect(total.value).toBe(20);
    expect(baseTotal.value).toBe(20);
    expect(settledTotal.value).toBe(10);
    expect(cart.lines[1]).toMatchObject({ unitPrice: -10, lineTotal: -10, taxFree: true, settles: true, fixed: true });
    expect(findModuleLine('gift-card:redeem:c1')).toMatchObject({ unitPrice: 10 });
    expect(replaceModuleLine({ key: 'gift-card:redeem:c1', name: 'Gift card ABCD', qty: 1, unitPrice: 25 })).toBe(true);
    expect(cart.lines[1]!.unitPrice).toBe(-25);
    expect(total.value).toBe(5);
  });

  it('never takes the total below zero, and the discount is worked out on the goods alone', () => {
    pin();
    card(50);
    expect(total.value).toBe(0);
    expect(settledTotal.value).toBe(30);
    setCustomDiscount({ type: 'percent', value: 10, name: 'Friend' });
    // 10% of the 30 pin, not of 30 - 50.
    expect(cart.custom).not.toBeNull();
    expect(settledTotal.value).toBe(27);
    expect(total.value).toBe(0);
  });

  it('records what the card covered, VAT-free, and a sale covered in full still goes through', async () => {
    pin();
    card(50);
    const out = await checkout('s1', { method: 'prepaid' });
    expect(out.approved).toBe(true);
    const sale = out.sale!;
    expect(sale.total).toBe(0);
    expect(sale.lines.map((l) => l.lineTotal)).toEqual([30, -30]);
    expect(sale.lines[1]).toMatchObject({ unitPrice: -50, taxRate: null, ref: { moduleId: 'gift-cards', kind: 'redeem', id: 'c1' } });
    expect(sale.lines[1]).not.toHaveProperty('settles');
    expect(sale.asCharged?.listTotals).toEqual([30, -30]);
    expect(sale.payment.method).toBe('prepaid');
    expect(emitted).toHaveLength(1);
  });

  it('refuses a cart that only settles, and one that is empty', async () => {
    card(50);
    expect((await checkout('s2', { method: 'cash' })).approved).toBe(false);
    clear();
    expect((await checkout('s3', { method: 'cash' })).approved).toBe(false);
  });

  it('a part-covered sale charges the rest', async () => {
    pin(30);
    pin(30);
    card(45);
    expect(total.value).toBe(15);
    const out = await checkout('s4', { method: 'cash', cashReceived: 15 });
    expect(out.approved).toBe(true);
    expect(out.sale!.total).toBe(15);
    expect(out.sale!.lines.map((l) => l.lineTotal)).toEqual([60, -45]);
  });
});
