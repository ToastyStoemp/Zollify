import { describe, expect, it } from 'vitest';
import { tillEventCheck } from '../event-order';

const TODAY = '2026-10-14';
const narcon = { id: 'n', name: 'Narcon', status: 'active' as const, dateStart: '2026-07-23', dateEnd: '2026-07-25' };
const asia = { id: 'a', name: 'Made in Asia', status: 'planned' as const, dateStart: '2026-10-14', dateEnd: '2026-10-15' };

describe('tillEventCheck', () => {
  it('flags a till still on an event that ended, and finds the one running today', () => {
    expect(tillEventCheck(narcon, [narcon, asia], TODAY)).toEqual({ ended: true, endedOn: '2026-07-25', runningToday: asia });
  });

  it('is quiet for an event under way, or a store still open', () => {
    expect(tillEventCheck(asia, [narcon, asia], TODAY).ended).toBe(false);
    expect(tillEventCheck({ ...narcon, kind: 'store' as const }, [], TODAY).ended).toBe(false);
  });

  it('flags a till still on an event or store someone closed', () => {
    expect(tillEventCheck({ ...narcon, status: 'closed' as const }, [], TODAY).ended).toBe(true);
    expect(tillEventCheck({ ...narcon, kind: 'store' as const, status: 'closed' as const }, [], TODAY).ended).toBe(true);
  });

  it('never offers a closed or deleted event as today\'s', () => {
    expect(tillEventCheck(narcon, [{ ...asia, status: 'closed' as const }], TODAY).runningToday).toBeNull();
    expect(tillEventCheck(narcon, [{ ...asia, deletedAt: 1 }], TODAY).runningToday).toBeNull();
  });
});
