import { describe, expect, it } from 'vitest';
import type { EventStock, SalesEvent, Transaction } from '@zollify/shared';
import type { Dossier, Reorder } from '../engine';
import { forecast, forecastItems, incomingByDossier, perDay, salesHistory, sizeFactor, upcomingEvents } from '../forecast';

const ev = (id: string, name: string, dateStart: string, dateEnd: string, extra: Partial<SalesEvent> = {}): SalesEvent =>
  ({ id, name, dateStart, dateEnd, status: 'closed', venue: {}, currency: 'EUR', updatedAt: 0, ...extra }) as SalesEvent;
const sale = (eventId: string, day: string, pid: string, vid: string | null, qty: number): Transaction => ({
  id: `${eventId}${day}${pid}${vid}${qty}`, eventId, deviceId: 'd', timestamp: Date.parse(`${day}T12:00:00`), method: 'cash', payments: [], discounts: [], total: qty, currency: 'EUR',
  items: [{ pid, vid, title: pid, qty, unitPrice: 1, lineTotal: qty }],
});
const dossier = (id: string, pid: string, vid: string | null, moq = ''): Dossier => ({
  id, pid, vid, title: id, supplierId: 's', specs: { moq }, lastUnitPrice: null, currency: 'EUR', targetCoverMonths: null, recipe: [],
});

// Two-day show sold 20 prints, one-day show sold 10: 30 over 3 days, 10 a day.
const events = [
  ev('a24', 'Comic Con 2024', '2024-05-04', '2024-05-05', { seriesId: 'cc' }),
  ev('b24', 'Small Fair', '2024-06-01', '2024-06-01'),
  ev('shop', 'Shop', '2024-01-01', '2024-12-31', { kind: 'store' }),
  ev('a25', 'Comic Con 2025', '2099-05-03', '2099-05-04', { seriesId: 'cc', status: 'planned' }),
];
const txs = [sale('a24', '2024-05-04', 'print', null, 12), sale('a24', '2024-05-05', 'print', null, 8), sale('b24', '2024-06-01', 'print', null, 10), sale('shop', '2024-03-01', 'print', null, 500)];

describe('forecast', () => {
  it('rates per event day and leaves stores out', () => {
    const h = salesHistory(events, txs);
    expect(h.days).toBe(3);
    expect(h.units).toBe(30);
    expect(h.byKey.get('print:')).toBe(30);
  });

  it('counts a day with no sales when the dates say the booth was there', () => {
    const h = salesHistory(events, [sale('a24', '2024-05-04', 'print', null, 20)]);
    expect(h.events.get('a24')).toMatchObject({ days: 2, units: 20 });
  });

  it('sizes an event from its earlier editions against the average', () => {
    // Comic Con sold 10 a day, the average is 10 a day: an average show.
    const h = salesHistory(events, txs);
    expect(sizeFactor(events[3]!, events, h)).toEqual({ factor: 1, editions: 1 });
    // Make Comic Con twice as busy per day as the fair.
    const busy = salesHistory(events, [sale('a24', '2024-05-04', 'print', null, 40), sale('b24', '2024-06-01', 'print', null, 10)]);
    expect(sizeFactor(events[3]!, events, busy).factor).toBe(1.2); // 20/day vs 50 over 3 days
  });

  it('lists only upcoming shows', () => {
    expect(upcomingEvents(events, '2026-01-01').map((e) => e.id)).toEqual(['a25']);
  });

  it('suggests expected plus buffer less on hand and on order, up to the MOQ', () => {
    const h = salesHistory(events, txs);
    const items = forecastItems([{ id: 'print', title: 'Print', variants: [] }], [dossier('d', 'print', null, '50')]);
    const reorders = [{ status: 'quoted', lines: [{ dossierId: 'd', qty: 5 }] }, { status: 'received', lines: [{ dossierId: 'd', qty: 99 }] }] as Reorder[];
    const [row] = forecast(items, h, [{ eventId: 'a25', name: 'CC', days: 2, factor: 1.5 }], { bufferPct: 10, onHand: () => 3, incoming: incomingByDossier(reorders) });
    // 10/day × 2 days × 1.5 = 30, +10% = 33, less 3 on hand and 5 coming = 25, MOQ 50.
    expect(row).toMatchObject({ perDay: 10, expected: 30, incoming: 5, suggestQty: 50 });
  });

  it('a product-level dossier is one row for all variants', () => {
    const products = [{ id: 'p', title: 'Pin', variants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }];
    expect(forecastItems(products, [dossier('d', 'p', null)]).map((i) => i.key)).toEqual(['p:']);
    expect(forecastItems(products, [dossier('d', 'p', 'a')]).map((i) => [i.key, i.dossier?.id ?? null])).toEqual([['p:a', 'd'], ['p:b', null]]);
  });

  it('an item that sold out stops counting days once it is gone', () => {
    const stock: EventStock[] = [
      { eventId: 'a24', productId: 'print', variantId: '', broughtQty: 10, updatedAt: 0 },
      { eventId: 'a24', productId: 'pen', variantId: '', broughtQty: 100, updatedAt: 0 },
    ];
    const sales = [
      sale('a24', '2024-05-04', 'print', null, 10), // gone on day 1 of 2
      sale('a24', '2024-05-04', 'pen', null, 5),
      sale('a24', '2024-05-05', 'pen', null, 5),
    ];
    const h = salesHistory([events[0]!], sales, 0, new Map([['a24', stock]]));
    expect(perDay(h, 'print:')).toBe(10); // 10 units on sale for 1 day, not 5 over 2
    expect(perDay(h, 'pen:')).toBe(5); // on sale both days, never ran out
  });

  it('an item not brought to an event adds no days for it', () => {
    const stock: EventStock[] = [{ eventId: 'a24', productId: 'pen', variantId: '', broughtQty: 100, updatedAt: 0 }];
    const h = salesHistory([events[0]!], [sale('a24', '2024-05-04', 'pen', null, 10), sale('a24', '2024-05-05', 'pen', null, 10)], 0, new Map([['a24', stock]]));
    expect(perDay(h, 'pen:')).toBe(10); // 20 units over 2 days on sale
    expect(perDay(h, 'print:')).toBe(0);
  });
});
