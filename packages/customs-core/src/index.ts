/**
 * Shared calculation core for customs-ch and customs-de: the "how much
 * stock/weight/value does this product actually represent" math that was
 * duplicated per country and drifted apart twice in the same way -
 * customs-ch's 11.74/11.87 group totals summed non-declarable products
 * (fixed in 531dd83), then customs-de's proforma/e-dec/IAA-Plus filtered
 * eligibility on the raw, non-variant-aware amount field (fixed in a256bda).
 *
 * Scope is deliberately just this: amount/weight/value aggregation (both
 * brought-stock and actually-sold), and the basic eligibility primitive. Sold
 * value drifted a third time even after the fix above - customs-de kept its
 * own copy of the sold-figure aggregation loop and re-derived it from catalog
 * price x qty instead of reading soldValue, in two different places
 * (calcDeProduct and a packing-list.ts detailed-row loop) - so it's here now,
 * computed once, instead of once per country module. The actual documents
 * (CH's 11.74/11.87 HTML,
 * e-dec XML; DE's DEXPDF XML, IAA-Plus sheet, proforma HTML) stay separate
 * per-country templates - they're legally-fixed forms with genuinely
 * different fields, not duplicated logic.
 *
 * Everything here is written structurally (ProductLike/VariantLike, just the
 * fields actually used) rather than against either module's own
 * CustomsProduct/CustomsDeProduct type, so neither module's model.ts,
 * adapter, or any call site outside its own calc.ts needs to change.
 */
import { COUNTRY_CODES, type Transaction } from '@zollify/shared';

/** Numeric-ish: state sometimes stores a number as a string. */
export type NumLike = number | string | null | undefined;

// ── Formatting / escaping ────────────────────────────────────────────────────

export function esc(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML escape (also encodes apostrophes, unlike esc()). */
export function escapeXml(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * "Switzerland" / "CH" -> "CH". Backed by @zollify/shared's full COUNTRY_CODES
 * table (used everywhere else names/codes need to round-trip), not a
 * hand-rolled per-country list - customs-de previously kept its own 4-entry
 * stand-in (germany/deutschland/switzerland/schweiz) that fell back to "first
 * two letters uppercased" for anything else, which is wrong for most
 * countries (e.g. "Austria" -> "AU" instead of "AT").
 */
export function countryToCode(name: string | undefined): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  const code = COUNTRY_CODES[trimmed.toLowerCase()];
  if (code) return code;
  return trimmed.toUpperCase().slice(0, 2);
}

/** "12349 Berlin" -> { postCode: "12349", city: "Berlin" }. */
export function parsePostCodeCity(str: string): { postCode: string; city: string } {
  if (!str) return { postCode: '', city: '' };
  const match = str.match(/^(\S+)\s+(.+)$/);
  // The regex has two capture groups, so both are present whenever it matches;
  // the fallbacks satisfy noUncheckedIndexedAccess without changing behaviour.
  if (match) return { postCode: match[1] ?? '', city: match[2] ?? '' };
  return { postCode: '', city: str };
}

/** "2026-05-14", "2026-05-16" -> "14. - 16.05.2026". */
export function fmtEventDates(start: string, end: string): string {
  if (!start) return '';
  const s = new Date(start + 'T00:00:00');
  const d1 = s.getDate();
  const mm = String(s.getMonth() + 1).padStart(2, '0');
  const yyyy = s.getFullYear();
  if (!end) return `${d1}.${mm}.${yyyy}`;
  const e = new Date(end + 'T00:00:00');
  const d2 = e.getDate();
  return `${d1}. - ${d2}.${mm}.${yyyy}`;
}

// ── Variant helpers ──────────────────────────────────────────────────────────

export interface VariantLike {
  price?: NumLike;
  weightG?: NumLike;
  unlisted?: boolean;
  amount?: number;
  soldQty?: number;
  soldValue?: number;
  material?: string;
}

export interface ProductLike<V extends VariantLike = VariantLike> {
  material?: string;
  price?: NumLike;
  weightG?: NumLike;
  amount?: number;
  unlisted?: boolean;
  variants?: V[];
  soldQty?: number;
  soldValue?: number;
}

export function hasVariants(p: ProductLike): boolean {
  return Array.isArray(p.variants) && p.variants.length > 0;
}

export function variantPrice(p: ProductLike, v: VariantLike): number | null {
  const raw = v.price != null && v.price !== '' ? v.price : p.price;
  return raw != null && !isNaN(parseFloat(raw as string)) ? parseFloat(raw as string) : null;
}

export function variantWeight(p: ProductLike, v: VariantLike): number {
  const raw = v.weightG != null && v.weightG !== '' ? v.weightG : p.weightG;
  return parseFloat(String(raw ?? '')) || 0;
}

// ── Core amount/weight/value aggregation ─────────────────────────────────────

export interface CoreProductCalc {
  amount: number;
  totalWeightKg: number;
  totalValue: number | null;
  effectiveUnitPrice: number | null;
  effectiveUnitWeightG: NumLike;
  /** Actually sold - both country modules previously kept their own copy of
   *  this exact aggregation, and it drifted (customs-de/calc.ts recomputed
   *  catalog price × qty instead of reading soldValue, three separate times
   *  in three separate places, twice after the first fix). One place now. */
  soldQty: number;
  soldWeightKg: number;
  /** What was actually charged (already net of any discount) - always
   *  p.soldValue/v.soldValue directly, never re-derived from price × qty. */
  soldValue: number;
}

export interface CalcCoreOptions {
  /** Whole-product value override (customs-ch's totalValueCHF) - takes
   *  precedence over price*amount when set. Non-variant products only. */
  totalValueOverride?: number | null;
}

/**
 * The aggregation both calcProduct() (customs-ch) and calcDeProduct()
 * (customs-de) build on: sum variant amounts (or fall back to the flat
 * amount field when there are no variants), same rounding both ways. This is
 * the exact computation that drifted in the DE bug - DE's eligibility
 * filters read the flat field directly instead of this.
 *
 * A variant flagged unlisted is always excluded, unconditionally - same
 * meaning as the product-level flag (the product editor's own label calls it
 * "left off customs documents"). This is a deliberate business-rule choice,
 * not a legacy port: customs-ch's real, byte-tested legacy tool actually
 * includes unlisted-variant stock on its Proforma/Sold documents (confirmed
 * against the golden fixture), but the account explicitly asked for it
 * excluded everywhere for consistency, accepting that customs-ch's port now
 * diverges from that historical behavior for this one case. DE's
 * calcDeProduct already excluded it unconditionally before this - CH is the
 * one that changed to match.
 */
export function calcCoreProduct(p: ProductLike, opts: CalcCoreOptions = {}): CoreProductCalc {
  const { totalValueOverride = null } = opts;

  if (hasVariants(p)) {
    let amount = 0,
      totalWeightKg = 0,
      totalValue = 0;
    let soldQty = 0,
      soldWeightKg = 0,
      soldValue = 0;
    for (const v of p.variants!) {
      if (v.unlisted) continue;
      const amt = v.amount || 0;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      amount += amt;
      totalWeightKg += Math.round(amt * wg) / 1000;
      if (price != null) totalValue += price * amt;

      const vSoldQty = v.soldQty || 0;
      soldQty += vSoldQty;
      soldWeightKg += Math.round(vSoldQty * wg) / 1000;
      soldValue += v.soldValue || 0;
    }
    soldWeightKg = Math.round(soldWeightKg * 1000) / 1000;
    totalWeightKg = Math.round(totalWeightKg * 1000) / 1000;
    const activeVariants = p.variants!.filter((v) => !v.unlisted);
    const prices = activeVariants.map((v) => variantPrice(p, v)).filter((x): x is number => x != null);
    const weights = activeVariants.map((v) => variantWeight(p, v));
    const allSamePrice = prices.length > 0 && prices.every((x) => x === prices[0]);
    const allSameWeight = weights.length > 0 && weights.every((x) => x === weights[0]);
    const effectiveUnitPrice = allSamePrice
      ? (prices[0] ?? null)
      : amount > 0 && totalValue > 0
        ? totalValue / amount
        : null;
    const effectiveUnitWeightG = allSameWeight
      ? weights[0]
      : amount > 0
        ? Math.round((totalWeightKg * 1000) / amount)
        : p.weightG || 0;
    return {
      amount,
      totalWeightKg,
      totalValue: totalValue > 0 ? Math.round(totalValue) : null,
      effectiveUnitPrice,
      effectiveUnitWeightG,
      soldQty,
      soldWeightKg,
      soldValue,
    };
  }

  const amount = p.amount || 0;
  const weightG = parseFloat(String(p.weightG ?? '')) || 0;
  const totalWeightKg = Math.round(amount * weightG) / 1000;
  let totalValue = totalValueOverride != null ? Math.round(totalValueOverride) : null;
  if (totalValue == null && p.price != null && p.price !== '') {
    totalValue = Math.round(parseFloat(p.price as string) * amount);
  }
  const effectiveUnitPrice = totalValue != null && amount > 0 ? totalValue / amount : null;
  const effectiveUnitWeightG = amount > 0 ? (totalWeightKg * 1000) / amount : p.weightG || 0;

  const soldQty = p.soldQty || 0;
  const soldWeightKg = Math.round(soldQty * weightG) / 1000;
  const soldValue = p.soldValue || 0;

  return { amount, totalWeightKg, totalValue, effectiveUnitPrice, effectiveUnitWeightG, soldQty, soldWeightKg, soldValue };
}

export interface CoreMaterialGroupCalc {
  material: string;
  amount: number;
  totalWeightKg: number;
  totalValue: number | null;
  soldQty: number;
  soldWeightKg: number;
  soldValue: number;
}

/**
 * calcCoreProduct(p), split by each variant's own resolved material - a
 * by-type document groups by material and can't tell two differently-
 * overridden variants of the same product apart otherwise. A product with no
 * variants, or whose variants all resolve to the same material, returns a
 * single entry with numbers identical to calcCoreProduct(p). Also previously
 * duplicated per country module (customs-ch's calcProductByMaterial,
 * customs-de's calcDeProductByMaterial) - same aggregation, one place now.
 */
export function calcCoreProductByMaterial(p: ProductLike, opts: CalcCoreOptions = {}): CoreMaterialGroupCalc[] {
  if (!hasVariants(p)) {
    const c = calcCoreProduct(p, opts);
    return [{ material: p.material || '', amount: c.amount, totalWeightKg: c.totalWeightKg, totalValue: c.totalValue, soldQty: c.soldQty, soldWeightKg: c.soldWeightKg, soldValue: c.soldValue }];
  }
  const byMaterial = new Map<string, VariantLike[]>();
  for (const v of p.variants!) {
    if (v.unlisted) continue;
    const material = (v.material ?? p.material) || '';
    (byMaterial.get(material) ?? byMaterial.set(material, []).get(material)!).push(v);
  }
  return [...byMaterial.entries()].map(([material, variants]) => {
    let amount = 0,
      totalWeightKg = 0,
      totalValue = 0,
      soldQty = 0,
      soldWeightKg = 0,
      soldValue = 0;
    for (const v of variants) {
      const amt = v.amount || 0;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      amount += amt;
      totalWeightKg += Math.round(amt * wg) / 1000;
      if (price != null) totalValue += price * amt;

      const vSoldQty = v.soldQty || 0;
      soldQty += vSoldQty;
      soldWeightKg += Math.round(vSoldQty * wg) / 1000;
      soldValue += v.soldValue || 0;
    }
    return {
      material,
      amount,
      totalWeightKg: Math.round(totalWeightKg * 1000) / 1000,
      totalValue: totalValue > 0 ? Math.round(totalValue) : null,
      soldQty,
      soldWeightKg: Math.round(soldWeightKg * 1000) / 1000,
      soldValue,
    };
  });
}

/**
 * The eligibility primitive both bugs were actually about: a product counts
 * toward a customs document only if it isn't flagged unlisted and actually
 * has stock, computed the same way calcCoreProduct() computes it - never a
 * raw, non-variant-aware amount field. customs-de's proforma/e-dec/IAA-Plus
 * filters were exactly this, minus the computed half.
 */
export function hasStock(p: ProductLike): boolean {
  return !p.unlisted && calcCoreProduct(p).amount > 0;
}

/**
 * A transaction-level discount (a bundle price, a custom reduction) is
 * attached to the whole sale, not to any one line item, so it can't be
 * subtracted from a single product's declared value directly. Spreads it
 * across every line proportionally to that line's own share of the
 * pre-discount subtotal - the natural way to split a whole-sale reduction.
 *
 * Returns a fraction (0-1), not a currency amount, so it's safe to apply to
 * a line value in either the charge currency or the base currency - both
 * customs-ch (declares in the event's local/charge currency) and customs-de
 * (declares in the account's base currency) can multiply their own line
 * value by `1 - discountFraction(tx)` without any currency conversion.
 */
export function discountFraction(tx: Transaction): number {
  const subtotal = tx.items.reduce((s, i) => s + i.lineTotal, 0);
  if (subtotal <= 0) return 0;
  const totalDiscount = tx.discounts.reduce((s, d) => s + d.amount, 0);
  return Math.min(1, Math.max(0, totalDiscount / subtotal));
}
