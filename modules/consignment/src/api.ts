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
  type ConsignmentRental,
  type ConsignmentSpace,
  type Delivery,
  type PayoutInput,
  type Product,
  type RentalInput,
  type SetupInput,
  type SetupMoment,
  type SpaceInput,
  type UpgradeInput,
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

/** The store the planner shows; kept here so it survives the tab reloading. */
export const plannerStoreId = ref('');

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

// ── Planner ────────────────────────────────────────────────────────────────

export interface Planner {
  spaces: ConsignmentSpace[];
  rentals: ConsignmentRental[];
  setups: SetupMoment[];
  /** Whether this server can send email at all. */
  emailEnabled: boolean;
}

const id = (s: string): string => encodeURIComponent(s);
export const loadPlanner = (): Promise<Planner> => sdk().http.get<Planner>('planner');
export const saveSpace = (spaceId: string, input: SpaceInput): Promise<{ space: ConsignmentSpace }> => sdk().http.put(`spaces/${id(spaceId)}`, input);
export const deleteSpace = (spaceId: string): Promise<unknown> => sdk().http.del(`spaces/${id(spaceId)}`);
export const bookRental = (input: RentalInput): Promise<{ rental: ConsignmentRental; delivery: Delivery }> => sdk().http.post('rentals', input);
export const editRental = (rentalId: string, input: RentalInput): Promise<{ rental: ConsignmentRental }> => sdk().http.put(`rentals/${id(rentalId)}`, input);
export const upgradeRental = (rentalId: string, input: UpgradeInput): Promise<{ rental: ConsignmentRental; delivery: Delivery }> =>
  sdk().http.post(`rentals/${id(rentalId)}/upgrade`, input);
export const endRental = (rentalId: string, on: string): Promise<{ rental: ConsignmentRental }> => sdk().http.post(`rentals/${id(rentalId)}/end`, { on });
export const deleteRental = (rentalId: string): Promise<unknown> => sdk().http.del(`rentals/${id(rentalId)}`);
export const scheduleSetup = (input: SetupInput): Promise<{ setup: SetupMoment; delivery: Delivery }> => sdk().http.post('setups', input);
export const moveSetup = (setupId: string, input: SetupInput): Promise<{ setup: SetupMoment; delivery: Delivery | null }> => sdk().http.put(`setups/${id(setupId)}`, input);
export const cancelSetup = (setupId: string): Promise<{ setup: SetupMoment; delivery: Delivery | null }> => sdk().http.post(`setups/${id(setupId)}/cancel`);

/** One line on who heard about it, for a toast. */
export function deliveryText(name: string, d: Delivery | null | undefined): string {
  if (!d) return 'Saved.';
  const parts: string[] = [];
  if (d.notified) parts.push(`${name} was notified in Zollify`);
  if (d.emailedTo) parts.push(`emailed at ${d.emailedTo}`);
  let text = parts.length ? `${parts.join(' and ')}.` : `Saved - ${name} has no linked account to notify.`;
  if (d.emailSkipped === 'no_address') text += ' No email sent: add their address under Artists.';
  if (d.emailSkipped === 'not_configured') text += ' No email sent: this server has no email set up.';
  if (d.emailSkipped === 'failed') text += ' The email could not be sent.';
  return text;
}

// ── The artist's side ──────────────────────────────────────────────────────

export const myLinks = async (): Promise<ArtistConsignment[]> => (await sdk().http.get<{ links: ArtistConsignment[] }>('links')).links;
export const acceptCode = (code: string): Promise<{ storeAccountName: string; consignorName: string }> => sdk().http.post('links', { code });
export const respondToSetup = (storeAccountId: string, consignorId: string, setupId: string, status: 'confirmed' | 'declined', note = ''): Promise<{ setup: SetupMoment }> =>
  sdk().http.post(`links/${id(storeAccountId)}/${id(consignorId)}/setups/${id(setupId)}/respond`, { status, note });
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
