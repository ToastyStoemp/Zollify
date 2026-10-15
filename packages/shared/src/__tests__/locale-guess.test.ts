import { describe, expect, it } from 'vitest';
import { COUNTRIES } from '../countries';
import { CURRENCIES } from '../currencies';
import { currencyOf, guessCountry } from '../locale-guess';

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
