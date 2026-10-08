/**
 * Shopify sync: the match shapes the server computes and the client renders
 * and confirms. One definition for both halves, so the view cannot drift from
 * what `POST /match` returns and `POST /matches/save` stores.
 */

/** Minimal shape of a catalogue product as the matcher needs it. */
export interface ZtVariant {
  id: string;
  name: string;
  sku?: string;
  price?: number;
  weightG?: number;
  imageId?: string;
}

export interface ZtProduct {
  id: string;
  title: string;
  sku?: string;
  type?: string;
  price: number;
  weightG?: number;
  imageId?: string;
  variants: ZtVariant[];
  updatedAt: number;
  deletedAt?: number;
}

/** A single Shopify variant flattened with its parent product context. */
export interface ShopVariantRef {
  productId: string;
  productTitle: string;
  productType: string;
  variantId: string;
  variantTitle: string;
  sku: string;
  price: string;
  /** The variant's own selected image, if it has one. */
  variantImageUrl?: string;
}

/** How a match was established. */
export type MatchKind = 'sku' | 'fuzzy' | 'manual' | 'none';

/** One catalogue variant (or the product itself) mapped to a Shopify variant. */
export interface VariantMatch {
  /** Catalogue variant id, or '' when the product has no variants (it is its own unit). */
  ztVariantId: string;
  ztVariantName: string;
  ztSku?: string;
  ztPrice?: number;
  shop: ShopVariantRef | null;
  kind: MatchKind;
  /** Fuzzy score 0..1 (1 for a SKU/manual match). */
  score: number;
  /** Best Shopify-variant suggestions for the picker, strongest first. */
  candidates: ShopVariantRef[];
}

/** A catalogue product with its per-variant Shopify mapping. */
export interface ProductMatch {
  zt: ZtProduct;
  /** Best-guess Shopify product for product-level ops (title push, image source). */
  shopProductId: string | null;
  variants: VariantMatch[];
}

/** Persisted manual overrides, keyed by catalogue product id. */
export interface SavedProductMatch {
  shopProductId: string | null;
  /** ztVariantId → chosen Shopify variant (or null = explicitly unmatched). */
  variants: Record<string, { productId: string; variantId: string } | null>;
}
export type SavedMatches = Record<string, SavedProductMatch>;
