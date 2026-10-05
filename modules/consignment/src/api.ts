import { computed, ref } from 'vue';
import {
  isStore,
  type ArtistConsignment,
  type ConsignmentLine,
  type ConsignmentPayout,
  type ConsignmentVenue,
  type Consignor,
  type ConsignorInput,
  type ConsignorStatement,
  type PayoutInput,
  type Product,
} from '@zollify/shared';
import { sdk } from './runtime';

/**
 * Typed wrapper over this module's server half. Requests reach
 * `/api/m/consignment/…`; the host roots them there, so nothing here can
 * address another module or another account.
 */

export interface Statement {
  consignors: Consignor[];
  venues: ConsignmentVenue[];
  lines: ConsignmentLine[];
  payouts: ConsignmentPayout[];
  statements: ConsignorStatement[];
}

/** A product in a linked artist's own catalogue, as the server shares it. */
export type CatalogProduct = Pick<
  Product,
  'id' | 'title' | 'sku' | 'type' | 'price' | 'priceNote' | 'weightG' | 'material' | 'year' | 'originCountry' | 'tariffNo' | 'taxClass'
> & { variants: { id: string; name: string; sku?: string; price?: number; weightG?: number; material?: string }[] };

export const consignors = ref<Consignor[]>([]);
export const loaded = ref(false);

/** The account's stores - venues of kind 'store' - for assigning artists to. */
export const stores = computed(() => sdk().data.events.list().filter((e) => isStore(e) && !e.deletedAt));

export const products = computed(() => sdk().data.products.list());
export const productsOf = (consignorId: string): Product[] => products.value.filter((p) => p.consignorId === consignorId);

export async function loadConsignors(): Promise<void> {
  consignors.value = (await sdk().http.get<{ consignors: Consignor[] }>('consignors')).consignors;
  loaded.value = true;
}

export async function saveConsignor(id: string, input: ConsignorInput): Promise<Consignor> {
  const { consignor } = await sdk().http.put<{ consignor: Consignor }>(`consignors/${encodeURIComponent(id)}`, input);
  const i = consignors.value.findIndex((c) => c.id === id);
  if (i >= 0) consignors.value.splice(i, 1, consignor);
  else consignors.value.push(consignor);
  return consignor;
}

/** Only an artist with no sales or payouts can go; their items stay in the catalogue as the store's own. */
export async function deleteConsignor(id: string): Promise<void> {
  await sdk().http.del(`consignors/${encodeURIComponent(id)}`);
  for (const p of productsOf(id)) await sdk().data.products.upsert(withoutConsignor(p));
  consignors.value = consignors.value.filter((c) => c.id !== id);
}

export async function issueLinkCode(id: string): Promise<{ code: string; expiresAt: number }> {
  const res = await sdk().http.post<{ code: string; expiresAt: number }>(`consignors/${encodeURIComponent(id)}/link-code`);
  await loadConsignors();
  return res;
}

export async function unlinkConsignor(id: string): Promise<void> {
  await sdk().http.del(`consignors/${encodeURIComponent(id)}/link`);
  await loadConsignors();
}

export async function artistCatalog(id: string): Promise<CatalogProduct[]> {
  return (await sdk().http.get<{ products: CatalogProduct[] }>(`consignors/${encodeURIComponent(id)}/catalog`)).products;
}

export const loadStatement = (): Promise<Statement> => sdk().http.get<Statement>('statement');
export const addPayout = (input: PayoutInput): Promise<{ payout: ConsignmentPayout }> => sdk().http.post('payouts', input);
export const deletePayout = (id: string): Promise<unknown> => sdk().http.del(`payouts/${encodeURIComponent(id)}`);

// ── The artist's side ──────────────────────────────────────────────────────

export const myLinks = async (): Promise<ArtistConsignment[]> => (await sdk().http.get<{ links: ArtistConsignment[] }>('links')).links;
export const acceptCode = (code: string): Promise<{ storeAccountName: string; consignorName: string }> => sdk().http.post('links', { code });
export const leaveStore = (storeAccountId: string, consignorId: string): Promise<unknown> =>
  sdk().http.del(`links/${encodeURIComponent(storeAccountId)}/${encodeURIComponent(consignorId)}`);

// ── Catalogue edits ────────────────────────────────────────────────────────

export function withoutConsignor(p: Product): Product {
  const { consignorId: _c, consignorProductId: _s, ...rest } = p;
  return { ...rest, updatedAt: Date.now() };
}

export async function assign(productIds: string[], consignorId: string): Promise<void> {
  for (const id of productIds) {
    const p = sdk().data.products.get(id);
    if (p) await sdk().data.products.upsert({ ...p, consignorId, updatedAt: Date.now() });
  }
}

export async function unassign(productId: string): Promise<void> {
  const p = sdk().data.products.get(productId);
  if (p) await sdk().data.products.upsert(withoutConsignor(p));
}

/**
 * Copies items from a linked artist's catalogue into this one, tagged as
 * theirs. Photos stay on the artist's devices, so imported items start
 * without one.
 */
export async function importFromArtist(consignorId: string, items: CatalogProduct[]): Promise<number> {
  let sortOrder = Math.max(0, ...products.value.map((p) => p.sortOrder)) + 1;
  for (const src of items) {
    const product: Product = {
      id: crypto.randomUUID(),
      title: src.title,
      ...(src.sku ? { sku: src.sku } : {}),
      ...(src.type ? { type: src.type } : {}),
      price: src.price,
      ...(src.priceNote ? { priceNote: src.priceNote } : {}),
      ...(src.weightG != null ? { weightG: src.weightG } : {}),
      ...(src.material ? { material: src.material } : {}),
      ...(src.year != null ? { year: src.year } : {}),
      ...(src.originCountry ? { originCountry: src.originCountry } : {}),
      ...(src.tariffNo ? { tariffNo: src.tariffNo } : {}),
      ...(src.taxClass ? { taxClass: src.taxClass } : {}),
      forSale: true,
      unlisted: false,
      variants: src.variants.map((v) => ({ ...v })),
      consignorId,
      consignorProductId: src.id,
      sortOrder: sortOrder++,
      updatedAt: Date.now(),
    };
    await sdk().data.products.upsert(product);
  }
  return items.length;
}

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } } | null)?.body;
  if (body?.message) return body.message;
  return err instanceof Error && err.message ? err.message : fallback;
}

export const today = (): string => new Date().toISOString().slice(0, 10);
