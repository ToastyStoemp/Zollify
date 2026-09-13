import type { ShopProduct } from './types';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/** Client for the Shopify Admin GraphQL API (read catalog, write SKU/price/title). */
export class ShopifyClient {
  private readonly endpoint: string;

  constructor(shop: string, apiVersion: string, private readonly token: string) {
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Shopify-Access-Token': this.token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Shopify HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
    if (!json.data) throw new Error('Shopify GraphQL: empty response');
    return json.data;
  }

  /** Fetch every product with its variants and images (paginates automatically). */
  async products(): Promise<ShopProduct[]> {
    const query = `
      query Products($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            productType
            media(first: 20) {
              nodes { ... on MediaImage { id image { url altText } } }
            }
            variants(first: 100) {
              nodes { id title sku price image { url } }
            }
          }
        }
      }`;
    type Resp = {
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          title: string;
          handle: string;
          productType: string | null;
          media: { nodes: { id?: string; image?: { url: string; altText: string | null } }[] };
          variants: { nodes: { id: string; title: string; sku: string | null; price: string; image: { url: string } | null }[] };
        }[];
      };
    };
    const out: ShopProduct[] = [];
    let cursor: string | null = null;
    do {
      const data: Resp = await this.gql<Resp>(query, { cursor });
      for (const n of data.products.nodes) {
        out.push({
          id: n.id,
          title: n.title,
          handle: n.handle,
          productType: n.productType ?? '',
          images: n.media.nodes
            .filter((m) => m.image?.url)
            .map((m) => ({ id: m.id ?? m.image!.url, url: m.image!.url, altText: m.image!.altText })),
          variants: n.variants.nodes.map((v) => ({ id: v.id, title: v.title, sku: v.sku ?? '', price: v.price, imageUrl: v.image?.url })),
        });
      }
      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }

  /** Update a product's title. */
  async updateTitle(productId: string, title: string): Promise<void> {
    const mutation = `
      mutation UpdateTitle($input: ProductInput!) {
        productUpdate(input: $input) { userErrors { field message } }
      }`;
    const data = await this.gql<{ productUpdate: { userErrors: { message: string }[] } }>(mutation, {
      input: { id: productId, title },
    });
    this.throwOnUserErrors(data.productUpdate.userErrors);
  }

  /**
   * Set SKU and/or price on variants of a product. In the modern Admin API the
   * SKU lives on the variant's inventory item, so it goes under `inventoryItem`.
   */
  async updateVariants(
    productId: string,
    variants: { id: string; sku?: string; price?: string }[],
  ): Promise<void> {
    const mutation = `
      mutation BulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`;
    const payload = variants.map((v) => ({
      id: v.id,
      ...(v.price !== undefined ? { price: v.price } : {}),
      ...(v.sku !== undefined ? { inventoryItem: { sku: v.sku } } : {}),
    }));
    const data = await this.gql<{ productVariantsBulkUpdate: { userErrors: { message: string }[] } }>(mutation, {
      productId,
      variants: payload,
    });
    this.throwOnUserErrors(data.productVariantsBulkUpdate.userErrors);
  }

  private throwOnUserErrors(errors: { message: string }[]): void {
    if (errors?.length) throw new Error(`Shopify userErrors: ${errors.map((e) => e.message).join('; ')}`);
  }
}
