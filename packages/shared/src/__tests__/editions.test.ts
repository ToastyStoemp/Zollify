import { describe, expect, it } from 'vitest';
import { capToFree, editionLabelOf, planClaims, seriesEditions, suggestEditionLabels, type PlanEdition } from '../editions';

describe('edition labels', () => {
  it('reads the label, falling back to the start year', () => {
    expect(editionLabelOf({ edition: ' Spring 2026 ' })).toBe('Spring 2026');
    expect(editionLabelOf({ dateStart: '2026-05-01' })).toBe('2026');
    expect(editionLabelOf({})).toBe('');
  });

  it('moves a year on, or to the picked start date', () => {
    expect(suggestEditionLabels({ edition: '2026' })).toEqual(['2027']);
    expect(suggestEditionLabels({ dateStart: '2026-05-01' })).toEqual(['2027']);
    expect(suggestEditionLabels({ dateStart: '2026-05-01' }, '2028-05-01')).toEqual(['2028']);
    expect(suggestEditionLabels({})).toEqual([]);
  });

  it('keeps a season and offers the opposite one', () => {
    expect(suggestEditionLabels({ edition: 'Spring 2026' })).toEqual(['Spring 2027', 'Fall 2026']);
    expect(suggestEditionLabels({ edition: 'autumn 2026' }, '2027-10-01')).toEqual(['Autumn 2027', 'Spring 2027']);
  });
});

describe('seriesEditions', () => {
  it('lists one series oldest first, undated last', () => {
    const ev = (name: string, seriesId: string, dateStart?: string) => ({ name, seriesId, dateStart });
    const list = seriesEditions([ev('c', 's'), ev('b', 's', '2027-01-01'), ev('x', 'other', '2020-01-01'), ev('a', 's', '2026-01-01')], 's');
    expect(list.map((e) => e.name)).toEqual(['a', 'b', 'c']);
    expect(seriesEditions([ev('a', 's')], undefined)).toEqual([]);
  });
});

const T = (day: number, hour: number) => Date.UTC(2026, 4, day, hour);
const sale = (at: number, productId: string, qty: number, revenue = qty * 10, variantId: string | null = null) => ({ at, items: [{ productId, variantId, qty, revenue }] });

describe('planClaims', () => {
  const y1: PlanEdition = {
    eventId: 'e1',
    label: '2025',
    claims: { 'print:': 10, 'tote:blk': 20 },
    sales: [sale(T(2, 10), 'print', 4), sale(T(3, 12), 'print', 6), sale(T(3, 15), 'tote', 5, 50, 'blk')],
  };
  const y2: PlanEdition = {
    eventId: 'e2',
    label: '2026',
    claims: { 'print:': 20 },
    sales: [sale(T(2, 10), 'print', 8), sale(T(3, 10), 'print', 2)],
  };

  it('reports units, revenue, sell-through and when a claim ran out', () => {
    const rows = planClaims([y1, y2], { bufferPct: 0, basis: 'average' });
    const print = rows.find((r) => r.key === 'print:')!;
    expect(print.editions[0]).toMatchObject({ units: 10, revenue: 100, claimed: 10, sellThrough: 1, soldOut: true, soldOutAt: T(3, 12) });
    expect(print.editions[1]).toMatchObject({ units: 10, claimed: 20, sellThrough: 0.5, soldOut: false });
    expect(print.editions[1]!.soldOutAt).toBeUndefined();
    expect(print.underClaimed).toBe(true);
  });

  it('suggests the average or the max plus the buffer, rounded up', () => {
    const avg = planClaims([y1, y2], { bufferPct: 10, basis: 'average' });
    expect(avg.find((r) => r.key === 'print:')!.suggested).toBe(11);
    const best = planClaims([y1, { ...y2, sales: [sale(T(2, 10), 'print', 14)] }], { bufferPct: 10, basis: 'max' });
    expect(best.find((r) => r.key === 'print:')!.suggested).toBe(16);
  });

  it('keeps variants apart and treats an unclaimed sale as no sell-through', () => {
    const rows = planClaims([{ eventId: 'e', label: 'x', claims: {}, sales: [sale(T(1, 9), 'tote', 3, 30, 'nat')] }], { bufferPct: 0, basis: 'average' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'tote:nat', suggested: 3, underClaimed: false });
    expect(rows[0]!.editions[0]).toMatchObject({ claimed: null, sellThrough: null, soldOut: false });
  });

  it('only averages editions that touched the item, and ignores a negative buffer', () => {
    const rows = planClaims([y1, y2], { bufferPct: -50, basis: 'average' });
    expect(rows.find((r) => r.key === 'tote:blk')!.suggested).toBe(5);
  });

  it('records a claim that sold nothing', () => {
    const [row] = planClaims([{ eventId: 'e', label: 'x', claims: { 'a:': 5 }, sales: [] }], { bufferPct: 20, basis: 'max' });
    expect(row).toMatchObject({ suggested: 0, underClaimed: false });
    expect(row!.editions[0]).toMatchObject({ units: 0, sellThrough: 0 });
  });
});

describe('capToFree', () => {
  it('caps at what is free and says what is short', () => {
    const rows = [
      { key: 'a:', productId: 'a', variantId: '', suggested: 10 },
      { key: 'b:x', productId: 'b', variantId: 'x', suggested: 4 },
      { key: 'c:', productId: 'c', variantId: '', suggested: 3 },
    ];
    expect(capToFree(rows, { 'a:': 6, 'b:x': 9 }).map((g) => [g.granted, g.short])).toEqual([[6, 4], [4, 0], [0, 3]]);
  });
});
