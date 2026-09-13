import { describe, expect, it } from 'vitest';
import type { DiscountRule } from '@zollify/shared';
import {
  computeCartTotals,
  computeCustomDiscount,
  computeRuleDiscounts,
  distributeTotal,
  type CartLine,
} from '../discounts';

// Golden values hand-computed from the legacy pos.html calculateDiscounts()
// implementation. Two deliberate v2 changes are pinned here instead of legacy:
// nth_pct discounts the cheapest item per full group (legacy hit the priciest),
// and tierContinue never prices items below the first reached tier.

function line(pid: string, vid: string | null, qty: number, unitPrice: number): CartLine {
  return {
    pid,
    vid,
    title: pid,
    variantLabel: vid,
    qty,
    unitPrice,
    lineTotal: unitPrice * qty,
  };
}

function rule(partial: Partial<DiscountRule>): DiscountRule {
  return {
    id: 'r1',
    name: 'Rule',
    type: 'bxgy',
    productIds: [],
    variantIds: [],
    updatedAt: 0,
    ...partial,
  };
}

describe('computeRuleDiscounts', () => {
  it('bxgy: buy 2 get 1 — cheapest item of each full group goes free', () => {
    // 5 matching items priced [5,10,10,10,12] → group size 3, 1 full group → 1 free = cheapest (5)
    const lines = [line('a', null, 1, 5), line('a2', null, 3, 10), line('a3', null, 1, 12)];
    const r = rule({ type: 'bxgy', buyQty: 2, freeQty: 1, productIds: ['a', 'a2', 'a3'] });
    const res = computeRuleDiscounts(lines, [r]);
    expect(res).toHaveLength(1);
    expect(res[0]!.amount).toBe(5);
  });

  it('productTypes: rule targets every line of the type, ignoring others', () => {
    const lines = [
      { ...line('a', null, 2, 10), type: 'Print' },
      { ...line('b', null, 1, 8), type: 'Print' },
      { ...line('c', null, 3, 5), type: 'Sticker' },
    ];
    // Buy 2 get 1 on Prints only: items [8,10,10] → 1 group → cheapest (8) free
    const r = rule({ type: 'bxgy', buyQty: 2, freeQty: 1, productTypes: ['Print'] });
    const res = computeRuleDiscounts(lines, [r]);
    expect(res).toHaveLength(1);
    expect(res[0]!.amount).toBe(8);
  });

  it('productTypes: combines with explicit product targets without double counting', () => {
    const lines = [
      { ...line('a', null, 1, 10), type: 'Print' },
      { ...line('b', null, 1, 6), type: 'Sticker' },
      { ...line('c', null, 1, 12), type: 'Print' },
    ];
    // Type Print + product b → all three items [6,10,12] → 1 group → 6 free
    const r = rule({ type: 'bxgy', buyQty: 2, freeQty: 1, productTypes: ['Print'], productIds: ['b'] });
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBe(6);
  });

  it('bxgy: two full groups discount the two cheapest items', () => {
    // 6 items [5,6,10,10,10,12] → 2 groups → 2 free = 5 + 6
    const lines = [
      line('a', null, 1, 5),
      line('b', null, 1, 6),
      line('c', null, 3, 10),
      line('d', null, 1, 12),
    ];
    const r = rule({ type: 'bxgy', buyQty: 2, freeQty: 1, productIds: ['a', 'b', 'c', 'd'] });
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBe(11);
  });

  it('nth_pct: one full group of 3 → cheapest item gets 50% off', () => {
    // sorted [4,6,8,10] → floor(4/3)=1 group → cheapest (4) at 50% → 2
    const lines = [line('a', null, 1, 4), line('b', null, 1, 6), line('c', null, 1, 8), line('d', null, 1, 10)];
    const r = rule({ type: 'nth_pct', nth: 3, percent: 50, productIds: ['a', 'b', 'c', 'd'] });
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBe(2);
  });

  it('nth_pct: two full groups discount the two cheapest items', () => {
    // sorted [4,6,8,10,12,14] → floor(6/3)=2 → (4+6) at 50% → 5
    const lines = [
      line('a', null, 1, 4),
      line('b', null, 1, 6),
      line('c', null, 1, 8),
      line('d', null, 1, 10),
      line('e', null, 1, 12),
      line('f', null, 1, 14),
    ];
    const r = rule({
      type: 'nth_pct',
      nth: 3,
      percent: 50,
      productIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBe(5);
  });

  it('nth_pct: below a full group there is no discount', () => {
    const lines = [line('a', null, 1, 4), line('b', null, 1, 6)];
    const r = rule({ type: 'nth_pct', nth: 3, percent: 50, productIds: ['a', 'b'] });
    expect(computeRuleDiscounts(lines, [r])).toHaveLength(0);
  });

  it('tiered: greedy tier grouping, remainder at average unit price', () => {
    // 5×10 with tier "3 for 25": tiered = 25 + 2×10 = 45 → discount 5
    const lines = [line('a', null, 5, 10)];
    const r = rule({ type: 'tiered', tiers: [{ qty: 3, total: 25 }], productIds: ['a'] });
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBeCloseTo(5, 10);
  });

  it('tiered with tierContinue: remainder priced at best-tier unit price', () => {
    // 5×10, tier "3 for 25", continue: tiered = 25 + 2×(25/3) → discount = 50 − 41.666… = 8.333…
    const lines = [line('a', null, 5, 10)];
    const r = rule({
      type: 'tiered',
      tiers: [{ qty: 3, total: 25 }],
      tierContinue: true,
      productIds: ['a'],
    });
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBeCloseTo(50 - (25 + (2 * 25) / 3), 10);
  });

  it('tiered: needs at least 2 matching items', () => {
    const lines = [line('a', null, 1, 10)];
    const r = rule({ type: 'tiered', tiers: [{ qty: 3, total: 25 }], productIds: ['a'] });
    expect(computeRuleDiscounts(lines, [r])).toHaveLength(0);
  });

  it('tiered with tierContinue: 4 € items, "3 for 10", buying 4 → 4 × (10/3)', () => {
    const lines = [line('a', null, 4, 4)];
    const r = rule({ type: 'tiered', tiers: [{ qty: 3, total: 10 }], tierContinue: true, productIds: ['a'] });
    // normal 16, tiered = 10 + 1×(10/3) = 13.333… → discount 2.666…
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBeCloseTo(16 - (10 + 10 / 3), 10);
  });

  it('tiered with tierContinue: no bundle pricing below the first tier', () => {
    // 2 items never reach "3 for 25" — legacy wrongly priced them at 25/3 each
    const lines = [line('a', null, 2, 10)];
    const r = rule({ type: 'tiered', tiers: [{ qty: 3, total: 25 }], tierContinue: true, productIds: ['a'] });
    expect(computeRuleDiscounts(lines, [r])).toHaveLength(0);
  });

  it('matches variant lines via productIds and specific variantIds without double counting', () => {
    const lines = [line('p', 'v1', 2, 10), line('p', 'v2', 1, 8)];
    // Rule targets the whole product AND one variant explicitly — items must not be duplicated.
    const r = rule({ type: 'bxgy', buyQty: 2, freeQty: 1, productIds: ['p'], variantIds: ['p:v1'] });
    // 3 items [8,10,10] → 1 group → cheapest free = 8
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBe(8);
  });

  it('ignores rules with no matching cart items and deleted rules', () => {
    const lines = [line('a', null, 1, 10)];
    const r1 = rule({ id: 'x', productIds: ['other'] });
    const r2 = rule({ id: 'y', productIds: ['a'], deletedAt: 123, buyQty: 1, freeQty: 1 });
    expect(computeRuleDiscounts(lines, [r1, r2])).toHaveLength(0);
  });

  it('combo: scales by the minimum count across all required members', () => {
    // 2 purses + 3 wallets = 2 complete bundles, one wallet left over unbundled
    const lines = [line('purse', null, 2, 40), line('wallet', null, 3, 25)];
    const r = rule({ type: 'combo', productIds: ['purse', 'wallet'], comboDiscountAmount: 10 });
    const res = computeRuleDiscounts(lines, [r]);
    expect(res).toHaveLength(1);
    expect(res[0]!.amount).toBe(20);
  });

  it('combo: does not trigger unless every member has at least one', () => {
    const lines = [line('purse', null, 3, 40)]; // no wallets at all
    const r = rule({ type: 'combo', productIds: ['purse', 'wallet'], comboDiscountAmount: 10 });
    expect(computeRuleDiscounts(lines, [r])).toHaveLength(0);
  });

  it('combo: matches specific variants and product types as members too', () => {
    const lines = [
      { ...line('purse', 'red', 1, 40), type: 'Bags' },
      { ...line('hat', null, 1, 20), type: 'Hats' },
    ];
    const r = rule({
      type: 'combo',
      productIds: [],
      variantIds: ['purse:red'],
      productTypes: ['Hats'],
      comboDiscountAmount: 5,
    });
    expect(computeRuleDiscounts(lines, [r])[0]!.amount).toBe(5);
  });

  it('combo: a single member never triggers (needs >= 2 distinct members)', () => {
    const lines = [line('purse', null, 5, 40)];
    const r = rule({ type: 'combo', productIds: ['purse'], comboDiscountAmount: 10 });
    expect(computeRuleDiscounts(lines, [r])).toHaveLength(0);
  });
});

describe('computeCustomDiscount', () => {
  it('percent discount caps at 100%', () => {
    expect(computeCustomDiscount(80, { type: 'percent', value: 150, name: '' })).toBe(80);
    expect(computeCustomDiscount(80, { type: 'percent', value: 25, name: '' })).toBe(20);
  });

  it('amount discount caps at the base total', () => {
    expect(computeCustomDiscount(15, { type: 'amount', value: 20, name: '' })).toBe(15);
    expect(computeCustomDiscount(50, { type: 'amount', value: 5, name: '' })).toBe(5);
  });
});

describe('computeCartTotals', () => {
  it('applies custom discount after rule discounts', () => {
    // subtotal 100, bxgy(buy1 get1) on 2×50 → 50 off → 50; then 10% custom → 45
    const lines = [line('a', null, 2, 50)];
    const r = rule({ type: 'bxgy', buyQty: 1, freeQty: 1, productIds: ['a'] });
    const t = computeCartTotals(lines, [r], { type: 'percent', value: 10, name: '' });
    expect(t.subtotal).toBe(100);
    expect(t.ruleDiscountTotal).toBe(50);
    expect(t.customDiscountAmount).toBe(5);
    expect(t.grandTotal).toBe(45);
  });

  it('rounds fractional-cent discounts so the total matches what is charged', () => {
    // 5×10 with "3 for 25" + continue: raw discount 8.333… → recorded 8.33, total 41.67
    const lines = [line('a', null, 5, 10)];
    const r = rule({ type: 'tiered', tiers: [{ qty: 3, total: 25 }], tierContinue: true, productIds: ['a'] });
    const t = computeCartTotals(lines, [r], null);
    expect(t.ruleDiscounts[0]!.amount).toBe(8.33);
    expect(t.ruleDiscountTotal).toBe(8.33);
    expect(t.grandTotal).toBe(41.67);
    expect(Number.isInteger(Math.round(t.grandTotal * 100))).toBe(true);
  });
});

describe('distributeTotal', () => {
  it('scales proportionally, last line absorbs rounding', () => {
    const lines = [{ lineTotal: 30 }, { lineTotal: 20 }];
    distributeTotal(lines, 45);
    expect(lines[0]!.lineTotal).toBe(27);
    expect(lines[1]!.lineTotal).toBe(18);
    expect(lines[0]!.lineTotal + lines[1]!.lineTotal).toBe(45);
  });

  it('cent-rounding drift lands on the last line', () => {
    // 3×10 → 20: ratio 0.666…, first two round to 6.67, last = 20 − 13.34 = 6.66
    const lines = [{ lineTotal: 10 }, { lineTotal: 10 }, { lineTotal: 10 }];
    distributeTotal(lines, 20);
    expect(lines[0]!.lineTotal).toBe(6.67);
    expect(lines[1]!.lineTotal).toBe(6.67);
    expect(lines[2]!.lineTotal).toBe(6.66);
  });

  it('leaves totals untouched when nothing changed', () => {
    const lines = [{ lineTotal: 12.5 }, { lineTotal: 7.5 }];
    distributeTotal(lines, 20);
    expect(lines[0]!.lineTotal).toBe(12.5);
    expect(lines[1]!.lineTotal).toBe(7.5);
  });
});
