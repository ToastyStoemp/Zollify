/**
 * Customs calculation core — exact port of the legacy www/app.js functions.
 * Do not "improve" rounding or formatting here: outputs are golden-tested
 * byte-for-byte against the legacy generators.
 */
import { COUNTRY_CODES, HS_CODES } from './data';
import type { CustomsProduct, CustomsState, CustomsVariant, NumLike } from './model';

// ── Formatting ──────────────────────────────────────────────────────────────

export function fmtEventDates(start: string, end: string): string {
  if (!start) return '';
  const s = new Date(start + 'T00:00:00');
  const d1 = s.getDate();
  const mm = String(s.getMonth() + 1).padStart(2, '0');
  const yyyy = s.getFullYear();
  if (!end) return `${d1}.${mm}.${yyyy}`;
  const e = new Date(end + 'T00:00:00');
  const d2 = e.getDate();
  return `${d1}. – ${d2}.${mm}.${yyyy}`;
}

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

// ── Escaping ────────────────────────────────────────────────────────────────

/** HTML escape incl. double quotes (legacy `esc`). */
export function esc(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeXml(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Country / code helpers ──────────────────────────────────────────────────

export function countryToCode(name: string | undefined): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  const code = COUNTRY_CODES[trimmed.toLowerCase()];
  if (code) return code;
  return trimmed.toUpperCase().slice(0, 2);
}

export function parsePostCodeCity(str: string): { postCode: string; city: string } {
  if (!str) return { postCode: '', city: '' };
  const match = str.match(/^(\S+)\s+(.+)$/);
  // The regex has two capture groups, so both are present whenever it matches;
  // the fallbacks satisfy noUncheckedIndexedAccess without changing behaviour.
  if (match) return { postCode: match[1] ?? '', city: match[2] ?? '' };
  return { postCode: '', city: str };
}

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

// ── Variant helpers ─────────────────────────────────────────────────────────

export function hasVariants(p: CustomsProduct): boolean {
  return Array.isArray(p.variants) && p.variants.length > 0;
}

export function variantPrice(p: CustomsProduct, v: CustomsVariant): number | null {
  const raw = v.price != null && v.price !== '' ? v.price : p.price;
  return raw != null && !isNaN(parseFloat(raw as string)) ? parseFloat(raw as string) : null;
}

export function variantWeight(p: CustomsProduct, v: CustomsVariant): number {
  const raw = v.weightG != null && v.weightG !== '' ? v.weightG : p.weightG;
  return parseFloat(raw as string) || 0;
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

export function calcProduct(p: CustomsProduct, skipUnlistedVariants = false): ProductCalc {
  if (hasVariants(p)) {
    let amount = 0,
      totalWeightKg = 0,
      totalValue = 0;
    let soldQty = 0,
      soldValue = 0,
      soldWeightKg = 0;
    for (const v of p.variants!) {
      if (skipUnlistedVariants && v.unlisted) continue;
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
      totalWeightKg,
      totalValue: totalValue > 0 ? Math.round(totalValue) : null,
      effectiveUnitPrice,
      effectiveUnitWeightG,
      soldWeightKg,
      amount,
      soldQty,
      soldValue,
    };
  }

  const amount = p.amount || 0;
  // Weight: round to nearest gram first to eliminate floating-point noise, then convert to kg
  const totalWeightKg = Math.round(amount * ((p.weightG as number) || 0)) / 1000;
  // Value: round to whole CHF — the total is the authoritative number
  let totalValue = p.totalValueCHF != null ? Math.round(parseFloat(p.totalValueCHF as string)) : null;
  if (totalValue == null && p.price != null && p.price !== '') {
    totalValue = Math.round(parseFloat(p.price as string) * amount);
  }
  const effectiveUnitPrice = totalValue != null && amount > 0 ? totalValue / amount : null;
  const effectiveUnitWeightG = amount > 0 ? (totalWeightKg * 1000) / amount : p.weightG || 0;
  const soldWeightKg = ((p.soldQty || 0) * ((p.weightG as number) || 0)) / 1000;
  return {
    totalWeightKg,
    totalValue,
    effectiveUnitPrice,
    effectiveUnitWeightG,
    soldWeightKg,
    amount,
    soldQty: p.soldQty || 0,
    soldValue: p.soldValue || 0,
  };
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

  function makeGroup(products: CustomsProduct[]): Form1174Group {
    let tariffNo = '—',
      maxVal = -1;
    const g: Form1174Group = { tariffNo: '—', qty: 0, weightKg: 0, value: 0, retQty: 0, retWeightKg: 0, retValue: 0 };
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
    const g1prods = state.products.filter((_, i) => asn[i] === 1);
    const g2prods = state.products.filter((_, i) => asn[i] !== 1);
    const g1 = makeGroup(g1prods);
    const g2 = makeGroup(g2prods);
    return { g1, g2, hasG2: g2.qty > 0, g1prods, g2prods };
  }

  // auto mode — group by tariff code, top value = g1, rest = g2
  const tariffValues: Record<string, number> = {};
  state.products.forEach((p) => {
    const key = (p.tariffNo || '').trim() || '—';
    const c = calcProduct(p);
    if (!tariffValues[key]) tariffValues[key] = 0;
    if (c.totalValue != null) tariffValues[key] += c.totalValue;
  });
  const topKey = Object.entries(tariffValues).sort((a, b) => b[1] - a[1])[0]?.[0];
  const g1prods = state.products.filter((p) => ((p.tariffNo || '').trim() || '—') === topKey);
  const g2prods = state.products.filter((p) => ((p.tariffNo || '').trim() || '—') !== topKey);
  const g1 = makeGroup(g1prods);
  const g2 = makeGroup(g2prods);
  return { g1, g2, hasG2: g2.qty > 0, g1prods, g2prods };
}
