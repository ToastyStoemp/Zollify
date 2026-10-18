import { describe, expect, it } from 'vitest';
import { TaxDeadlineProfileSchema } from '@zollify/shared';
import { fromBusinessProfile, vatMismatch } from '../from-profile';

const base = TaxDeadlineProfileSchema.parse({ region: 'BY' });
const biz = (country: string, vat: Record<string, unknown>) =>
  ({ artist: { countryOfOrigin: country }, vat: { scheme: '', vatNumbers: [], exemptCountries: [], exNumber: '', homeNote: '', crossBorderNote: '', ...vat } }) as never;

describe('fromBusinessProfile', () => {
  it('takes the home country, and drops a region that belonged to another one', () => {
    expect(fromBusinessProfile(base, biz('Belgium', {}))).toMatchObject({ country: 'BE', region: '' });
    expect(fromBusinessProfile(base, biz('Germany', {}))).toMatchObject({ country: 'DE', region: 'BY' });
  });

  it('reads the scheme answer and the cross-border exemption', () => {
    expect(fromBusinessProfile(base, biz('Germany', { scheme: 'sme', exemptCountries: ['DE', 'AT'] }))).toMatchObject({ vat: 'small-business', euSmeScheme: true });
    expect(fromBusinessProfile(base, biz('Germany', { scheme: 'sme' }))).toMatchObject({ vat: 'small-business', euSmeScheme: false });
    expect(fromBusinessProfile(base, biz('Germany', { scheme: 'vat' }))).toMatchObject({ vat: 'regular', euSmeScheme: false });
    expect(fromBusinessProfile(base, biz('Belgium', { scheme: 'sme', exemptCountries: ['BE'], exNumber: 'BE0123456789EX' }))).toMatchObject({ vat: 'small-business', euSmeScheme: true });
  });

  it('leaves VAT alone when the question was never answered', () => {
    expect(fromBusinessProfile({ ...base, vat: 'none' }, biz('Germany', {}))).toMatchObject({ vat: 'none' });
  });
});

describe('vatMismatch', () => {
  it('flags reminders for returns the business does not file, or a missing SME report', () => {
    expect(vatMismatch({ ...base, vat: 'regular' }, biz('Germany', { exemptCountries: ['DE'] }))).toMatch(/exempt at home/);
    expect(vatMismatch({ ...base, vat: 'small-business' }, biz('Germany', { scheme: 'vat' }))).toMatch(/charge VAT/);
    expect(vatMismatch({ ...base, vat: 'small-business', euSmeScheme: false }, biz('Germany', { exemptCountries: ['DE', 'NL'] }))).toMatch(/SME scheme report/);
  });

  it('is quiet when they agree, or describe different countries', () => {
    expect(vatMismatch({ ...base, vat: 'small-business', euSmeScheme: true }, biz('Germany', { exemptCountries: ['DE', 'NL'] }))).toBeNull();
    expect(vatMismatch({ ...base, country: 'DE', vat: 'regular' }, biz('Belgium', { exemptCountries: ['BE'] }))).toBeNull();
  });
});
