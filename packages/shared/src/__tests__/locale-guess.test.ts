import { describe, expect, it } from 'vitest';
import { COUNTRIES } from '../countries';
import { CURRENCIES } from '../currencies';
import { currencyOf, dateLocaleOf, guessCountry, receiptDateTime } from '../locale-guess';

describe('guessCountry', () => {
  it('goes by the time zone first, even with an English phone', () => {
    expect(guessCountry({ timeZone: 'Europe/Copenhagen', languages: ['en-US'] })).toBe('DK');
    expect(guessCountry({ timeZone: 'Europe/Zurich', languages: ['en'] })).toBe('CH');
  });

  it('falls back to the language region, and gives up without one', () => {
    expect(guessCountry({ timeZone: 'UTC', languages: ['en', 'de-AT'] })).toBe('AT');
    expect(guessCountry({ timeZone: 'UTC', languages: ['en'] })).toBe('');
    // English set to its US default is no sign of being in the US.
    expect(guessCountry({ timeZone: 'UTC', languages: ['en-US', 'nl-BE'] })).toBe('BE');
    expect(guessCountry({ timeZone: 'UTC', languages: ['en-US'] })).toBe('');
    expect(guessCountry({})).toBe('');
  });
});

describe('currencyOf', () => {
  it('knows the euro area and the neighbours that are not in it', () => {
    expect(currencyOf('DE')).toBe('EUR');
    expect(currencyOf('DK')).toBe('DKK');
    expect(currencyOf('CH')).toBe('CHF');
    expect(currencyOf('XX')).toBe('');
  });

  it('only names countries and currencies the pickers know', () => {
    const countries = new Set(COUNTRIES.map((c) => c.code));
    const currencies = new Set(CURRENCIES.map((c) => c.code));
    for (const code of ['DE', 'DK', 'CH', 'SE', 'NO', 'GB', 'PL', 'CZ', 'US', 'JP', 'LI']) {
      expect(countries.has(code), code).toBe(true);
      expect(currencies.has(currencyOf(code)), currencyOf(code)).toBe(true);
    }
  });
});

describe('receipt dates', () => {
  const at = new Date(2026, 9, 18, 14, 5).getTime();
  it('writes the date the way the country does, not the browser', () => {
    expect(receiptDateTime(at, 'DE')).toEqual({ date: '18.10.2026', time: '14:05' });
    expect(receiptDateTime(at, 'Belgium').date).toBe('18/10/2026');
    expect(receiptDateTime(at, 'DK').date).toBe('18.10.2026');
    expect(receiptDateTime(at, 'US').date).toBe('10/18/2026');
  });
  it('falls back to day-first for an unknown country', () => {
    expect(dateLocaleOf('')).toBe('en-GB');
    expect(dateLocaleOf('Atlantis')).toBe('en-GB');
    expect(receiptDateTime(at, undefined).date).toBe('18/10/2026');
  });
});
