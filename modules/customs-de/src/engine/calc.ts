import { esc, escapeXml, parsePostCodeCity, countryToCode, fmtEventDates, hasVariants, variantPrice, variantWeight } from '@zollify/customs-core';
import type { CustomsDeProduct, CustomsDeVariant } from './model';

export { esc, escapeXml, parsePostCodeCity, countryToCode, fmtEventDates, hasVariants };

// calcDeProduct's own eligibility (`!p.unlisted && calcDeProduct(p).amount > 0`,
// used by proforma.ts/iaa-plus-sheet.ts/dexpdf-xml.ts) is NOT customs-core's
// hasStock(): calcDeProduct always excludes unlisted variants from the sum,
// while hasStock()'s default does not - the two only agree when a product has
// no unlisted variants. Left as its own check rather than swapping in a
// shared primitive that would silently change behavior for that case.

export function fmtWeightKg(kg: number): string {
  if (!kg) return '0 kg';
  return (Math.round(kg * 100) / 100).toFixed(2).replace('.', ',') + ' kg';
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

export interface DeMaterialGroupCalc {
  material: string;
  amount: number;
  totalWeightKg: number;
  totalValue: number | null;
  reimportQty: number;
  reimportWeightKg: number;
  reimportValue: number | null;
}

/**
 * calcDeProduct(p), split by each variant's own resolved material (mirrors
 * customs-ch/engine/calc.ts's calcProductByMaterial() - same formulas, same
 * rounding). The by-type packing list groups by material and can't tell two
 * differently-overridden variants of the same product apart otherwise.
 */
export function calcDeProductByMaterial(p: CustomsDeProduct): DeMaterialGroupCalc[] {
  if (!hasVariants(p)) {
    const c = calcDeProduct(p);
    return [{ material: p.material || '', amount: c.amount, totalWeightKg: c.totalWeightKg, totalValue: c.totalValue, reimportQty: c.reimportQty, reimportWeightKg: c.reimportWeightKg, reimportValue: c.reimportValue }];
  }
  const byMaterial = new Map<string, CustomsDeVariant[]>();
  for (const v of p.variants!) {
    if (v.unlisted) continue;
    const material = (v.material ?? p.material) || '';
    (byMaterial.get(material) ?? byMaterial.set(material, []).get(material)!).push(v);
  }
  return [...byMaterial.entries()].map(([material, variants]) => {
    let amount = 0,
      totalWeightKg = 0,
      totalValue = 0,
      hasValue = false,
      reimportQty = 0,
      reimportWeightKg = 0,
      reimportValue = 0,
      hasReimportValue = false;
    for (const v of variants) {
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
    return {
      material,
      amount,
      totalWeightKg: Math.round(totalWeightKg * 1000) / 1000,
      totalValue: hasValue ? totalValue : null,
      reimportQty,
      reimportWeightKg: Math.round(reimportWeightKg * 1000) / 1000,
      reimportValue: hasReimportValue ? reimportValue : null,
    };
  });
}
