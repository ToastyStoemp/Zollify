import type { CustomsDeProduct, CustomsDeVariant } from './model';

export function esc(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML escape (also encodes apostrophes, unlike HTML `esc`). */
export function escapeXml(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** "12349 Berlin" -> { postCode: "12349", city: "Berlin" }. */
export function parsePostCodeCity(str: string): { postCode: string; city: string } {
  if (!str) return { postCode: '', city: '' };
  const match = str.match(/^(\S+)\s+(.+)$/);
  if (match) return { postCode: match[1] ?? '', city: match[2] ?? '' };
  return { postCode: '', city: str };
}

/** "Germany" / "DE" -> "DE". Falls back to the first two letters, uppercased. */
export function countryToCode(name: string | undefined): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  const known: Record<string, string> = {
    germany: 'DE',
    deutschland: 'DE',
    switzerland: 'CH',
    schweiz: 'CH',
  };
  const code = known[trimmed.toLowerCase()];
  if (code) return code;
  return trimmed.toUpperCase().slice(0, 2);
}

export function fmtWeightKg(kg: number): string {
  if (!kg) return '0 kg';
  return (Math.round(kg * 100) / 100).toFixed(2).replace('.', ',') + ' kg';
}

// ── Variant helpers (mirrors customs-ch/engine/calc.ts) ─────────────────────

export function hasVariants(p: CustomsDeProduct): boolean {
  return Array.isArray(p.variants) && p.variants.length > 0;
}

function variantPrice(p: CustomsDeProduct, v: CustomsDeVariant): number | null {
  const raw = v.price != null && v.price !== '' ? v.price : p.price;
  return raw != null && raw !== '' && !isNaN(parseFloat(String(raw))) ? parseFloat(String(raw)) : null;
}

function variantWeight(p: CustomsDeProduct, v: CustomsDeVariant): number {
  const raw = v.weightG != null && v.weightG !== '' ? v.weightG : p.weightG;
  return parseFloat(String(raw ?? '')) || 0;
}

export interface ProductCalc {
  totalWeightKg: number;
  totalValue: number | null;
  /** Same product/weight/value, one unit - blank on a mixed-price/weight variant set. */
  effectiveUnitPrice: number | null;
  effectiveUnitWeightG: number;
  amount: number;
  /** Not yet sold, so due back to Germany on re-import. */
  reimportQty: number;
  reimportWeightKg: number;
  reimportValue: number | null;
}

/** One line's own quantity, weight and value - a plain product's own fields, or a single variant's. */
function calcLine(amount: number, weightG: number, price: number | null): { totalWeightKg: number; totalValue: number | null } {
  return {
    totalWeightKg: Math.round(amount * weightG) / 1000,
    totalValue: price != null ? Math.round(price * amount) : null,
  };
}

export function calcDeProduct(p: CustomsDeProduct): ProductCalc {
  if (hasVariants(p)) {
    let amount = 0,
      totalWeightKg = 0,
      totalValue = 0,
      hasValue = false;
    let reimportQty = 0,
      reimportWeightKg = 0,
      reimportValue = 0,
      hasReimportValue = false;
    for (const v of p.variants!) {
      if (v.unlisted) continue;
      const vAmount = v.amount || 0;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      const line = calcLine(vAmount, wg, price);
      amount += vAmount;
      totalWeightKg += line.totalWeightKg;
      if (line.totalValue != null) {
        totalValue += line.totalValue;
        hasValue = true;
      }
      const vReimportQty = Math.max(0, vAmount - (v.soldQty || 0));
      const reimportLine = calcLine(vReimportQty, wg, price);
      reimportQty += vReimportQty;
      reimportWeightKg += reimportLine.totalWeightKg;
      if (reimportLine.totalValue != null) {
        reimportValue += reimportLine.totalValue;
        hasReimportValue = true;
      }
    }
    const listedVariants = p.variants!.filter((v) => !v.unlisted);
    const prices = listedVariants.map((v) => variantPrice(p, v)).filter((x): x is number => x != null);
    const weights = listedVariants.map((v) => variantWeight(p, v));
    const allSamePrice = prices.length > 0 && prices.every((x) => x === prices[0]);
    const allSameWeight = weights.length > 0 && weights.every((x) => x === weights[0]);
    return {
      totalWeightKg: Math.round(totalWeightKg * 1000) / 1000,
      totalValue: hasValue ? totalValue : null,
      effectiveUnitPrice: allSamePrice ? (prices[0] ?? null) : null,
      effectiveUnitWeightG: allSameWeight ? (weights[0] ?? 0) : 0,
      amount,
      reimportQty,
      reimportWeightKg: Math.round(reimportWeightKg * 1000) / 1000,
      reimportValue: hasReimportValue ? reimportValue : null,
    };
  }

  const weightG = parseFloat(String(p.weightG ?? '')) || 0;
  const price = p.price != null && p.price !== '' ? parseFloat(String(p.price)) : null;
  const { totalWeightKg, totalValue } = calcLine(p.amount, weightG, price);

  const reimportQty = Math.max(0, p.amount - p.soldQty);
  const { totalWeightKg: reimportWeightKg, totalValue: reimportValue } = calcLine(reimportQty, weightG, price);

  return { totalWeightKg, totalValue, effectiveUnitPrice: price, effectiveUnitWeightG: weightG, amount: p.amount, reimportQty, reimportWeightKg, reimportValue };
}
