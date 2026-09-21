/**
 * Builds CustomsDeState from live v2 data: event + products + per-event stock
 * + transactions. Brought quantities come from EventStock; sold quantities
 * are derived from non-reverted transactions - never stored, same rule as
 * the Swiss customs module (see customs-ch/src/engine/adapter.ts).
 */
import type { EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';
import type { CustomsDeDeclarant, CustomsDeMeta, CustomsDeProduct, CustomsDeState, CustomsDeVariant } from './model';
import { defaultCustomsDeDeclarant, defaultCustomsDeMeta } from './model';

export interface CustomsDeBlob {
  meta?: Partial<CustomsDeMeta>;
  declarant?: Partial<CustomsDeDeclarant>;
}

export function readCustomsDeBlob(event: SalesEvent): CustomsDeBlob {
  return (event.customsDe ?? {}) as CustomsDeBlob;
}

export function buildCustomsDeState(
  event: SalesEvent,
  products: Product[],
  stock: EventStock[],
  transactions: Transaction[],
): CustomsDeState {
  const blob = readCustomsDeBlob(event);

  const broughtByKey = new Map<string, number>();
  for (const row of stock) {
    if (row.eventId !== event.id) continue;
    broughtByKey.set(`${row.productId}:${row.variantId}`, row.broughtQty);
  }

  const soldByKey = new Map<string, { qty: number; value: number }>();
  for (const tx of transactions) {
    if (tx.eventId !== event.id || tx.revertedBy) continue;
    for (const item of tx.items) {
      const key = `${item.pid}:${item.vid ?? ''}`;
      const cur = soldByKey.get(key) ?? { qty: 0, value: 0 };
      cur.qty += item.qty;
      cur.value += item.baseLineTotal ?? item.lineTotal;
      soldByKey.set(key, cur);
    }
  }

  // Documents read best with items of one type together: group by type
  // (catalogue order within), same as customs-ch's adapter - a customs
  // officer sees all prints, then all pins, rather than the booth's own
  // display order.
  const typeRank = new Map<string, number>();
  for (const p of products) {
    const t = p.type?.trim() || '￿';
    if (!typeRank.has(t)) typeRank.set(t, typeRank.size);
  }

  const customsProducts: CustomsDeProduct[] = [...products]
    .filter((p) => !p.deletedAt)
    .sort((a, b) => (typeRank.get(a.type?.trim() || '￿') ?? 0) - (typeRank.get(b.type?.trim() || '￿') ?? 0))
    .map((p) => {
      // The parent line always carries the rolled-up total - that's what the
      // ATLAS/DEXPDF side reads, which has no verified per-variant layout to
      // justify the extra detail. The packing list wants that detail though
      // (same level as the Swiss import list), so variants are carried too.
      let amount = broughtByKey.get(`${p.id}:`) ?? 0;
      let sold = soldByKey.get(`${p.id}:`) ?? { qty: 0, value: 0 };
      const variants: CustomsDeVariant[] = p.variants.map((v) => {
        const vAmount = broughtByKey.get(`${p.id}:${v.id}`) ?? 0;
        const vSold = soldByKey.get(`${p.id}:${v.id}`) ?? { qty: 0, value: 0 };
        // Unlisted variants never count toward the rolled-up total - same rule
        // as an unlisted product, otherwise this total and calcDeProduct's own
        // variant-aware total (which does skip them) disagree.
        if (!v.unlisted) {
          amount += vAmount;
          sold = { qty: sold.qty + vSold.qty, value: sold.value + vSold.value };
        }
        return {
          name: v.name,
          sku: v.sku,
          price: v.price ?? null,
          weightG: v.weightG ?? null,
          unlisted: v.unlisted,
          amount: vAmount,
          soldQty: vSold.qty,
          soldValue: vSold.value,
        };
      });
      return {
        id: p.id,
        title: p.title,
        sku: p.sku,
        type: p.type,
        forSale: p.forSale,
        unlisted: p.unlisted,
        price: p.price,
        year: p.year,
        material: p.material,
        weightG: p.weightG,
        tariffNo: p.tariffNo,
        originCountry: p.originCountry,
        amount,
        soldQty: sold.qty,
        soldValue: sold.value,
        variants,
      };
    });

  const bm = blob.meta ?? {};
  const meta: CustomsDeMeta = {
    ...defaultCustomsDeMeta(),
    ...bm,
    event: event.name,
    eventDateStart: event.dateStart || bm.eventDateStart || '',
    eventDateEnd: event.dateEnd || bm.eventDateEnd || '',
    eventLocation: bm.eventLocation || event.venue.city || '',
    destinationCountry: bm.destinationCountry || event.venue.country || '',
    // Consignee address defaults to the event's own venue address (Events → venue) -
    // same physical place the goods are shipped to, so it shouldn't need retyping.
    consigneeStreet: bm.consigneeStreet || event.venue.street || '',
    consigneePostcode: bm.consigneePostcode || event.venue.postcode || '',
    consigneeCity: bm.consigneeCity || event.venue.city || '',
    consigneeCountry: bm.consigneeCountry || event.venue.country || '',
    currency: event.currency,
  };

  return {
    meta,
    declarant: { ...defaultCustomsDeDeclarant(), ...(blob.declarant ?? {}) },
    products: customsProducts,
  };
}
