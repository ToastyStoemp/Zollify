import type { DiscountRule } from '@zollify/shared';
import { round2 } from '@zollify/shared';

/** A resolved cart line: variant lines carry vid, plain products vid=null. */
export interface CartLine {
  pid: string;
  vid: string | null;
  title: string;
  variantLabel: string | null;
  /** Product type (Product.type) - used by type-targeted discount rules. */
  type?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface RuleDiscountResult {
  rule: DiscountRule;
  amount: number;
}

export interface CustomDiscount {
  type: 'percent' | 'amount';
  value: number;
  name: string;
}

function ruleTargetsLine(rule: DiscountRule, line: CartLine): boolean {
  if (rule.productIds.includes(line.pid)) return true;
  if (line.vid && rule.variantIds.includes(`${line.pid}:${line.vid}`)) return true;
  if (line.type && rule.productTypes?.includes(line.type)) return true;
  return false;
}

/**
 * Combo/set bundle: every listed product/variant/type must have at least one
 * matching item in the cart. Scales by the minimum available count across all
 * members (2 purses + 3 wallets = 2 complete bundles, one wallet left over
 * unbundled), each worth comboDiscountAmount off. Needs >= 2 distinct members
 * - a single-item "bundle" isn't one.
 */
function computeComboDiscount(lines: CartLine[], rule: DiscountRule): number {
  if (!rule.comboDiscountAmount || rule.comboDiscountAmount <= 0) return 0;

  const memberQtyFor = (matches: (line: CartLine) => boolean): number =>
    lines.reduce((sum, l) => (l.qty && matches(l) ? sum + l.qty : sum), 0);

  const memberCounts: number[] = [
    ...rule.productIds.map((pid) => memberQtyFor((l) => l.pid === pid)),
    ...rule.variantIds.map((key) => {
      const idx = key.indexOf(':');
      const pid = key.slice(0, idx);
      const vid = key.slice(idx + 1);
      return memberQtyFor((l) => l.pid === pid && l.vid === vid);
    }),
    ...(rule.productTypes ?? []).map((type) => memberQtyFor((l) => l.type === type)),
  ];
  if (memberCounts.length < 2) return 0;

  const bundleCount = Math.min(...memberCounts);
  return bundleCount > 0 ? bundleCount * rule.comboDiscountAmount : 0;
}

/**
 * Port of pos.html calculateDiscounts(): for each rule, collect the unit price
 * of every matching item (expanded per quantity), sort cheapest-first, and
 * apply the rule's math:
 * - bxgy: floor(n / (buy+free)) * free cheapest items go free
 * - nth_pct: for every full group of nth items, the cheapest gets percent off
 *   (v2 change: legacy discounted the nth-cheapest, which for a cart of
 *   exactly n items was the most expensive one - inconsistent with bxgy)
 * - tiered: greedy largest-tier grouping; remainder at avg unit price, or at
 *   the best tier's unit price when tierContinue is set; needs >= 2 items
 *   (v2 change: tierContinue only prices the remainder once at least one full
 *   tier group is reached - legacy handed out the bundle unit price even when
 *   the customer never hit any tier)
 * - combo: not a pooled-items rule (see computeComboDiscount) - every listed
 *   member must be present at least once; flat amount off per complete set
 */
export function computeRuleDiscounts(lines: CartLine[], rules: DiscountRule[]): RuleDiscountResult[] {
  const results: RuleDiscountResult[] = [];
  for (const rule of rules) {
    if (rule.deletedAt) continue;
    if (!rule.productIds.length && !rule.variantIds.length && !rule.productTypes?.length) continue;

    if (rule.type === 'combo') {
      const amount = computeComboDiscount(lines, rule);
      if (amount > 0.001) results.push({ rule, amount });
      continue;
    }

    const items: number[] = [];
    for (const line of lines) {
      if (!line.qty || !ruleTargetsLine(rule, line)) continue;
      for (let i = 0; i < line.qty; i++) items.push(line.unitPrice || 0);
    }
    if (!items.length) continue;

    items.sort((a, b) => a - b);
    const totalQty = items.length;
    let amount = 0;

    if (rule.type === 'bxgy') {
      const groupSize = (rule.buyQty || 2) + (rule.freeQty || 1);
      const freeCount = Math.floor(totalQty / groupSize) * (rule.freeQty || 1);
      for (let i = 0; i < freeCount; i++) amount += items[i] || 0;
    } else if (rule.type === 'nth_pct') {
      const nth = rule.nth || 3;
      const pct = (rule.percent || 50) / 100;
      const discountCount = Math.floor(totalQty / nth);
      for (let i = 0; i < discountCount; i++) amount += (items[i] || 0) * pct;
    } else if (rule.type === 'tiered') {
      if (!rule.tiers || !rule.tiers.length) continue;
      if (totalQty < 2) continue;
      const normalTotal = items.reduce((s, v) => s + v, 0);
      const avgUnit = normalTotal / totalQty;
      const sortedTiers = [...rule.tiers].sort((a, b) => b.qty - a.qty);
      let remaining = totalQty;
      let tieredTotal = 0;
      let groupsFormed = 0;
      for (const tier of sortedTiers) {
        const groups = Math.floor(remaining / tier.qty);
        if (groups > 0) {
          tieredTotal += groups * tier.total;
          remaining -= groups * tier.qty;
          groupsFormed += groups;
        }
      }
      const maxTier = sortedTiers[0]!;
      // Continue-pricing only applies beyond a reached tier, never below it
      const remainderUnit = rule.tierContinue && groupsFormed > 0 ? maxTier.total / maxTier.qty : avgUnit;
      tieredTotal += remaining * remainderUnit;
      amount = normalTotal - tieredTotal;
    }

    if (amount > 0.001) results.push({ rule, amount });
  }
  return results;
}

/** Port of calculateCartDiscount(): custom discount applied after rule discounts. */
export function computeCustomDiscount(baseTotal: number, discount: CustomDiscount | null): number {
  if (!discount || !baseTotal) return 0;
  const value = discount.value || 0;
  if (value <= 0) return 0;
  if (discount.type === 'percent') {
    return Math.min(baseTotal, (baseTotal * Math.min(value, 100)) / 100);
  }
  return Math.min(baseTotal, value);
}

export interface CartTotals {
  subtotal: number;
  ruleDiscounts: RuleDiscountResult[];
  ruleDiscountTotal: number;
  customDiscountAmount: number;
  grandTotal: number;
}

/**
 * Port of cartGrandTotal(): subtotal − rule discounts − custom discount,
 * floored at 0. All amounts are rounded to cents here (v2 change: legacy kept
 * fractional-cent totals from tiered/percentage math and only rounded the
 * display, so the recorded total could differ from what was actually paid).
 */
export function computeCartTotals(
  lines: CartLine[],
  rules: DiscountRule[],
  custom: CustomDiscount | null,
): CartTotals {
  const subtotal = round2(lines.reduce((s, l) => s + (l.lineTotal || 0), 0));
  const ruleDiscounts = computeRuleDiscounts(lines, rules).map((r) => ({ ...r, amount: round2(r.amount) }));
  const ruleDiscountTotal = round2(ruleDiscounts.reduce((s, r) => s + r.amount, 0));
  const afterRules = round2(Math.max(0, subtotal - ruleDiscountTotal));
  const customDiscountAmount = round2(computeCustomDiscount(afterRules, custom));
  const grandTotal = round2(Math.max(0, afterRules - customDiscountAmount));
  return { subtotal, ruleDiscounts, ruleDiscountTotal, customDiscountAmount, grandTotal };
}

/**
 * Port of confirmPayment() step 3: scale line totals proportionally to the
 * actually-paid total; the last line absorbs cent-level rounding drift.
 * Mutates and returns the lines.
 */
export function distributeTotal<T extends { lineTotal: number }>(lines: T[], actualTotal: number): T[] {
  const subtotal = lines.reduce((s, l) => s + (l.lineTotal || 0), 0);
  if (subtotal > 0.001 && Math.abs(actualTotal - subtotal) > 0.001) {
    const ratio = actualTotal / subtotal;
    let distributed = 0;
    lines.forEach((line, i) => {
      if (i < lines.length - 1) {
        line.lineTotal = Math.round(line.lineTotal * ratio * 100) / 100;
        distributed += line.lineTotal;
      } else {
        line.lineTotal = Math.round((actualTotal - distributed) * 100) / 100;
      }
    });
  }
  return lines;
}
