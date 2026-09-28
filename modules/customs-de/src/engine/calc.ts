import {
  calcCoreProduct,
  calcCoreProductByMaterial,
  esc,
  escapeXml,
  parsePostCodeCity,
  countryToCode,
  fmtEventDates,
  floorN,
  formatNum,
  hasVariants,
  variantPrice,
  variantWeight,
} from '@zollify/customs-core';
import type { CustomsDeProduct } from './model';

export { esc, escapeXml, parsePostCodeCity, countryToCode, fmtEventDates, floorN, formatNum, hasVariants };

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
  /** Actually sold at the event - the definitive-export quantity, never coming back. */
  soldQty: number;
  soldWeightKg: number;
  /** What was actually charged (already net of any discount) - never re-derived from catalog price × qty, unlike totalValue/reimportValue. */
  soldValue: number;
}

/** One line's own quantity, weight and value - a plain product's own fields, or a single variant's. */
function calcLine(amount: number, weightG: number, price: number | null): { totalWeightKg: number; totalValue: number | null } {
  return {
    totalWeightKg: Math.round(amount * weightG) / 1000,
    totalValue: price != null ? Math.round(price * amount) : null,
  };
}

/**
 * amount/totalWeightKg/totalValue/effectiveUnitPrice/effectiveUnitWeightG and
 * the sold figures all come from calcCoreProduct() - this used to keep its
 * own copy of that whole aggregation (twice: here, and again in
 * calcDeProductByMaterial below), which is exactly how the sold-value figure
 * drifted (re-derived from catalog price × qty instead of reading soldValue).
 * reimportQty/reimportWeightKg/reimportValue are a DE-only concept (nothing
 * "comes back" for customs-ch), so that part is still computed here.
 */
export function calcDeProduct(p: CustomsDeProduct): ProductCalc {
  const core = calcCoreProduct(p);
  const shared = {
    totalWeightKg: core.totalWeightKg,
    totalValue: core.totalValue,
    effectiveUnitPrice: core.effectiveUnitPrice,
    effectiveUnitWeightG: Number(core.effectiveUnitWeightG) || 0,
    amount: core.amount,
    soldQty: core.soldQty,
    soldWeightKg: core.soldWeightKg,
    soldValue: core.soldValue,
  };

  if (hasVariants(p)) {
    let reimportQty = 0,
      reimportWeightKg = 0,
      reimportValue = 0,
      hasReimportValue = false;
    for (const v of p.variants!) {
      if (v.unlisted) continue;
      const vAmount = v.amount || 0;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      const vReimportQty = Math.max(0, vAmount - (v.soldQty || 0));
      const reimportLine = calcLine(vReimportQty, wg, price);
      reimportQty += vReimportQty;
      reimportWeightKg += reimportLine.totalWeightKg;
      if (reimportLine.totalValue != null) {
        reimportValue += reimportLine.totalValue;
        hasReimportValue = true;
      }
    }
    return { ...shared, reimportQty, reimportWeightKg: Math.round(reimportWeightKg * 1000) / 1000, reimportValue: hasReimportValue ? reimportValue : null };
  }

  const weightG = parseFloat(String(p.weightG ?? '')) || 0;
  const price = p.price != null && p.price !== '' ? parseFloat(String(p.price)) : null;
  const reimportQty = Math.max(0, p.amount - p.soldQty);
  const { totalWeightKg: reimportWeightKg, totalValue: reimportValue } = calcLine(reimportQty, weightG, price);

  return { ...shared, reimportQty, reimportWeightKg, reimportValue };
}

export interface DeMaterialGroupCalc {
  material: string;
  amount: number;
  totalWeightKg: number;
  totalValue: number | null;
  reimportQty: number;
  reimportWeightKg: number;
  reimportValue: number | null;
  soldQty: number;
  soldWeightKg: number;
  soldValue: number;
}

/**
 * calcCoreProductByMaterial(p) for material/amount/totalWeightKg/totalValue/
 * sold figures - same duplication-avoidance reasoning as calcDeProduct()
 * above. reimportQty/reimportWeightKg/reimportValue are DE-only, so they're
 * grouped by material separately here and merged in by the same material key
 * calcCoreProductByMaterial() itself derives, which is guaranteed to line up
 * since both use the identical `(v.material ?? p.material) || ''` + unlisted
 * filter.
 */
export function calcDeProductByMaterial(p: CustomsDeProduct): DeMaterialGroupCalc[] {
  const core = calcCoreProductByMaterial(p);

  if (!hasVariants(p)) {
    const { reimportQty, reimportWeightKg, reimportValue } = calcDeProduct(p);
    return [{ ...core[0]!, reimportQty, reimportWeightKg, reimportValue }];
  }

  const reimportByMaterial = new Map<string, { reimportQty: number; reimportWeightKg: number; reimportValue: number; hasReimportValue: boolean }>();
  for (const v of p.variants!) {
    if (v.unlisted) continue;
    const material = (v.material ?? p.material) || '';
    const vAmount = v.amount || 0;
    const wg = variantWeight(p, v);
    const price = variantPrice(p, v);
    const vReimportQty = Math.max(0, vAmount - (v.soldQty || 0));
    const reimportLine = calcLine(vReimportQty, wg, price);
    const r = reimportByMaterial.get(material) ?? { reimportQty: 0, reimportWeightKg: 0, reimportValue: 0, hasReimportValue: false };
    r.reimportQty += vReimportQty;
    r.reimportWeightKg += reimportLine.totalWeightKg;
    if (reimportLine.totalValue != null) {
      r.reimportValue += reimportLine.totalValue;
      r.hasReimportValue = true;
    }
    reimportByMaterial.set(material, r);
  }

  return core.map((group) => {
    const r = reimportByMaterial.get(group.material) ?? { reimportQty: 0, reimportWeightKg: 0, reimportValue: 0, hasReimportValue: false };
    return {
      ...group,
      reimportQty: r.reimportQty,
      reimportWeightKg: Math.round(r.reimportWeightKg * 1000) / 1000,
      reimportValue: r.hasReimportValue ? r.reimportValue : null,
    };
  });
}
