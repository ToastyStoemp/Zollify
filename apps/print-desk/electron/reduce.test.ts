import { describe, expect, it } from 'vitest';
import { catalogRows, demandForecast, lastClosedEventSold } from './reduce.js';
import { printParams } from './shared.js';

describe('catalogRows', () => {
  it('reduces products, variants, deletes and inventory with last writer wins', () => {
    const rows = catalogRows([
      { type: 'product.upsert', payload: { id: 'p1', title: 'Old', type: 'Art Print', variants: [], updatedAt: 1 } },
      { type: 'product.upsert', payload: { id: 'p1', title: 'Poster', type: 'Art Print', sku: 'POS', variants: [{ id: 'a', name: 'A3', sku: 'POS-A3' }, { id: 'b', name: 'A4' }], updatedAt: 2 } },
      { type: 'product.upsert', payload: { id: 'p2', title: 'Sticker', type: 'Art Print', variants: [], updatedAt: 1 } },
      { type: 'product.delete', payload: { id: 'p2', deletedAt: 5 } },
      { type: 'inventory.set', payload: { productId: 'p1', variantId: 'a', onHand: 9, updatedAt: 3 } },
      { type: 'inventory.set', payload: { productId: 'p1', variantId: 'a', onHand: 4, updatedAt: 2 } },
    ]);
    expect(rows.map((r) => [r.key, r.title, r.variant, r.sku, r.onHand])).toEqual([
      ['p1:a', 'Poster', 'A3', 'POS-A3', 9],
      ['p1:b', 'Poster', 'A4', 'POS', 0],
    ]);
  });
});

describe('art prints only', () => {
  it('keeps any spelling of Art Print and drops other types and untyped products', () => {
    const product = (id: string, type?: string) => ({ type: 'product.upsert', payload: { id, title: id, type, variants: [], updatedAt: 1 } });
    const rows = catalogRows([product('a', 'Art Print'), product('b', ' art prints '), product('c', 'ArtPrint'), product('d', 'Sticker'), product('e', 'Art Print Frame'), product('f')]);
    expect(rows.map((r) => r.productId)).toEqual(['a', 'b', 'c']);
  });
});

describe('printParams', () => {
  it('keeps the link settings, sets copies and never dry-runs or writes a PDF', () => {
    expect(printParams({ file: 'x.psd', params: { printer: 'Epson', paper: 'a4', output: 'x.pdf', dryRun: true } }, 1200)).toEqual({ printer: 'Epson', paper: 'a4', copies: 999, send: true });
  });
});

describe('lastClosedEventSold', () => {
  const ev = (id: string, dateEnd: string, status = 'closed', extra = {}) => ({ type: 'event.upsert', payload: { id, name: id, status, dateStart: dateEnd, dateEnd, updatedAt: 1, ...extra } });
  const tx = (id: string, eventId: string, items: [string, string | null, number][]) => ({ type: 'tx.create', payload: { id, eventId, items: items.map(([pid, vid, qty]) => ({ pid, vid, qty })) } });

  it('sums the sales of the event that ended last, less reverted ones', () => {
    const r = lastClosedEventSold([
      ev('spring', '2026-04-12'),
      ev('summer', '2026-07-20', 'active'),
      { type: 'event.close', payload: { eventId: 'summer', updatedAt: 2 } },
      ev('shop', '2026-09-01', 'closed', { kind: 'store' }),
      ev('gone', '2026-10-01', 'closed', { deletedAt: 5 }),
      tx('t1', 'summer', [['p1', 'a', 2], ['p2', null, 1]]),
      tx('t2', 'summer', [['p1', 'a', 1]]),
      tx('t3', 'summer', [['p1', 'b', 4]]),
      { type: 'tx.revert', payload: { id: 't3', revertedAt: 3 } },
      tx('t4', 'spring', [['p1', 'a', 9]]),
      tx('t1', 'summer', [['p1', 'a', 50]]), // a replayed tx.create counts once
    ]);
    expect(r).toEqual({ event: { id: 'summer', name: 'summer', dateStart: '2026-07-20', dateEnd: '2026-07-20' }, sold: { 'p1:a': 3, 'p2:': 1 } });
  });
  it('honours ZollTool reverts and ignores open events', () => {
    const r = lastClosedEventSold([ev('a', '2026-01-01'), ev('b', '2026-02-01', 'active'), tx('t', 'a', [['p', 'v', 2]]), { type: 'tx.revert', payload: { txId: 't' } }]);
    expect(r?.event.id).toBe('a');
    expect(r?.sold).toEqual({});
  });
  it('is null without a closed event', () => {
    expect(lastClosedEventSold([ev('a', '2026-01-01', 'planned')])).toBeNull();
  });
});

describe('demandForecast', () => {
  const day = (iso: string, h = 12) => Date.parse(`${iso}T${String(h).padStart(2, '0')}:00:00`);
  const ev = (id: string, start: string, end: string, extra = {}) => ({ type: 'event.upsert', payload: { id, name: id, status: 'closed', dateStart: start, dateEnd: end, updatedAt: 1, ...extra } });
  const tx = (id: string, eventId: string, at: number, items: [string, string | null, number][]) => ({ type: 'tx.create', payload: { id, eventId, timestamp: at, items: items.map(([pid, vid, qty]) => ({ pid, vid, qty })) } });
  const ops = [
    { type: 'product.upsert', payload: { id: 'kyoto', title: 'Kyoto', price: 25, variants: [{ id: 'a3', name: 'A3', price: 35 }, { id: 'a4', name: 'A4' }], updatedAt: 1 } },
    ev('fair-2025', '2025-11-08', '2025-11-09', { seriesId: 'fair' }),
    ev('market', '2026-06-06', '2026-06-06'),
    ev('shop', '2026-01-01', '2026-12-31', { kind: 'store' }),
    ev('fair-2026', '2026-11-07', '2026-11-09', { seriesId: 'fair', status: 'planned' }),
    tx('t1', 'fair-2025', day('2025-11-08'), [['kyoto', 'a3', 6], ['kyoto', 'a4', 2]]),
    tx('t2', 'market', day('2026-06-06'), [['kyoto', 'a3', 1]]),
    tx('t3', 'shop', day('2026-03-01'), [['kyoto', 'a3', 50]]),
    tx('t4', 'market', day('2026-06-06', 15), [['kyoto', 'a4', 1]]),
    { type: 'tx.revert', payload: { id: 't4' } },
  ];
  it('rates each item per event day over the last year, stores and reverted sales left out', () => {
    const f = demandForecast(ops, '2026-10-29');
    // Event days in the year: fair-2025 2 + market 1 = 3. Kyoto A3 sold 6 + 1, A4 2.
    expect(f.perDay['kyoto:a3']).toBeCloseTo(7 / 3, 6);
    expect(f.perDay['kyoto:a4']).toBeCloseTo(2 / 3, 6);
    expect(f.price).toEqual({ 'kyoto:a3': 35, 'kyoto:a4': 25 });
  });
  it('plans for the next event, scaled by how its earlier editions sold', () => {
    const f = demandForecast(ops, '2026-10-29');
    // Average 9 units / 3 days = 3; the fair's last edition 8 / 2 = 4: factor 1.33 over 3 days.
    expect(f.event).toEqual({ name: 'fair-2026', days: 3, factor: 1.33 });
    expect(f.horizonDays).toBeCloseTo(3.99, 6);
  });
  it('plans for an average event when none is coming', () => {
    const f = demandForecast(ops.filter((o) => (o.payload as { id?: string }).id !== 'fair-2026'), '2026-10-29');
    expect(f.event).toBeNull();
    expect(f.horizonDays).toBeCloseTo(1.5, 6);
  });
});
