import type {
  ProductMatch,
  SavedMatches,
  ShopProduct,
  ShopVariantRef,
  VariantMatch,
  ZtProduct,
} from './types';

// Shopify's placeholder variant name plus filler words that carry no signal.
const STOPWORDS = new Set(['default', 'title', 'the', 'and', 'with', 'for', 'a', 'of']);

/** Fold a token: lowercase already done; strip a trailing plural 's' on longer words. */
function fold(tok: string): string {
  return tok.length > 3 && tok.endsWith('s') ? tok.slice(0, -1) : tok;
}

/** Tokenize free text into folded, de-noised tokens (e.g. "Hats & Caps" → [hat, cap]). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(fold);
}

/** Flatten every Shopify product into its variants, each carrying product context. */
export function flattenShop(products: ShopProduct[]): ShopVariantRef[] {
  const refs: ShopVariantRef[] = [];
  for (const p of products) {
    for (const v of p.variants) {
      refs.push({
        productId: p.id,
        productTitle: p.title,
        productType: p.productType,
        variantId: v.id,
        variantTitle: v.title,
        sku: v.sku,
        price: v.price,
        variantImageUrl: v.imageUrl,
      });
    }
  }
  return refs;
}

// SKUs join the text so a partial SKU overlap (e.g. HAT-CATS vs CAP-CATS →
// shared "cats") helps the fuzzy auto-match, on top of the exact-SKU override.
const refText = (r: ShopVariantRef): string => `${r.productTitle} ${r.variantTitle} ${r.productType} ${r.sku}`;

/** Inverse-document-frequency weight per token across the Shopify corpus. */
export function computeIdf(refs: ShopVariantRef[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const r of refs) {
    for (const t of new Set(tokenize(refText(r)))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = Math.max(refs.length, 1);
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / d));
  return idf;
}

// Tokens absent from the Shopify corpus carry no matching value (e.g. ZollTool
// says "hat" where Shopify says "cap") — weight 0, so they never inflate the
// norm and drown out a genuine distinctive-word overlap.
const weight = (idf: Map<string, number>, tok: string): number => idf.get(tok) ?? 0;

/** IDF-weighted cosine-style similarity of two token bags, 0..1. */
export function score(a: string[], b: string[], idf: Map<string, number>): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of new Set(a)) if (setB.has(t)) shared += weight(idf, t) ** 2;
  const normA = [...new Set(a)].reduce((s, t) => s + weight(idf, t) ** 2, 0);
  const normB = [...new Set(b)].reduce((s, t) => s + weight(idf, t) ** 2, 0);
  if (normA === 0 || normB === 0) return 0;
  return shared / Math.sqrt(normA * normB);
}

/** Above this fuzzy score, a suggestion is auto-accepted (below ⇒ shown only as a candidate). */
export const AUTO_THRESHOLD = 0.3;
const MAX_CANDIDATES = 6;

/** The ZollTool "units" to match: each variant, or the product itself when it has none. */
function ztUnits(p: ZtProduct): { id: string; name: string; sku?: string; price?: number }[] {
  if (p.variants.length) return p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, price: v.price }));
  return [{ id: '', name: '', sku: p.sku, price: p.price }];
}

const unitText = (p: ZtProduct, name: string, sku?: string): string => `${p.title} ${name} ${p.type ?? ''} ${sku ?? ''}`;

/**
 * Match each ZollTool variant to a Shopify variant. SKU-exact wins outright;
 * otherwise an IDF-weighted fuzzy score over product+variant+type text drives a
 * greedy global assignment so distinctive words (e.g. "cats", "sakura") match
 * even when a ZollTool product's variants live under several Shopify products.
 * Saved overrides, when present, replace the auto result for that product.
 */
export function matchCatalogs(zt: ZtProduct[], shop: ShopProduct[], saved: SavedMatches = {}): ProductMatch[] {
  const refs = flattenShop(shop);
  const idf = computeIdf(refs);
  const refById = new Map(refs.map((r) => [r.variantId, r]));

  // Precompute tokens per Shopify ref and per ZollTool unit.
  const refTokens = new Map(refs.map((r) => [r.variantId, tokenize(refText(r))]));

  interface Unit { ztProductId: string; ztVariantId: string; name: string; sku?: string; price?: number; tokens: string[]; }
  const units: Unit[] = [];
  for (const p of zt) {
    for (const u of ztUnits(p)) {
      units.push({ ztProductId: p.id, ztVariantId: u.id, name: u.name, sku: u.sku, price: u.price, tokens: tokenize(unitText(p, u.name, u.sku)) });
    }
  }

  // Score every (unit, ref) pair; keep per-unit candidate lists and a global list for greedy assignment.
  const skuOf = new Map<string, ShopVariantRef>();
  for (const r of refs) if (r.sku.trim()) skuOf.set(r.sku.trim(), r);

  const candidatesByUnit = new Map<string, { ref: ShopVariantRef; s: number }[]>();
  const pairs: { unitKey: string; ref: ShopVariantRef; s: number; sku: boolean }[] = [];
  for (const u of units) {
    const unitKey = `${u.ztProductId}::${u.ztVariantId}`;
    const scored: { ref: ShopVariantRef; s: number }[] = [];
    for (const r of refs) {
      const s = score(u.tokens, refTokens.get(r.variantId)!, idf);
      if (s > 0) scored.push({ ref: r, s });
    }
    scored.sort((a, b) => b.s - a.s);
    candidatesByUnit.set(unitKey, scored.slice(0, MAX_CANDIDATES));
    const skuHit = u.sku?.trim() ? skuOf.get(u.sku.trim()) : undefined;
    if (skuHit) pairs.push({ unitKey, ref: skuHit, s: 1, sku: true });
    for (const c of scored) pairs.push({ unitKey, ref: c.ref, s: c.s, sku: false });
  }

  // Greedy global assignment: strongest pair first, each unit and each Shopify variant used once.
  pairs.sort((a, b) => (b.sku ? 1 : 0) - (a.sku ? 1 : 0) || b.s - a.s);
  const assignedUnit = new Map<string, { ref: ShopVariantRef; s: number; sku: boolean }>();
  const takenRef = new Set<string>();
  for (const p of pairs) {
    if (assignedUnit.has(p.unitKey) || takenRef.has(p.ref.variantId)) continue;
    if (!p.sku && p.s < AUTO_THRESHOLD) continue;
    assignedUnit.set(p.unitKey, { ref: p.ref, s: p.s, sku: p.sku });
    takenRef.add(p.ref.variantId);
  }

  // Assemble per-product results, applying saved overrides last.
  const out: ProductMatch[] = [];
  for (const p of zt) {
    const saveEntry = saved[p.id];
    const variants: VariantMatch[] = ztUnits(p).map((u) => {
      const unitKey = `${p.id}::${u.id}`;
      const auto = assignedUnit.get(unitKey);
      const candidates = (candidatesByUnit.get(unitKey) ?? []).map((c) => c.ref);

      let shop: ShopVariantRef | null = auto?.ref ?? null;
      let kind: VariantMatch['kind'] = auto ? (auto.sku ? 'sku' : 'fuzzy') : 'none';
      let sc = auto?.s ?? 0;

      if (saveEntry && Object.prototype.hasOwnProperty.call(saveEntry.variants, u.id)) {
        const ov = saveEntry.variants[u.id];
        shop = ov ? refById.get(ov.variantId) ?? null : null;
        kind = shop ? 'manual' : 'none';
        sc = shop ? 1 : 0;
      }
      return { ztVariantId: u.id, ztVariantName: u.name, ztSku: u.sku, ztPrice: u.price, shop, kind, score: sc, candidates };
    });

    // Product-level Shopify product: saved override, else the most-referenced matched product.
    let shopProductId: string | null = saveEntry?.shopProductId ?? null;
    if (!shopProductId) {
      const counts = new Map<string, number>();
      for (const v of variants) if (v.shop) counts.set(v.shop.productId, (counts.get(v.shop.productId) ?? 0) + 1);
      shopProductId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    out.push({ zt: p, shopProductId, variants });
  }
  return out;
}
