import { describe, expect, it } from 'vitest';
import {
  PeppolStoredSettingsSchema,
  adoptLegacyLinks,
  cleanArtistUpdate,
  cleanProfileLinks,
  emptyPeppolSettings,
  peppolOverrides,
  peppolSellerFromProfile,
  resolvePeppolSettings,
  splitPostCodeCity,
  vatFromEnterpriseNumber,
  ArtistDetailsSchema,
  ProfileUpdateSchema,
  type ArtistDetails,
} from '../index';

const kbo = (b: string): string => `${b}${String(97 - (Number(b) % 97)).padStart(2, '0')}`;
const KBO = kbo('04031707');
const artist = (extra: Partial<ArtistDetails> = {}): ArtistDetails => ({ ...ArtistDetailsSchema.parse({}), ...extra });
const rose = artist({ companyName: 'Atelier Rose', fullName: 'Rose Peeters', street: 'Rue Haute 1', postCodeCity: '1000 Brussels', countryOfOrigin: 'Belgium', email: 'rose@example.test', enterpriseNumber: KBO });

describe('profile links', () => {
  it('cleans handles and links like the receipt does, and leaves blanks blank', () => {
    const l = cleanProfileLinks({ webstore: ' https://shop.example.com ', instagram: '@booth', otherUrl: 'https://n.example.com' });
    expect(l).toMatchObject({ webstore: 'https://shop.example.com/', instagram: 'https://www.instagram.com/booth', tiktok: '', otherLabel: 'More' });
    expect(cleanProfileLinks(undefined)).toMatchObject({ webstore: '', otherLabel: '' });
  });

  it('refuses links that are not plain https, with the field named', () => {
    expect(() => cleanProfileLinks({ bluesky: 'javascript:alert(1)' })).toThrow(/Bluesky/);
    expect(() => cleanProfileLinks({ mastodon: 'http://m.example.com' })).toThrow(/Mastodon/);
    expect(() => cleanProfileLinks({ webstore: 'https://a:b@shop.example.com' })).toThrow(/login/);
    expect(() => cleanProfileLinks({ webstore: 5 })).toThrow(/text/);
  });

  it('accepts a partial update through the profile schema, and drops fields it does not know', () => {
    const parsed = ProfileUpdateSchema.parse({ links: { webstore: 'https://x.example.com', evil: 'x' }, artist: { enterpriseNumber: KBO } });
    expect(parsed.links).toEqual({ webstore: 'https://x.example.com' });
    expect(ProfileUpdateSchema.safeParse({ links: { webstore: 'x'.repeat(401) } }).success).toBe(false);
  });
});

describe('enterprise number', () => {
  it('is stored dotted, from any common way of writing it', () => {
    for (const raw of [KBO, `BE${KBO}`, `BE ${KBO.slice(0, 4)}.${KBO.slice(4, 7)}.${KBO.slice(7)}`, ` ${KBO} `]) {
      expect(cleanArtistUpdate({ enterpriseNumber: raw }).enterpriseNumber, raw).toBe(`${KBO.slice(0, 4)}.${KBO.slice(4, 7)}.${KBO.slice(7)}`);
    }
  });

  it('refuses a number that fails the check, clears on blank, and ignores updates that do not mention it', () => {
    expect(() => cleanArtistUpdate({ enterpriseNumber: '0403170700' })).toThrow(/enterprise number/);
    expect(() => cleanArtistUpdate({ enterpriseNumber: 'hello' })).toThrow();
    expect(cleanArtistUpdate({ enterpriseNumber: '  ' }).enterpriseNumber).toBe('');
    const other = { street: 'x' };
    expect(cleanArtistUpdate(other)).toBe(other);
  });

  it('gives the Belgian VAT number, only for a valid one', () => {
    expect(vatFromEnterpriseNumber(KBO)).toBe(`BE${KBO}`);
    expect(vatFromEnterpriseNumber('123')).toBe('');
  });

  it('loads on an artist saved before it existed', () => {
    expect(ArtistDetailsSchema.parse({ companyName: 'Old' }).enterpriseNumber).toBeUndefined();
  });
});

describe('moving the first version of the receipt links into the profile', () => {
  const legacy = { webstore: 'https://old.example.com/', showOnPrint: true };

  it('adopts them into a profile that never had links', () => {
    expect(adoptLegacyLinks(undefined, legacy)).toMatchObject({ webstore: 'https://old.example.com/' });
  });

  it('never overwrites: links that were set, even cleared, stay', () => {
    expect(adoptLegacyLinks(cleanProfileLinks({ instagram: '@mine' }), legacy)).toBeNull();
    expect(adoptLegacyLinks(cleanProfileLinks({}), legacy)).toBeNull();
  });

  it('adopts nothing from an empty, broken or unsafe row', () => {
    expect(adoptLegacyLinks(undefined, { showOnPrint: true })).toBeNull();
    expect(adoptLegacyLinks(undefined, null)).toBeNull();
    expect(adoptLegacyLinks(undefined, 'text')).toBeNull();
    expect(adoptLegacyLinks(undefined, { webstore: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('the Peppol seller from the profile', () => {
  it('takes name, address, contact, VAT and enterprise number', () => {
    expect(peppolSellerFromProfile(rose)).toEqual({
      name: 'Atelier Rose',
      street: 'Rue Haute 1',
      postalCode: '1000',
      city: 'Brussels',
      country: 'BE',
      email: 'rose@example.test',
      vatNumber: `BE${KBO}`,
      companyId: KBO,
      peppolScheme: '0208',
      peppolId: KBO,
    });
  });

  it('prefers the profile VAT number when there is one, and the person when there is no company', () => {
    const s = peppolSellerFromProfile({ ...rose, companyName: '', vatId: 'BE 0403.170.701' });
    expect(s.name).toBe('Rose Peeters');
    expect(s.vatNumber).toBe(`BE${KBO}`);
    expect(peppolSellerFromProfile(artist({ countryOfOrigin: 'Germany', vatId: 'DE 123 456 789' })).vatNumber).toBe('DE123456789');
  });

  it('does not invent Belgian identifiers outside Belgium, or from nothing', () => {
    const s = peppolSellerFromProfile({ ...rose, countryOfOrigin: 'Netherlands' });
    expect(s).toMatchObject({ country: 'NL', companyId: '', vatNumber: '', peppolId: '' });
    expect(peppolSellerFromProfile(artist())).toEqual({ name: '', street: '', postalCode: '', city: '', country: '', email: '', vatNumber: '', companyId: '', peppolScheme: '', peppolId: '' });
    expect(peppolSellerFromProfile(undefined).name).toBe('');
  });

  it('splits postcode and city the ways people write them', () => {
    expect(splitPostCodeCity('8000 Zürich')).toEqual({ postalCode: '8000', city: 'Zürich' });
    expect(splitPostCodeCity('1234 AB Amsterdam')).toEqual({ postalCode: '1234 AB', city: 'Amsterdam' });
    expect(splitPostCodeCity('SW1A 1AA London')).toEqual({ postalCode: '', city: 'SW1A 1AA London' });
    expect(splitPostCodeCity('Bern')).toEqual({ postalCode: '', city: 'Bern' });
    expect(splitPostCodeCity('')).toEqual({ postalCode: '', city: '' });
  });
});

describe('Peppol settings: the profile by default, a stored value only when it differs', () => {
  it('fills every blank seller field from the profile and keeps the Peppol-only ones', () => {
    const stored = PeppolStoredSettingsSchema.parse({ iban: 'BE68539007547034', invoicePrefix: 'RS' });
    const s = resolvePeppolSettings(stored, rose);
    expect(s).toMatchObject({ name: 'Atelier Rose', city: 'Brussels', country: 'BE', vatNumber: `BE${KBO}`, companyId: KBO, peppolId: KBO, iban: 'BE68539007547034', invoicePrefix: 'RS' });
  });

  it('lets a stored value win, field by field', () => {
    const s = resolvePeppolSettings(PeppolStoredSettingsSchema.parse({ name: 'Rose Trading', city: 'Ghent' }), rose);
    expect(s).toMatchObject({ name: 'Rose Trading', city: 'Ghent', street: 'Rue Haute 1' });
  });

  it('keeps settings saved in full by an older version exactly as they were', () => {
    const old = { ...emptyPeppolSettings(), name: 'Kunsthaus BV', vatNumber: 'BE0403170701', companyId: KBO, street: 'Old Street 9', city: 'Antwerp', postalCode: '2000', country: 'BE', peppolScheme: '0208', peppolId: KBO };
    expect(resolvePeppolSettings(old, rose)).toMatchObject({ name: 'Kunsthaus BV', street: 'Old Street 9', city: 'Antwerp', postalCode: '2000' });
  });

  it('works with no profile at all: blank, with the Belgian defaults', () => {
    const s = resolvePeppolSettings(undefined, undefined);
    expect(s).toMatchObject({ name: '', country: 'BE', peppolScheme: '0208', peppolId: '' });
  });

  it('survives a stored value that fails the schema', () => {
    expect(resolvePeppolSettings({ paymentDays: 9999 } as never, rose).paymentDays).toBe(30);
  });

  it('stores only what differs from the profile', () => {
    const filled = { ...resolvePeppolSettings(undefined, rose), name: 'Rose Trading', iban: 'BE68539007547034' };
    const kept = peppolOverrides(filled, rose);
    expect(kept).toMatchObject({ name: 'Rose Trading', street: '', city: '', country: '', vatNumber: '', companyId: '', peppolScheme: '', peppolId: '', iban: 'BE68539007547034' });
    // Round trip: what is stored resolves to what was shown.
    expect(resolvePeppolSettings(PeppolStoredSettingsSchema.parse(kept), rose)).toEqual({ ...filled, peppolScheme: '0208' });
  });

  it('accepts a blank country or scheme as stored, and refuses a malformed one', () => {
    expect(PeppolStoredSettingsSchema.safeParse({ country: '', peppolScheme: '' }).success).toBe(true);
    expect(PeppolStoredSettingsSchema.safeParse({ country: 'Belgium' }).success).toBe(false);
    expect(PeppolStoredSettingsSchema.safeParse({ peppolScheme: 'x' }).success).toBe(false);
  });
});
