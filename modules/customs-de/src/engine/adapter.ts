/**
 * Builds CustomsDeState from live v2 data: event + products + per-event stock
 * + transactions. Brought quantities come from EventStock; sold quantities
 * are derived from non-reverted transactions - never stored, same rule as
 * the Swiss customs module (see customs-ch/src/engine/adapter.ts).
 */
import type { EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';
import type { CustomsDeDeclarant, CustomsDeMeta, CustomsDeProduct, CustomsDeState } from './model';
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

  const customsProducts: CustomsDeProduct[] = [...products]
    .filter((p) => !p.deletedAt)
    .map((p) => {
      // Variant amounts/sales are rolled into the parent line: this module
      // doesn't have a verified per-variant ATLAS layout to justify the
      // extra detail the Swiss engine carries.
      let amount = broughtByKey.get(`${p.id}:`) ?? 0;
      let sold = soldByKey.get(`${p.id}:`) ?? { qty: 0, value: 0 };
      for (const v of p.variants) {
        amount += broughtByKey.get(`${p.id}:${v.id}`) ?? 0;
        const vSold = soldByKey.get(`${p.id}:${v.id}`);
        if (vSold) sold = { qty: sold.qty + vSold.qty, value: sold.value + vSold.value };
      }
      return {
        id: p.id,
        title: p.title,
        sku: p.sku,
        type: p.type,
        unlisted: p.unlisted,
        price: p.price,
        weightG: p.weightG,
        tariffNo: p.tariffNo,
        originCountry: p.originCountry,
        amount,
        soldQty: sold.qty,
        soldValue: sold.value,
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
