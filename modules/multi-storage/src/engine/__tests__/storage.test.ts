import { describe, expect, it } from 'vitest';
import {
  allocationKey,
  cleanLocation,
  indexAllocations,
  liveLocations,
  locationAt,
  locationSales,
  pickOrder,
  pickPlan,
  planMove,
  storageRows,
  withPick,
  type Allocation,
  type DeviceHome,
  type SaleRecord,
  type StorageLocation,
} from '../storage';

const loc = (id: string, order: number, extra: Partial<StorageLocation> = {}): StorageLocation => ({ id, name: id, order, updatedAt: 1, ...extra });
const alloc = (locationId: string, qty: number, updatedAt = 1, productId = 'p', variantId = ''): Allocation => ({ locationId, productId, variantId, qty, updatedAt });
const sale = (deviceId: string, timestamp: number, qty: number, extra: Partial<SaleRecord> = {}): SaleRecord => ({
  eventId: 'con',
  deviceId,
  timestamp,
  items: [{ pid: 'p', vid: null, qty }],
  ...extra,
});
const home = (deviceId: string, ...history: [string | null, number][]): [string, DeviceHome] => [
  deviceId,
  { deviceId, history: history.map(([locationId, from]) => ({ locationId, from })), updatedAt: 1 },
];

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
    // Under team., so staff can write them.
    expect(allocationKey('unit', 'p1', null)).toBe('team.multi-storage.alloc.unit|p1:');
    expect(allocationKey('unit', 'p1', 'v2')).toBe('team.multi-storage.alloc.unit|p1:v2');
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

describe('selling from a device location', () => {
  const live = new Set(['unit', 'van']);
  const noClaims = (_eventId: string, _key: string): number | null => null;
  const entries = [{ productId: 'p', variantId: '', label: 'Print' }];
  const rowFor = (remaining: number, sales: SaleRecord[], homes: [string, DeviceHome][], allocs: Allocation[], hasClaim = noClaims) =>
    storageRows(entries, {
      remaining: () => remaining,
      atStores: () => 0,
      allocations: indexAllocations(allocs, live),
      sales: locationSales(sales, new Map(homes), live, hasClaim),
    })[0]!;

  it('takes an unclaimed sale out of the device location, never Home', () => {
    // 50 counted, 20 of them in the van; the van device sold 3.
    const row = rowFor(47, [sale('tablet', 10, 3)], [home('tablet', ['van', 5])], [alloc('van', 20, 1)]);
    expect(row.stored.get('van')).toBe(17);
    expect(row.home).toBe(30);
  });

  it('falls back to Home for a device that picked nothing', () => {
    const row = rowFor(47, [sale('phone', 10, 3)], [], [alloc('van', 20, 1)]);
    expect(row.stored.get('van')).toBe(20);
    expect(row.home).toBe(27);
  });

  it('charges each sale to the pick in force when it was made', () => {
    const homes = [home('tablet', ['van', 5], [null, 20], ['unit', 30])];
    const sales = [sale('tablet', 10, 1), sale('tablet', 25, 2), sale('tablet', 35, 4)];
    const row = rowFor(93, sales, homes, [alloc('van', 10, 1), alloc('unit', 40, 1)]);
    expect(row.stored.get('van')).toBe(9);
    expect(row.stored.get('unit')).toBe(36);
    expect(row.home).toBe(48);
  });

  it('leaves out sales a count already reflects, reverted sales and what a claim covered', () => {
    const sales = [sale('tablet', 10, 2), sale('tablet', 30, 1, { revertedAt: 31 }), sale('tablet', 40, 5, { eventId: 'claimed' })];
    const row = rowFor(100, sales, [home('tablet', ['van', 0])], [alloc('van', 20, 15)], (eventId: string) => (eventId === 'claimed' ? 5 : null));
    expect(row.stored.get('van')).toBe(20);
  });

  it('takes sales past a claim off the location: claim 5, 8 sold, the last 3 came from the van', () => {
    const sales = [sale('tablet', 10, 4, { eventId: 'con' }), sale('tablet', 20, 4, { eventId: 'con' })];
    const row = rowFor(92, sales, [home('tablet', ['van', 0])], [alloc('van', 20, 1)], (eventId: string) => (eventId === 'con' ? 5 : null));
    expect(row.stored.get('van')).toBe(17);
  });

  it('a claim of 0 covers nothing', () => {
    const row = rowFor(98, [sale('tablet', 10, 2, { eventId: 'con' })], [home('tablet', ['van', 0])], [alloc('van', 20, 1)], () => 0);
    expect(row.stored.get('van')).toBe(18);
  });

  it('can go negative, which the screen flags', () => {
    const row = rowFor(45, [sale('tablet', 10, 5)], [home('tablet', ['van', 0])], [alloc('van', 2, 1)]);
    expect(row.stored.get('van')).toBe(-3);
  });

  it('sends sales of a removed location back to Home', () => {
    const row = rowFor(45, [sale('tablet', 10, 5)], [home('tablet', ['shed', 0])], []);
    expect(row.stored.size).toBe(0);
    expect(row.home).toBe(45);
  });

  it('keeps the pick history and ignores a pick that changes nothing', () => {
    const first = withPick(undefined, 'd', 'van', 10);
    expect(first.history).toEqual([{ locationId: 'van', from: 10 }]);
    expect(withPick(first, 'd', 'van', 20)).toBe(first);
    const back = withPick(first, 'd', null, 30);
    expect(locationAt(back.history, 15)).toBe('van');
    expect(locationAt(back.history, 30)).toBeNull();
    expect(locationAt(back.history, 5)).toBeNull();
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

  it('fetches from the device place first, then Home, then the rest', () => {
    expect(pickOrder('unit', ['studio', 'unit'])).toEqual(['unit', null, 'studio']);
    expect(pickOrder(null, ['studio', 'unit'])).toEqual([null, 'studio', 'unit']);
  });

  it('takes places in that order', () => {
    expect(pickPlan(25, row, [null, 'studio', 'unit'])).toEqual({
      steps: [{ locationId: null, qty: 10 }, { locationId: 'studio', qty: 5 }, { locationId: 'unit', qty: 10 }],
      short: 0,
    });
  });

  it('needs no trip when home has enough', () => {
    expect(pickPlan(4, row, [null, 'unit'])).toEqual({ steps: [{ locationId: null, qty: 4 }], short: 0 });
  });

  it('reports what nobody has', () => {
    expect(pickPlan(50, row, [null, 'unit', 'studio']).short).toBe(5);
    expect(pickPlan(3, { home: -2, stored: new Map() }, [null]).short).toBe(3);
  });
});
