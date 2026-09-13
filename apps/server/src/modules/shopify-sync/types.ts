/** Minimal shape of a ZollTool catalog product (see ZollTool shared/types.ts). */
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

/** Shopify product/variant/image, normalized from the Admin GraphQL response. */
export interface ShopVariant {
  id: string; // gid://shopify/ProductVariant/123
  title: string;
  sku: string;
  price: string; // Shopify returns money as a string
  /** The variant's own selected image, if it has one. */
  imageUrl?: string;
}

export interface ShopImage {
  id: string; // gid://shopify/MediaImage/123
  url: string;
  altText: string | null;
}

export interface ShopProduct {
  id: string; // gid://shopify/Product/123
  title: string;
  handle: string;
  productType: string;
  images: ShopImage[];
  variants: ShopVariant[];
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

/** One ZollTool variant (or the product itself) mapped to a Shopify variant. */
export interface VariantMatch {
  /** ZollTool variant id, or '' when the product has no variants (it is its own unit). */
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

/** A ZollTool product with its per-variant Shopify mapping. */
export interface ProductMatch {
  zt: ZtProduct;
  /** Best-guess Shopify product for product-level ops (title push, image source). */
  shopProductId: string | null;
  variants: VariantMatch[];
}

/** Persisted manual overrides, keyed by ZollTool product id. */
export interface SavedProductMatch {
  shopProductId: string | null;
  /** ztVariantId → chosen Shopify variant (or null = explicitly unmatched). */
  variants: Record<string, { productId: string; variantId: string } | null>;
}
export type SavedMatches = Record<string, SavedProductMatch>;
