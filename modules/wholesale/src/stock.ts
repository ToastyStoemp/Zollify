import type { SaleEvent } from '@zollify/sdk';
import { orderTotals, reservedByItem, resolveEventVat, saleTaxFor, type SalesEvent, type WholesaleOrder } from '@zollify/shared';
import { sdk } from './runtime';

/**
 * Where wholesale meets the one inventory. The account's "Wholesale" store
 * is an ordinary store-kind event the module makes once: open orders claim
 * their units on it, and a shipment is recorded as a sale there - stock,
 * revenue, the books and the reports then follow as for any store.
 */

const EVENT_KEY = 'wholesale.eventId';

/** The Wholesale store, made on first use. */
export async function wholesaleEvent(): Promise<SalesEvent> {
  const s = sdk();
  const stored = await s.data.settings.get<string>(EVENT_KEY);
  const existing = stored ? s.data.events.get(stored) : undefined;
  if (existing && !existing.deletedAt) return existing;
  const byName = s.data.events.list().find((e) => e.kind === 'store' && e.name === 'Wholesale' && !e.deletedAt);
  if (byName) {
    await s.data.settings.set(EVENT_KEY, byName.id);
    return byName;
  }
  const home = s.account()?.profile.artist.countryOfOrigin ?? '';
  const event: SalesEvent = {
    id: crypto.randomUUID(),
    name: 'Wholesale',
    kind: 'store',
    venue: home ? { country: home } : {},
    currency: s.account()?.profile.defaultCurrency ?? 'EUR',
    status: 'active',
    updatedAt: Date.now(),
    noPool: true,
  };
  await s.data.events.upsert(event);
  await s.data.settings.set(EVENT_KEY, event.id);
  return event;
}

/**
 * Makes the Wholesale store's claims match the open orders: one claim per
 * item for the units promised, cleared where nothing is promised any more.
 */
export async function syncClaims(orders: WholesaleOrder[]): Promise<void> {
  const s = sdk();
  const event = await wholesaleEvent();
  const wanted = reservedByItem(orders);
  const current = await s.data.events.stock(event.id);
  for (const row of current) {
    const key = `${row.productId}:${row.variantId || ''}`;
    if (!wanted.has(key)) await s.data.inventory.clearClaim(event.id, row.productId, row.variantId || null);
  }
  for (const [key, qty] of wanted) {
    const [productId, variantId] = key.split(':') as [string, string];
    const have = current.find((r) => r.productId === productId && (r.variantId || '') === variantId)?.broughtQty;
    if (have !== qty) await s.data.inventory.claim(event.id, productId, variantId || null, qty);
  }
}

/**
 * Records a shipment as a sale at the Wholesale store: the order's lines at
 * their trade prices, paid "on invoice". Returns the sale id for the order.
 */
export function recordShipment(order: WholesaleOrder): string {
  const s = sdk();
  const stored = s.data.events.list().find((e) => e.kind === 'store' && e.name === 'Wholesale' && !e.deletedAt);
  const totals = orderTotals(order.lines);
  const lines = order.lines.map((l) => ({
    productId: l.productId,
    variantId: l.variantId,
    sku: l.sku || null,
    name: l.variantLabel ? `${l.title} · ${l.variantLabel}` : l.title,
    qty: l.qty,
    unitPrice: l.unitPrice,
    lineTotal: Math.round(l.unitPrice * 100 * l.qty) / 100,
    taxRate: null as number | null,
  }));
  // VAT as the Wholesale store charges it: the account's own country's rates.
  // Reverse charge for a VAT-registered customer abroad is the invoice's business, not the till's.
  const resolved = stored ? resolveEventVat(stored, s.account()?.profile) : null;
  const tax = resolved && (resolved.exempt || resolved.standard != null) ? saleTaxFor(resolved, lines.map((l) => s.data.products.get(l.productId)?.taxClass)) : undefined;
  const sale: SaleEvent = {
    saleId: crypto.randomUUID(),
    eventId: stored?.id ?? null,
    at: Date.now(),
    currency: order.currency,
    total: totals.total,
    lines: lines.map((l, i) => ({ ...l, taxRate: tax?.rates[i] ?? null })),
    ...(tax ? { tax } : {}),
    payment: { provider: 'manual', approved: true, method: 'invoice' },
  };
  s.events.emit('sale', sale);
  return sale.saleId;
}
