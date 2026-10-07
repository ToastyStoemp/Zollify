// The match shapes are shared with the client module - see @zollify/shared's shopify-match.
export type { MatchKind, ProductMatch, SavedMatches, SavedProductMatch, ShopVariantRef, VariantMatch, ZtProduct, ZtVariant } from '@zollify/shared';

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
