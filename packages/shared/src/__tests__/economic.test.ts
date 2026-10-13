import { describe, expect, it } from 'vitest';
import type { Transaction, TxItem } from '../types';
import { EconomicSettingsSchema, dayJournal } from '../economic';

const DAY = '2026-10-12';
const NOON = Date.parse('2026-10-12T10:00:00Z');
const NEXT = Date.parse('2026-10-13T10:00:00Z');

const item = (pid: string, lineTotal: number, consignorId?: string): TxItem => ({
  pid,
  vid: null,
  title: pid,
  qty: 1,
  unitPrice: lineTotal,
  lineTotal,
  ...(consignorId ? { consignorId } : {}),
});
const tx = (id: string, items: TxItem[], extra: Partial<Transaction> = {}): Transaction => ({
  id,
  eventId: 'shop',
  deviceId: 'd',
  timestamp: NOON,
  method: 'card',
  payments: [],
  items,
  discounts: [],
  total: items.reduce((s, i) => s + i.lineTotal, 0),
  currency: 'DKK',
  tax: { country: 'DK', exempt: false, rates: items.map(() => 25) },
  ...extra,
});

const settings = EconomicSettingsSchema.parse({ accounts: { sales: 1010, commission: 1020, renters: 6800, cash: 5800, card: 5810 } });
const renters = [{ id: 'mia', name: 'Mia', commissionPct: 20, storeCommission: {} }];
const sum = (lines: { amount: number }[]) => Math.round(lines.reduce((s, l) => s + l.amount * 100, 0));
const line = (j: ReturnType<typeof dayJournal>, key: string) => j.lines.find((l) => l.key === key);

describe('e-conomic day journal', () => {
  it('books own goods with VAT, renters as agent, and takings by kind - and balances', () => {
    const j = dayJournal(
      [
        tx('a', [item('mug', 100), item('vase', 250, 'mia')]),
        tx('b', [item('lamp', 80, 'mia')], { method: 'split', payments: [{ kind: 'cash', amount: 50 }, { kind: 'card', amount: 30 }] }),
      ],
      renters,
      DAY,
      settings,
    );
    expect(j.problems).toEqual([]);
    expect(sum(j.lines)).toBe(0);
    expect(line(j, 'sales')).toMatchObject({ account: 1010, amount: -100, vatCode: 'U25' });
    // 20% of 330 is the store's, with VAT; the rest is owed to Mia, without.
    expect(line(j, 'commission')).toMatchObject({ amount: -66, vatCode: 'U25' });
    expect(line(j, 'renters')).toMatchObject({ amount: -264 });
    expect(line(j, 'renters')!.vatCode).toBeUndefined();
    expect(line(j, 'cash')!.amount).toBe(50);
    expect(line(j, 'card')!.amount).toBe(380);
    expect(j.total).toBe(430);
  });

  it('books renters\' goods as own sales in a commission sale', () => {
    const j = dayJournal([tx('a', [item('vase', 250, 'mia')])], renters, DAY, { ...settings, consignment: 'commission' });
    expect(line(j, 'sales')!.amount).toBe(-250);
    expect(line(j, 'commission')).toBeUndefined();
  });

  it('keeps a reverted sale on its day and books it back on the day of the revert', () => {
    const sale = tx('a', [item('mug', 100)], { revertedAt: NEXT, revertedBy: 'op' });
    expect(line(dayJournal([sale], renters, DAY, settings), 'sales')!.amount).toBe(-100);
    const back = dayJournal([sale], renters, '2026-10-13', settings);
    expect(back.reversals).toBe(1);
    expect(line(back, 'sales')!.amount).toBe(100);
    expect(line(back, 'card')!.amount).toBe(-100);
    // Made and reverted the same day: nothing to book.
    expect(dayJournal([{ ...sale, revertedAt: NOON + 1 }], renters, DAY, settings).lines).toEqual([]);
  });

  it('dates by Copenhagen, not UTC', () => {
    const late = tx('a', [item('mug', 100)], { timestamp: Date.parse('2026-10-12T22:30:00Z') });
    expect(dayJournal([late], renters, '2026-10-13', settings).sales).toBe(1);
  });

  it('refuses what it cannot book right', () => {
    const j = dayJournal(
      [tx('a', [item('book', 100)], { tax: { country: 'DK', exempt: false, rates: [12] } }), tx('b', [item('x', 10, 'gone')]), tx('c', [item('y', 5)], { tax: undefined })],
      renters,
      DAY,
      { ...settings, accounts: { ...settings.accounts, card: null } },
    );
    expect(j.problems.join(' ')).toMatch(/VAT code set for 12%/);
    expect(j.problems.join(' ')).toMatch(/no longer listed/);
    expect(j.problems.join(' ')).toMatch(/no VAT recorded/);
    expect(j.problems.join(' ')).toMatch(/account for "Kort"/);
  });
});
