import { describe, expect, it } from 'vitest';
import {
  TaxDeadlineSettingsSchema,
  deadlinesBetween,
  deadlinesFrom,
  easterSunday,
  germanAnnualDeadline,
  germanHolidays,
  nextGermanWorkingDay,
  normalizeLeadDays,
  remindersDue,
  rulesFor,
  type TaxDeadlineSettings,
} from '../tax-deadlines';

const settings = (profile: Partial<TaxDeadlineSettings['profile']> = {}, rest: Partial<TaxDeadlineSettings> = {}): TaxDeadlineSettings =>
  TaxDeadlineSettingsSchema.parse({ ...rest, profile: { country: 'DE', ...profile } });

const due = (s: TaxDeadlineSettings, id: string) => deadlinesBetween(s, '2020-01-01', '2030-12-31').find((d) => d.id === id)?.due;

describe('calendar', () => {
  it('finds Easter', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(easterSunday(2025)).toBe('2025-04-20');
  });

  it('knows national and state holidays', () => {
    const national = germanHolidays(2026);
    expect(national.get('2026-04-03')).toBe('Karfreitag');
    expect(national.has('2026-06-04')).toBe(false); // Fronleichnam is regional
    expect(germanHolidays(2026, 'BY').get('2026-06-04')).toBe('Fronleichnam');
    expect(germanHolidays(2026, 'SN').get('2026-11-18')).toBe('Buß- und Bettag');
    expect(germanHolidays(2025, 'SN').get('2025-11-19')).toBe('Buß- und Bettag');
  });

  it('moves off weekends and holidays (§108 AO)', () => {
    expect(nextGermanWorkingDay('2026-10-10')).toBe('2026-10-12'); // Saturday
    expect(nextGermanWorkingDay('2026-12-25')).toBe('2026-12-28'); // Christmas, then the weekend
    expect(nextGermanWorkingDay('2025-10-31', 'NI')).toBe('2025-11-03'); // Reformationstag
    expect(nextGermanWorkingDay('2025-10-31', 'BY')).toBe('2025-10-31');
  });
});

describe('Germany', () => {
  it('lists monthly VAT returns on the 10th, moved to a working day', () => {
    const s = settings({ vatFrequency: 'monthly' });
    expect(due(s, 'de.vat-return:2026-09')).toBe('2026-10-12');
    expect(due(s, 'de.vat-return:2026-03')).toBe('2026-04-10');
    expect(due(s, 'de.vat-special-prepayment:2026')).toBeUndefined();
  });

  it('adds a month and the special prepayment with the extension', () => {
    const s = settings({ vatFrequency: 'monthly', extension: true });
    expect(due(s, 'de.vat-return:2026-09')).toBe('2026-11-10');
    expect(due(s, 'de.vat-special-prepayment:2026')).toBe('2026-02-10');
  });

  it('lists quarterly returns, the fourth in January', () => {
    const s = settings({ vatFrequency: 'quarterly' });
    expect(due(s, 'de.vat-return:2026-Q3')).toBe('2026-10-12');
    expect(due(s, 'de.vat-return:2026-Q4')).toBe('2027-01-11');
    expect(due(s, 'de.vat-return:2026-09')).toBeUndefined();
  });

  it('dates the annual returns by who files them', () => {
    expect(germanAnnualDeadline(2025, false)).toBe('2026-07-31');
    expect(germanAnnualDeadline(2025, true)).toBe('2027-02-28');
    expect(germanAnnualDeadline(2024, true)).toBe('2026-04-30');
    expect(due(settings({ advisor: true }), 'de.income-tax-return:2025')).toBe('2027-03-01'); // 28 Feb 2027 is a Sunday
    expect(due(settings(), 'de.vat-annual:2025')).toBe('2026-07-31');
  });

  it('skips VAT for a Kleinunternehmer but keeps income and trade tax', () => {
    const s = settings({ vat: 'small-business' });
    const ids = deadlinesBetween(s, '2026-01-01', '2026-12-31').map((d) => d.ruleId);
    expect(ids).not.toContain('de.vat-return');
    expect(ids).not.toContain('de.vat-annual');
    expect(ids).toContain('de.income-tax-return');
    expect(ids).toContain('de.trade-tax-return');
  });

  it('lists prepayments only when switched on', () => {
    const s = settings({ incomeTaxPrepayments: true, tradeTaxPrepayments: true });
    expect(due(s, 'de.income-tax-prepayment:2026-Q1')).toBe('2026-03-10');
    expect(due(s, 'de.trade-tax-prepayment:2026-Q4')).toBe('2026-11-16');
    expect(due(settings({ tradeTax: false, tradeTaxPrepayments: true }), 'de.trade-tax-prepayment:2026-Q4')).toBeUndefined();
    expect(due(settings({ legalForm: 'company', incomeTaxPrepayments: true }), 'de.income-tax-prepayment:2026-Q2')).toBe('2026-06-10');
  });

  it('dates the EC Sales List on the 25th, never extended', () => {
    const s = settings({ ecSalesList: true, ecSalesListFrequency: 'monthly', extension: true });
    expect(due(s, 'de.ec-sales-list:2026-09')).toBe('2026-10-26');
  });

  it('switches rules off', () => {
    const s = settings({}, { off: ['de.trade-tax-return'] });
    expect(due(s, 'de.trade-tax-return:2025')).toBeUndefined();
  });

  it('offers only the rules the answers leave standing', () => {
    const ids = (p: Partial<TaxDeadlineSettings['profile']>) => rulesFor(settings(p).profile, 2026).map((r) => r.id);
    // A Kleinunternehmer files no VAT returns and, without the EU scheme, no SME report.
    expect(ids({ vat: 'small-business' })).toEqual(['de.income-tax-return', 'de.trade-tax-return']);
    expect(ids({ vat: 'small-business', euSmeScheme: true, tradeTax: false })).toEqual(['de.income-tax-return', 'eu.sme-report']);
    // Charging VAT quarterly: returns and the annual return, but no special prepayment (monthly with extension only).
    expect(ids({ vat: 'regular', vatFrequency: 'quarterly', extension: true })).toEqual(['de.vat-return', 'de.vat-annual', 'de.income-tax-return', 'de.trade-tax-return']);
    expect(ids({ vat: 'regular', vatFrequency: 'monthly', extension: true, ecSalesList: true })).toContain('de.vat-special-prepayment');
    expect(ids({ vat: 'regular', vatFrequency: 'monthly', extension: true, ecSalesList: true })).toContain('de.ec-sales-list');
    expect(ids({ vat: 'regular', incomeTaxPrepayments: true, tradeTaxPrepayments: true })).toEqual(expect.arrayContaining(['de.income-tax-prepayment', 'de.trade-tax-prepayment']));
  });
});

describe('deadlines count from the account, or the business start', () => {
  const s = settings({ vatFrequency: 'monthly' });

  it('leaves out what was due before the account existed', () => {
    const before = deadlinesBetween({ ...s, since: '2026-10-18' }, '2026-06-01', '2026-12-31').map((d) => d.id);
    // Sept return due 12 Oct, income tax return 2025 due 31 Jul: both before sign-up.
    expect(before).not.toContain('de.vat-return:2026-09');
    expect(before).not.toContain('de.income-tax-return:2025');
    expect(before).toContain('de.vat-return:2026-10'); // due 10 Nov
    // Nothing at all when the window ends before the account started.
    expect(deadlinesBetween({ ...s, since: '2027-01-01' }, '2026-01-01', '2026-12-31')).toEqual([]);
    // A deadline due on the sign-up day itself still counts.
    expect(deadlinesBetween({ ...s, since: '2026-10-12' }, '2026-10-01', '2026-10-31').map((d) => d.id)).toContain('de.vat-return:2026-09');
  });

  it('counts from 1 January of a given start year instead', () => {
    expect(deadlinesFrom({ profile: s.profile, since: '2026-10-18' })).toBe('2026-10-18');
    expect(deadlinesFrom({ profile: { ...s.profile, startYear: 2025 }, since: '2026-10-18' })).toBe('2025-01-01');
    expect(deadlinesFrom({ profile: s.profile })).toBeUndefined();
    const older = { ...s, profile: { ...s.profile, startYear: 2025 }, since: '2026-10-18' };
    expect(deadlinesBetween(older, '2026-06-01', '2026-12-31').map((d) => d.id)).toContain('de.income-tax-return:2025');
    expect(deadlinesBetween(older, '2024-01-01', '2024-12-31')).toEqual([]);
  });

  it('sends no overdue note for a deadline from before the account', () => {
    const r = { ...s, since: '2026-10-13', reminders: { leadDays: [3], email: true, overdue: true, timeZone: 'Europe/Berlin' } };
    expect(remindersDue(r, '2026-10-13', new Set(), new Set()).map((x) => x.deadline.id)).not.toContain('de.vat-return:2026-09');
    expect(remindersDue({ ...r, since: '2026-10-01' }, '2026-10-13', new Set(), new Set()).find((x) => x.deadline.id === 'de.vat-return:2026-09')).toMatchObject({ lead: -1 });
  });
});

describe('EU SME scheme and custom deadlines', () => {
  it('adds the quarterly SME report a month after the quarter', () => {
    expect(due(settings({ euSmeScheme: true }), 'eu.sme-report:2026-Q3')).toBe('2026-11-02');
    expect(due(settings({ euSmeScheme: true, region: 'BY' }), 'eu.sme-report:2025-Q3')).toBe('2025-10-31');
    // A country without its own rules gets the report unmoved.
    const be = settings({ country: 'BE', euSmeScheme: true });
    expect(due(be, 'eu.sme-report:2026-Q3')).toBe('2026-10-31');
    expect(rulesFor(be.profile).map((r) => r.id)).toEqual(['eu.sme-report']);
    expect(due(settings({ country: 'CH', euSmeScheme: true }), 'eu.sme-report:2026-Q3')).toBeUndefined();
  });

  it('repeats custom deadlines, clamped to the month', () => {
    const s = settings({ country: 'BE' }, { custom: [{ id: 'a', title: 'Rent tax', repeat: 'monthly', date: '2026-01-31', note: '', action: 'pay' }] });
    const days = deadlinesBetween(s, '2026-01-01', '2026-04-30').map((d) => d.due);
    expect(days).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('stops a custom deadline at its last day', () => {
    const s = settings({ country: 'BE' }, { custom: [{ id: 'a', title: 'X', repeat: 'quarterly', date: '2026-01-15', until: '2026-08-01', note: '', action: 'file' }] });
    expect(deadlinesBetween(s, '2026-01-01', '2027-12-31').map((d) => d.due)).toEqual(['2026-01-15', '2026-04-15', '2026-07-15']);
  });
});

describe('reminders', () => {
  const s = settings({ vatFrequency: 'monthly' }, { reminders: { leadDays: [14, 3], email: true, overdue: true, timeZone: 'Europe/Berlin' } });
  const id = 'de.vat-return:2026-09'; // due 2026-10-12

  it('cleans lead days', () => {
    expect(normalizeLeadDays([3, 14, 3, -1, 200, 2.5, 0])).toEqual([14, 3, 0]);
  });

  it('reminds at each lead time once', () => {
    expect(remindersDue(s, '2026-09-27', new Set(), new Set()).find((r) => r.deadline.id === id)).toBeUndefined();
    const first = remindersDue(s, '2026-09-28', new Set(), new Set()).find((r) => r.deadline.id === id);
    expect(first).toMatchObject({ lead: 14, covers: [] });
    expect(remindersDue(s, '2026-10-01', new Set(), new Set([`${id}|14`])).find((r) => r.deadline.id === id)).toBeUndefined();
    expect(remindersDue(s, '2026-10-09', new Set(), new Set([`${id}|14`])).find((r) => r.deadline.id === id)).toMatchObject({ lead: 3 });
  });

  it('sends one note for lead times missed while down', () => {
    expect(remindersDue(s, '2026-10-10', new Set(), new Set()).find((r) => r.deadline.id === id)).toMatchObject({ lead: 3, covers: [14] });
  });

  it('says nothing about deadlines ticked off, and once about overdue ones', () => {
    expect(remindersDue(s, '2026-10-10', new Set([id]), new Set()).find((r) => r.deadline.id === id)).toBeUndefined();
    expect(remindersDue(s, '2026-10-13', new Set(), new Set()).find((r) => r.deadline.id === id)).toMatchObject({ lead: -1 });
    expect(remindersDue(s, '2026-10-14', new Set(), new Set()).find((r) => r.deadline.id === id)).toBeUndefined();
  });
});
