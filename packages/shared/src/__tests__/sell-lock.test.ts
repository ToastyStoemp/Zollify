import { describe, expect, it } from 'vitest';
import { cleanSellLockSettings, sellLockOf } from '../sell-lock';

const ev = (id: string, status: 'planned' | 'active' | 'closed', extra = {}) => ({ id, name: id, status, ...extra });
const carried = (eventId: string, from: string, qty: number) => ({ eventId, carried: { from, qty } });

describe('sellLockOf', () => {
  it('locks only once the taker has opened', () => {
    const claims = [carried('B', 'A', 10)];
    expect(sellLockOf('A', [ev('A', 'active'), ev('B', 'planned')], claims, { allowForce: false })).toBeNull();
    expect(sellLockOf('A', [ev('A', 'active'), ev('B', 'active')], claims, { allowForce: false })?.by.map((e) => e.id)).toEqual(['B']);
    expect(sellLockOf('A', [ev('A', 'active'), ev('B', 'closed')], claims, { allowForce: false })).not.toBeNull();
  });

  it('ignores deleted takers, empty carries and other events', () => {
    expect(sellLockOf('A', [ev('A', 'active'), ev('B', 'active', { deletedAt: 1 })], [carried('B', 'A', 10)], { allowForce: false })).toBeNull();
    expect(sellLockOf('A', [ev('A', 'active'), ev('B', 'active')], [carried('B', 'A', 0)], { allowForce: false })).toBeNull();
    expect(sellLockOf('A', [ev('A', 'active'), ev('B', 'active')], [carried('B', 'C', 5), { eventId: 'B' }], { allowForce: false })).toBeNull();
  });

  it('a force holds only while the account allows forcing', () => {
    const events = [ev('A', 'active', { sellLockForced: true }), ev('B', 'active')];
    const claims = [carried('B', 'A', 10)];
    expect(sellLockOf('A', events, claims, { allowForce: false })?.forced).toBe(false);
    expect(sellLockOf('A', events, claims, { allowForce: true })?.forced).toBe(true);
  });

  it('forcing is off unless switched on', () => {
    expect(cleanSellLockSettings(undefined)).toEqual({ allowForce: false });
    expect(cleanSellLockSettings({ allowForce: 'yes' })).toEqual({ allowForce: false });
    expect(cleanSellLockSettings({ allowForce: true })).toEqual({ allowForce: true });
  });
});
