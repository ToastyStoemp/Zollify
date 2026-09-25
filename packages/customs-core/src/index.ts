/**
 * Shared calculation core for customs-ch and customs-de: the "how much
 * stock/weight/value does this product actually represent" math that was
 * duplicated per country and drifted apart twice in the same way -
 * customs-ch's 11.74/11.87 group totals summed non-declarable products
 * (fixed in 531dd83), then customs-de's proforma/e-dec/IAA-Plus filtered
 * eligibility on the raw, non-variant-aware amount field (fixed in a256bda).
 *
 * Scope is deliberately just this: amount/weight/value aggregation and the
 * basic eligibility primitive. The actual documents (CH's 11.74/11.87 HTML,
 * e-dec XML; DE's DEXPDF XML, IAA-Plus sheet, proforma HTML) stay separate
 * per-country templates - they're legally-fixed forms with genuinely
 * different fields, not duplicated logic.
 *
 * Everything here is written structurally (ProductLike/VariantLike, just the
 * fields actually used) rather than against either module's own
 * CustomsProduct/CustomsDeProduct type, so neither module's model.ts,
 * adapter, or any call site outside its own calc.ts needs to change.
 */
import { COUNTRY_CODES } from '@zollify/shared';

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
}

export interface ProductLike<V extends VariantLike = VariantLike> {
  price?: NumLike;
  weightG?: NumLike;
  amount?: number;
  unlisted?: boolean;
  variants?: V[];
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
}

export interface CalcCoreOptions {
  skipUnlistedVariants?: boolean;
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
 */
export function calcCoreProduct(p: ProductLike, opts: CalcCoreOptions = {}): CoreProductCalc {
  const { skipUnlistedVariants = false, totalValueOverride = null } = opts;

  if (hasVariants(p)) {
    let amount = 0,
      totalWeightKg = 0,
      totalValue = 0;
    for (const v of p.variants!) {
      if (skipUnlistedVariants && v.unlisted) continue;
      const amt = v.amount || 0;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      amount += amt;
      totalWeightKg += Math.round(amt * wg) / 1000;
      if (price != null) totalValue += price * amt;
    }
    totalWeightKg = Math.round(totalWeightKg * 1000) / 1000;
    const activeVariants = skipUnlistedVariants ? p.variants!.filter((v) => !v.unlisted) : p.variants!;
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
  return { amount, totalWeightKg, totalValue, effectiveUnitPrice, effectiveUnitWeightG };
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
