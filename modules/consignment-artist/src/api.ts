import type { ArtistConsignment, ArtistDiscount, ArtistDiscountInput, ConsignmentFee, SetupMoment, ShareableItem } from '@zollify/shared';
import { sdk } from './runtime';

/**
 * Typed calls to the artist's half of consignment (`/api/m/consignment-artist/…`).
 * Every route is scoped by the caller's own account: a store shows up here
 * only once this account accepted its invite.
 */

const id = (s: string): string => encodeURIComponent(s);
const linkPath = (storeAccountId: string, consignorId: string, rest = ''): string => `links/${id(storeAccountId)}/${id(consignorId)}${rest ? `/${rest}` : ''}`;

export const myLinks = async (): Promise<ArtistConsignment[]> => (await sdk().http.get<{ links: ArtistConsignment[] }>('links')).links;
export const acceptCode = (code: string): Promise<{ storeAccountName: string; consignorName: string }> => sdk().http.post('links', { code });
export const leaveStore = (storeAccountId: string, consignorId: string): Promise<unknown> => sdk().http.del(linkPath(storeAccountId, consignorId));

/** Invites waiting for this account's answer. */
export interface Offer {
  storeAccountId: string;
  storeAccountName: string;
  consignorId: string;
  consignorName: string;
  commissionPct: number;
}
export const loadOffers = async (): Promise<Offer[]> => (await sdk().http.get<{ offers: Offer[] }>('links/offers')).offers;
export const answerOffer = (o: Offer, accept: boolean): Promise<{ storeAccountName: string; consignorName: string } | { ok: true }> =>
  sdk().http.post(`links/offers/${id(o.storeAccountId)}/${id(o.consignorId)}`, { accept });

export interface Shares {
  artistCurrency: string;
  storeCurrency: string;
  items: ShareableItem[];
}
export const loadShares = (storeAccountId: string, consignorId: string): Promise<Shares> => sdk().http.get(linkPath(storeAccountId, consignorId, 'shares'));
/** `keys` are product ids, or `productId:variantId` for one variant. */
export const setShares = (storeAccountId: string, consignorId: string, keys: string[], shared: boolean): Promise<{ items: ShareableItem[] }> =>
  sdk().http.put(linkPath(storeAccountId, consignorId, 'shares'), { productIds: keys, shared });

export interface StockLineInput {
  productId: string;
  variantId: string;
  qty: number;
}
export const restock = (storeAccountId: string, consignorId: string, body: { lines: StockLineInput[]; mode: 'add' | 'set'; storeId: string | null }): Promise<unknown> =>
  sdk().http.post(linkPath(storeAccountId, consignorId, 'stock'), body);
export const sendShipment = (
  storeAccountId: string,
  consignorId: string,
  body: { storeId: string; lines: StockLineInput[]; note: string; carrier: string; tracking: string },
): Promise<unknown> => sdk().http.post(linkPath(storeAccountId, consignorId, 'shipments'), body);
export const cancelShipment = (storeAccountId: string, consignorId: string, shipmentId: string): Promise<unknown> =>
  sdk().http.del(linkPath(storeAccountId, consignorId, `shipments/${id(shipmentId)}`));

export const respondToSetup = (storeAccountId: string, consignorId: string, setupId: string, status: 'confirmed' | 'declined', note = ''): Promise<{ setup: SetupMoment }> =>
  sdk().http.post(linkPath(storeAccountId, consignorId, `setups/${id(setupId)}/respond`), { status, note });
export const disputeFee = (storeAccountId: string, consignorId: string, feeId: string, note: string): Promise<{ fee: ConsignmentFee }> =>
  sdk().http.post(linkPath(storeAccountId, consignorId, `fees/${id(feeId)}/dispute`), { note });

export interface ArtistDiscounts {
  allowed: boolean;
  maxPct: number;
  discounts: ArtistDiscount[];
  items: { productId: string; title: string }[];
  stores: { id: string; name: string }[];
}
export const loadArtistDiscounts = (storeAccountId: string, consignorId: string): Promise<ArtistDiscounts> => sdk().http.get(linkPath(storeAccountId, consignorId, 'discounts'));
export const saveArtistDiscount = (storeAccountId: string, consignorId: string, discountId: string, input: ArtistDiscountInput): Promise<{ discount: ArtistDiscount }> =>
  sdk().http.put(linkPath(storeAccountId, consignorId, `discounts/${id(discountId)}`), input);
export const endArtistDiscount = (storeAccountId: string, consignorId: string, discountId: string): Promise<unknown> =>
  sdk().http.del(linkPath(storeAccountId, consignorId, `discounts/${id(discountId)}`));

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } } | null)?.body;
  if (body?.message) return body.message;
  return err instanceof Error && err.message ? err.message : fallback;
}

export const today = (): string => new Date().toISOString().slice(0, 10);
