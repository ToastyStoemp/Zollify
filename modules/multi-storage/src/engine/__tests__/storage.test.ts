import { describe, expect, it } from 'vitest';
import {
  allocationKey,
  cleanLocation,
  indexAllocations,
  liveLocations,
  pickPlan,
  planMove,
  storageRows,
  type Allocation,
  type StorageLocation,
} from '../storage';

const loc = (id: string, order: number, extra: Partial<StorageLocation> = {}): StorageLocation => ({ id, name: id, order, updatedAt: 1, ...extra });
const alloc = (locationId: string, qty: number, productId = 'p', variantId = ''): Allocation => ({ locationId, productId, variantId, qty, updatedAt: 1 });

describe('locations', () => {
  it('leaves removed ones out and keeps their order', () => {
    const rows = [loc('b', 2), loc('a', 1), loc('gone', 0, { deletedAt: 5 })];
    expect(liveLocations(rows).map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('cleans names and refuses empty ones', () => {
    expect(cleanLocation({ name: '  Storage   unit ', address: ' ', note: 'Gate 4' })).toEqual({ name: 'Storage unit', address: undefined, note: 'Gate 4' });
    expect(() => cleanLocation({ name: '  ' })).toThrow(/name/);
  });

  it('keys each allocation by location and item', () => {
    expect(allocationKey('unit', 'p1', null)).toBe('multi-storage.alloc.unit|p1:');
    expect(allocationKey('unit', 'p1', 'v2')).toBe('multi-storage.alloc.unit|p1:v2');
  });
});

describe('stock by place', () => {
  const entries = [{ productId: 'p', variantId: '', label: 'Print' }];

  it('puts everything not in storage or at a store at home', () => {
    const allocations = indexAllocations([alloc('unit', 30), alloc('studio', 5)], new Set(['unit', 'studio']));
    const [row] = storageRows(entries, { remaining: () => 50, atStores: () => 4, allocations });
    expect(row!.storedTotal).toBe(35);
    expect(row!.home).toBe(11);
  });

  it('ignores removed locations and empty rows', () => {
    const allocations = indexAllocations([alloc('unit', 30), alloc('gone', 9), alloc('studio', 0)], new Set(['unit', 'studio']));
    const [row] = storageRows(entries, { remaining: () => 50, atStores: () => 0, allocations });
    expect([...row!.stored]).toEqual([['unit', 30]]);
  });

  it('goes negative when more is allocated than exists', () => {
    const allocations = indexAllocations([alloc('unit', 30)], new Set(['unit']));
    const [row] = storageRows(entries, { remaining: () => 20, atStores: () => 0, allocations });
    expect(row!.home).toBe(-10);
  });
});

describe('moving stock', () => {
  const row = { home: 10, stored: new Map([['unit', 30]]) };

  it('from storage home only lowers the location', () => {
    const plan = planMove(row, { kind: 'location', id: 'unit' }, { kind: 'home' }, 12);
    expect([...plan.allocations]).toEqual([['unit', 18]]);
    expect(plan.pileDelta).toBe(0);
  });

  it('between locations moves both sides', () => {
    const plan = planMove(row, { kind: 'location', id: 'unit' }, { kind: 'location', id: 'studio' }, 5);
    expect(Object.fromEntries(plan.allocations)).toEqual({ unit: 25, studio: 5 });
  });

  it('new stock raises the pile, gone stock lowers it', () => {
    expect(planMove(row, { kind: 'new' }, { kind: 'location', id: 'unit' }, 100)).toEqual({ allocations: new Map([['unit', 130]]), pileDelta: 100 });
    expect(planMove(row, { kind: 'home' }, { kind: 'gone' }, 2).pileDelta).toBe(-2);
  });

  it('refuses more than the place holds', () => {
    expect(() => planMove(row, { kind: 'location', id: 'unit' }, { kind: 'home' }, 31)).toThrow(/Only 30/);
    expect(() => planMove(row, { kind: 'home' }, { kind: 'location', id: 'unit' }, 11)).toThrow(/Only 10/);
    expect(() => planMove({ home: -3, stored: new Map() }, { kind: 'home' }, { kind: 'gone' }, 1)).toThrow(/Only 0/);
  });

  it('refuses nonsense', () => {
    expect(() => planMove(row, { kind: 'home' }, { kind: 'home' }, 1)).toThrow();
    expect(() => planMove(row, { kind: 'home' }, { kind: 'new' }, 1)).toThrow();
    expect(() => planMove(row, { kind: 'new' }, { kind: 'gone' }, 1)).toThrow();
    expect(() => planMove(row, { kind: 'location', id: 'unit' }, { kind: 'home' }, 1.5)).toThrow();
    expect(() => planMove(row, { kind: 'location', id: 'unit' }, { kind: 'home' }, 0)).toThrow();
  });
});

describe('pick list', () => {
  const row = { home: 10, stored: new Map([['unit', 30], ['studio', 5]]) };

  it('takes from home first, then storage in order', () => {
    expect(pickPlan(25, row, ['studio', 'unit'])).toEqual({
      steps: [{ locationId: null, qty: 10 }, { locationId: 'studio', qty: 5 }, { locationId: 'unit', qty: 10 }],
      short: 0,
    });
  });

  it('needs no trip when home has enough', () => {
    expect(pickPlan(4, row, ['unit'])).toEqual({ steps: [{ locationId: null, qty: 4 }], short: 0 });
  });

  it('reports what nobody has', () => {
    expect(pickPlan(50, row, ['unit', 'studio']).short).toBe(5);
    expect(pickPlan(3, { home: -2, stored: new Map() }, []).short).toBe(3);
  });
});
