/**
 * Customs calculation core - exact port of the legacy www/app.js functions.
 * Do not "improve" rounding or formatting here: outputs are golden-tested
 * byte-for-byte against the legacy generators.
 *
 * The generic pieces (escaping, country codes, variant amount/weight/value
 * aggregation, the stock-eligibility primitive) live in @zollify/customs-core,
 * shared with customs-de - see that package's own doc comment for why. What's
 * left here is genuinely CH-specific: tariff/VAT-law math, e-dec, and
 * customs-ch's own return-stats and 11.74/11.87 grouping.
 */
import {
  calcCoreProduct,
  esc,
  escapeXml,
  countryToCode,
  parsePostCodeCity,
  fmtEventDates,
  hasVariants,
  variantPrice,
  variantWeight,
} from '@zollify/customs-core';
import { HS_CODES } from './data';
import type { CustomsProduct, CustomsState, CustomsVariant, NumLike } from './model';

export { esc, escapeXml, countryToCode, parsePostCodeCity, fmtEventDates, hasVariants, variantPrice, variantWeight };

export function formatNum(n: NumLike, decimals: number): string {
  return parseFloat(n as string).toFixed(decimals);
}

export function floorN(value: NumLike, decimals: number): number {
  if (value == null || isNaN(value as number)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.floor(parseFloat(value as string) * factor) / factor;
}

export function fmtWeightKg(kg: NumLike): string {
  if (kg == null || isNaN(kg as number) || kg === 0) return '0 kg';
  return formatNum(kg, 2).replace('.', ',') + ' kg';
}

// ── Country / code helpers ──────────────────────────────────────────────────

/** "4911.91.00" → "4911.9100" */
export function toEdecHsCode(code: string | undefined): string {
  if (!code) return '';
  return code.replace(/^(\d{4})\.(\d{2})\.(\d{2})$/, '$1.$2$3');
}

export function getPermitObligation(tariffNo: string | undefined): number {
  if (!tariffNo) return 0;
  const hsEntry = HS_CODES.find((h) => h.code === tariffNo);
  if (hsEntry) return hsEntry.permit || 0;
  if (tariffNo.startsWith('7117')) return 2;
  return 0;
}

export function getVatCode(vatRate: NumLike): number {
  if (vatRate != null && parseFloat(vatRate as string) <= 2.7) return 2;
  return 1;
}

export function computeLRP(state: CustomsState, docNum: number): string {
  const originCC = countryToCode(state.artist.countryOfOrigin) || 'XX';
  const code = (state.meta.companyCode || '').toUpperCase() || 'XX';
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  if (state.meta.eventDateStart) {
    const d = new Date(state.meta.eventDateStart + 'T00:00:00');
    year = d.getFullYear();
    month = d.getMonth() + 1;
  }
  const mm = String(month).padStart(2, '0');
  const nnn = String(docNum).padStart(3, '0');
  return `${originCC}CH_${code}_${year}_${mm}_${nnn}`;
}

// ── Product calculations ────────────────────────────────────────────────────

export interface ProductCalc {
  totalWeightKg: number;
  totalValue: number | null;
  effectiveUnitPrice: number | null;
  effectiveUnitWeightG: NumLike;
  soldWeightKg: number;
  amount: number;
  soldQty: number;
  soldValue: number;
}

/**
 * A variant flagged unlisted is always excluded - same meaning as the
 * product-level flag (the product editor's own label calls it "left off
 * customs documents"). Deliberate business-rule choice, not a legacy port:
 * the real, byte-tested legacy tool actually includes unlisted-variant
 * stock on Proforma/Sold, but the account explicitly asked for it excluded
 * everywhere for consistency across documents, accepting that this
 * function's output now diverges from that historical behavior for this
 * one case (see golden-legacy.test.ts's fixture note).
 */
export function calcProduct(p: CustomsProduct): ProductCalc {
  // totalValueCHF is CH-specific (a whole-product value override) - not a
  // customs-core concept, so it's resolved here and handed in as an option
  // rather than pushed into the shared aggregation.
  const core = calcCoreProduct(p, {
    totalValueOverride: p.totalValueCHF != null ? parseFloat(p.totalValueCHF as string) : null,
  });

  if (hasVariants(p)) {
    let soldQty = 0,
      soldValue = 0,
      soldWeightKg = 0;
    for (const v of p.variants!) {
      if (v.unlisted) continue;
      const wg = variantWeight(p, v);
      soldQty += v.soldQty || 0;
      soldValue += v.soldValue || 0;
      soldWeightKg += ((v.soldQty || 0) * wg) / 1000;
    }
    return { ...core, soldQty, soldValue, soldWeightKg };
  }

  const soldWeightKg = ((p.soldQty || 0) * ((p.weightG as number) || 0)) / 1000;
  return { ...core, soldWeightKg, soldQty: p.soldQty || 0, soldValue: p.soldValue || 0 };
}

export interface MaterialGroupCalc {
  material: string;
  amount: number;
  totalWeightKg: number;
  totalValue: number | null;
  soldQty: number;
  soldValue: number;
  soldWeightKg: number;
}

/**
 * calcProduct(p), split by each variant's own resolved material - the by-type
 * documents group by material and can't tell two differently-overridden
 * variants of the same product apart otherwise. A product with no variants,
 * or whose variants all resolve to the same material, returns a single entry
 * with numbers identical to calcProduct(p) (same formulas, same rounding,
 * same unlisted-variant exclusion).
 */
export function calcProductByMaterial(p: CustomsProduct): MaterialGroupCalc[] {
  if (!hasVariants(p)) {
    const c = calcProduct(p);
    return [{ material: p.material || '', amount: c.amount, totalWeightKg: c.totalWeightKg, totalValue: c.totalValue, soldQty: c.soldQty, soldValue: c.soldValue, soldWeightKg: c.soldWeightKg }];
  }
  const byMaterial = new Map<string, CustomsVariant[]>();
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
      soldValue = 0,
      soldWeightKg = 0;
    for (const v of variants) {
      const amt = v.amount || 0;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      amount += amt;
      totalWeightKg += Math.round(amt * wg) / 1000;
      if (price != null) totalValue += price * amt;
      soldQty += v.soldQty || 0;
      soldValue += v.soldValue || 0;
      soldWeightKg += ((v.soldQty || 0) * wg) / 1000;
    }
    return {
      material,
      amount,
      totalWeightKg: Math.round(totalWeightKg * 1000) / 1000,
      totalValue: totalValue > 0 ? Math.round(totalValue) : null,
      soldQty,
      soldValue,
      soldWeightKg,
    };
  });
}

export interface ReturnMaterialGroupCalc {
  material: string;
  retQty: number;
  retWkg: number;
  retVal: number | null;
}

/** calcReturnStats(p), split by each variant's own resolved material - see calcProductByMaterial(). */
export function calcReturnStatsByMaterial(p: CustomsProduct): ReturnMaterialGroupCalc[] {
  if (!hasVariants(p)) {
    const r = calcReturnStats(p);
    return r.retQty > 0 ? [{ material: p.material || '', ...r }] : [];
  }
  const byMaterial = new Map<string, CustomsVariant[]>();
  for (const v of p.variants!) {
    if (v.unlisted) continue;
    const material = (v.material ?? p.material) || '';
    (byMaterial.get(material) ?? byMaterial.set(material, []).get(material)!).push(v);
  }
  const result: ReturnMaterialGroupCalc[] = [];
  for (const [material, variants] of byMaterial) {
    let retQty = 0,
      retWkg = 0,
      retVal = 0,
      hasVal = false;
    for (const v of variants) {
      const vRet = (v.amount || 0) - (v.soldQty || 0);
      if (vRet <= 0) continue;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      retQty += vRet;
      retWkg += Math.round(vRet * wg) / 1000;
      if (price != null) {
        retVal += Math.round(price * vRet);
        hasVal = true;
      }
    }
    if (retQty > 0) result.push({ material, retQty, retWkg: Math.round(retWkg * 1000) / 1000, retVal: hasVal ? retVal : null });
  }
  return result;
}

export function calcReturnStats(p: CustomsProduct): { retQty: number; retWkg: number; retVal: number | null } {
  if (hasVariants(p)) {
    let retQty = 0,
      retWkg = 0,
      retVal = 0,
      hasVal = false;
    for (const v of p.variants!) {
      if (v.unlisted) continue;
      const vRet = (v.amount || 0) - (v.soldQty || 0);
      if (vRet <= 0) continue;
      const wg = variantWeight(p, v);
      const price = variantPrice(p, v);
      retQty += vRet;
      retWkg += Math.round(vRet * wg) / 1000;
      if (price != null) {
        retVal += Math.round(price * vRet);
        hasVal = true;
      }
    }
    return { retQty, retWkg: Math.round(retWkg * 1000) / 1000, retVal: hasVal ? retVal : null };
  }
  const c = calcProduct(p);
  const retQty = (c.amount || 0) - (c.soldQty || 0);
  if (retQty <= 0) return { retQty: 0, retWkg: 0, retVal: null };
  const retWkg = Math.round(retQty * ((p.weightG as number) || 0)) / 1000;
  const retVal = c.effectiveUnitPrice != null ? Math.round(c.effectiveUnitPrice * retQty) : null;
  return { retQty, retWkg, retVal };
}

/** Products relevant to customs documents (tariff or VAT info, not unlisted). */
export function hasCustomsInfo(p: CustomsProduct): boolean {
  return !p.unlisted && (!!(p.tariffNo && p.tariffNo.trim()) || (p.vatRate != null && p.vatRate !== ''));
}

// ── 11.74 / 11.87 grouping ──────────────────────────────────────────────────

export interface Form1174Group {
  tariffNo: string;
  qty: number;
  weightKg: number;
  value: number;
  retQty: number;
  retWeightKg: number;
  retValue: number;
}

export interface Form1174Groups {
  g1: Form1174Group;
  g2: Form1174Group;
  hasG2: boolean;
  g1prods: CustomsProduct[];
  g2prods: CustomsProduct[];
}

export function compute1174Groups(state: CustomsState): Form1174Groups {
  const asn = state.form1174.assignments;
  while (asn.length < state.products.length) asn.push(0);
  if (asn.length > state.products.length) asn.length = state.products.length;

  // Same eligibility as the goods list and both proformas (hasCustomsInfo +
  // a nonzero computed amount) - without it, a product with nothing brought
  // this event still added its (zero) weight/value here, which was harmless
  // on its own, but a product missing tariff/VAT info could still get summed
  // into a group, so G1+G2 no longer matched those documents' own totals.
  const eligible = (p: CustomsProduct): boolean => hasCustomsInfo(p) && calcProduct(p).amount > 0;

  function makeGroup(products: CustomsProduct[]): Form1174Group {
    let tariffNo = '-',
      maxVal = -1;
    const g: Form1174Group = { tariffNo: '-', qty: 0, weightKg: 0, value: 0, retQty: 0, retWeightKg: 0, retValue: 0 };
    products.forEach((p) => {
      const c = calcProduct(p);
      g.qty += c.amount || 0;
      g.weightKg += c.totalWeightKg;
      if (c.totalValue != null) g.value += c.totalValue;
      const retQty = Math.max(0, (c.amount || 0) - (c.soldQty || 0));
      g.retQty += retQty;
      g.retWeightKg += Math.round(retQty * ((p.weightG as number) || 0)) / 1000;
      if (c.effectiveUnitPrice != null) g.retValue += Math.round(c.effectiveUnitPrice * retQty);
      if (c.totalValue != null && c.totalValue > maxVal && p.tariffNo) {
        maxVal = c.totalValue;
        tariffNo = p.tariffNo;
      }
    });
    g.tariffNo = tariffNo;
    return g;
  }

  if (state.form1174.groupMode === 'manual') {
    // asn[i] still indexes the full, unfiltered state.products (the manual
    // assignment UI lists every product, eligible or not) - eligible() is
    // applied after, so an ineligible product's own assignment is simply
    // never summed into either group.
    const g1prods = state.products.filter((p, i) => asn[i] === 1 && eligible(p));
    const g2prods = state.products.filter((p, i) => asn[i] !== 1 && eligible(p));
    const g1 = makeGroup(g1prods);
    const g2 = makeGroup(g2prods);
    return { g1, g2, hasG2: g2.qty > 0, g1prods, g2prods };
  }

  // auto mode - group by tariff code, top value = g1, rest = g2
  const eligibleProducts = state.products.filter(eligible);
  const tariffValues: Record<string, number> = {};
  eligibleProducts.forEach((p) => {
    const key = (p.tariffNo || '').trim() || '-';
    const c = calcProduct(p);
    if (!tariffValues[key]) tariffValues[key] = 0;
    if (c.totalValue != null) tariffValues[key] += c.totalValue;
  });
  const topKey = Object.entries(tariffValues).sort((a, b) => b[1] - a[1])[0]?.[0];
  const g1prods = eligibleProducts.filter((p) => ((p.tariffNo || '').trim() || '-') === topKey);
  const g2prods = eligibleProducts.filter((p) => ((p.tariffNo || '').trim() || '-') !== topKey);
  const g1 = makeGroup(g1prods);
  const g2 = makeGroup(g2prods);
  return { g1, g2, hasG2: g2.qty > 0, g1prods, g2prods };
}
