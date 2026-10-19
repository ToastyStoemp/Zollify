import { describe, expect, it } from 'vitest';
import { catalogRows, lastClosedEventSold } from './reduce.js';
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
