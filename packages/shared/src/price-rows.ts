import type { DiscountRule, Product } from './types';

/**
 * Flat, card-ready price rows — ported from ZollPriceCards. One row per
 * sellable item (per variant when a product has them), each with a `key`
 * (the SKU, or an id fallback) a Photoshop text layer is matched against,
 * and a `text` price in the requested currency. Prices are decimals of the
 * catalogue's base currency.
 */

const SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF ',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  CZK: 'Kč',
  JPY: '¥',
  CAD: '$',
  AUD: '$',
};
export const symbolFor = (c: string): string => SYMBOLS[String(c || '').toUpperCase()] ?? `${c} `;

export interface PriceTier {
  qty: number;
  amount: number;
  price: string;
  text: string;
}
export interface PriceRow {
  key: string;
  id: string;
  variantId: string;
  sku: string;
  title: string;
  variant: string;
  label: string;
  base: number;
  amount: number;
  text: string;
  currency: string;
  symbol: string;
  tiers: PriceTier[];
  tiersText: string;
  discountName: string;
}
export interface PriceFeed {
  currency: string;
  symbol: string;
  exchangeRate: number;
  rounding: number;
  rows: PriceRow[];
}

export function priceRows(products: Product[], opts: { currency?: string; exchangeRate?: number; rounding?: number } = {}, discounts: DiscountRule[] = []): PriceFeed {
  const currency = (opts.currency || 'EUR').toUpperCase();
  const rate = Number(opts.exchangeRate) > 0 ? Number(opts.exchangeRate) : 1;
  const rounding = Number(opts.rounding) > 0 ? Number(opts.rounding) : 0;
  const sym = symbolFor(currency);
  const trailsSymbol = /^(kr|zł|Kč)$/.test(sym.trim());

  const convert = (base: number): number => {
    let v = (Number(base) || 0) * rate;
    if (rounding > 0) v = Math.round(v / rounding) * rounding;
    return v;
  };
  const money = (v: number, decimals: number): string => {
    const num = v.toFixed(decimals);
    return trailsSymbol ? `${num} ${sym.trim()}` : `${sym}${num}`;
  };
  const fmt = (base: number) => {
    const v = convert(base);
    const decimals = rounding >= 1 ? 0 : 2;
    return { amount: Number(v.toFixed(decimals)), text: money(v, decimals), currency, symbol: sym.trim() };
  };
  // Tier prices trim a whole ".00" so bundle deals read as "€10", not "€10.00".
  const tierText = (v: number): string => money(v, Math.abs(v - Math.round(v)) < 0.005 ? 0 : 2);

  const tiered = discounts.filter((d) => !d.deletedAt && d.type === 'tiered' && Array.isArray(d.tiers) && d.tiers.length);
  const applies = (rule: DiscountRule, product: Product, variant: Product['variants'][number] | null): boolean =>
    rule.productIds.includes(product.id) ||
    (!!product.type && (rule.productTypes ?? []).includes(product.type)) ||
    (!!variant && rule.variantIds.includes(`${product.id}:${variant.id}`));
  /** The "N for X" ladder for a row, plus a qty-1 line from the unit price when the rule omits it. */
  function ladderFor(product: Product, variant: Product['variants'][number] | null, unit: number) {
    const rule = tiered.find((d) => applies(d, product, variant));
    if (!rule) return { tiers: [] as PriceTier[], tiersText: '', discountName: '' };
    const tiers: PriceTier[] = rule
      .tiers!.filter((t) => Number(t.qty) > 0)
      .map((t) => {
        const v = convert(t.total);
        return { qty: Number(t.qty), amount: Number(v.toFixed(2)), price: tierText(v), text: `${Number(t.qty)} for ${tierText(v)}` };
      });
    if (!tiers.some((t) => t.qty === 1)) {
      const v = convert(unit);
      tiers.unshift({ qty: 1, amount: Number(v.toFixed(2)), price: tierText(v), text: `1 for ${tierText(v)}` });
    }
    tiers.sort((a, b) => a.qty - b.qty);
    return { tiers, tiersText: tiers.map((t) => t.text).join('\n'), discountName: rule.name || '' };
  }

  const rows: PriceRow[] = [];
  for (const p of products) {
    if (p.deletedAt || p.forSale === false || p.unlisted) continue;
    const variants = (p.variants ?? []).filter((v) => !v.unlisted);
    if (variants.length) {
      for (const v of variants) {
        const base = v.price ?? p.price ?? 0;
        rows.push({
          key: v.sku || `${p.sku || p.id}:${v.id}`,
          id: p.id,
          variantId: v.id,
          sku: v.sku || p.sku || '',
          title: p.title || '',
          variant: v.name || '',
          label: v.name ? `${p.title} — ${v.name}` : p.title || '',
          base,
          ...fmt(base),
          ...ladderFor(p, v, base),
        });
      }
    } else {
      const base = p.price || 0;
      rows.push({ key: p.sku || p.id, id: p.id, variantId: '', sku: p.sku || '', title: p.title || '', variant: '', label: p.title || '', base, ...fmt(base), ...ladderFor(p, null, base) });
    }
  }
  rows.sort((a, b) => a.label.localeCompare(b.label));
  return { currency, symbol: sym.trim(), exchangeRate: rate, rounding, rows };
}
