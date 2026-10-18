import { describe, expect, it } from 'vitest';
import { TaxDeadlineSettingsSchema } from '@zollify/shared';
import { groupDeadlines } from '../list';

describe('groupDeadlines', () => {
  const settings = TaxDeadlineSettingsSchema.parse({ profile: { country: 'DE', vatFrequency: 'monthly', tradeTax: false } });

  it('sorts open deadlines into missed, the next month and later', () => {
    const g = groupDeadlines(settings, new Set(), '2026-10-01');
    expect(g.overdue.map((d) => d.id)).toContain('de.vat-return:2026-08'); // due 10 Sep
    expect(g.soon.map((d) => d.id)).toEqual(['de.vat-return:2026-09']); // due 12 Oct
    expect(g.later[0]!.id).toBe('de.vat-return:2026-10');
    expect(g.done).toEqual([]);
  });

  it('never lists a deadline from before the account as missed', () => {
    // Signed up 1 October: the August return (due 10 September) was never this account's.
    const g = groupDeadlines({ ...settings, since: '2026-10-01' }, new Set(), '2026-10-01');
    expect(g.overdue).toEqual([]);
    expect(g.soon.map((d) => d.id)).toEqual(['de.vat-return:2026-09']);
    // Unless the business says it started earlier.
    const older = groupDeadlines({ ...settings, since: '2026-10-01', profile: { ...settings.profile, startYear: 2026 } }, new Set(), '2026-10-01');
    expect(older.overdue.map((d) => d.id)).toContain('de.vat-return:2026-08');
  });

  it('moves ticked-off deadlines to done', () => {
    const g = groupDeadlines(settings, new Set(['de.vat-return:2026-08', 'de.vat-return:2026-09']), '2026-10-01');
    expect(g.overdue.map((d) => d.id)).not.toContain('de.vat-return:2026-08');
    expect(g.soon).toEqual([]);
    expect(g.done.map((d) => d.id).slice(0, 2)).toEqual(['de.vat-return:2026-09', 'de.vat-return:2026-08']);
  });
});
