import { describe, expect, it } from 'vitest';
import { sortEvents, statusOnClose } from '../event-order';

const ev = (name: string, dateStart?: string, dateEnd?: string, status: 'planned' | 'active' | 'closed' = 'planned') => ({ name, dateStart, dateEnd, status });

describe('sortEvents', () => {
  it('puts upcoming first by start date, then the past most recent first', () => {
    const today = '2026-06-15';
    const list = [
      ev('Long ago', '2025-01-01', '2025-01-02'),
      ev('Next month', '2026-07-10'),
      ev('Last week', '2026-06-05', '2026-06-07'),
      ev('Closed but dated ahead', '2026-08-01', undefined, 'closed'),
      ev('This weekend', '2026-06-13', '2026-06-16'),
      ev('Store'),
    ];
    expect(sortEvents(list, today).map((e) => e.name)).toEqual([
      'Store',
      'This weekend',
      'Next month',
      'Closed but dated ahead',
      'Last week',
      'Long ago',
    ]);
  });

  it('breaks ties by name', () => {
    expect(sortEvents([ev('B', '2030-01-01'), ev('A', '2030-01-01')], '2026-01-01').map((e) => e.name)).toEqual(['A', 'B']);
  });
});

describe('statusOnClose', () => {
  const today = '2026-07-26';
  it('closes a convention mid-way (day 2 of 3), so automatic opening leaves it closed', () => {
    expect(statusOnClose({ dateStart: '2026-07-25', dateEnd: '2026-07-27' }, today)).toBe('closed');
  });
  it('closes one that has ended, and one on its only day', () => {
    expect(statusOnClose({ dateStart: '2026-07-20', dateEnd: '2026-07-21' }, today)).toBe('closed');
    expect(statusOnClose({ dateStart: today }, today)).toBe('closed');
  });
  it('parks one that has not started yet back to planned', () => {
    expect(statusOnClose({ dateStart: '2026-08-01', dateEnd: '2026-08-03' }, today)).toBe('planned');
  });
  it('closes one without dates', () => {
    expect(statusOnClose({}, today)).toBe('closed');
  });
});
