import { z } from 'zod';
import { COUNTRY_CODES } from './countries';
import { formatEnterpriseNumber, isBelgianEnterpriseNumber, normaliseBelgianVat, PeppolSettingsSchema, type PeppolParty, type PeppolSettings } from './peppol';
import type { ArtistDetails } from './protocol';
import { cleanProfileLinks, hasProfileLinks, type ProfileLinks } from './receipt-socials';

/**
 * The business profile is the one place the business is described. Modules read
 * it by default and keep only what differs - the customs declarant already
 * works this way. This file holds the pure parts: checking what the profile
 * form sends, moving the first version of the receipt links into the profile,
 * and the seller party a Peppol invoice defaults to.
 */

const digits = (s: string): string => s.replace(/\D/g, '');

/** Whether the profile's country is Belgium, by name or ISO code. */
export const isBelgium = (country: string | undefined): boolean => COUNTRY_CODES[(country ?? '').trim().toLowerCase()] === 'BE';

/**
 * Check the artist fields a save carries. A Belgian enterprise number is
 * stored in its usual dotted form; anything that is not one is refused, with
 * a message fit to show. Blank clears it.
 */
export function cleanArtistUpdate<T extends Partial<ArtistDetails>>(artist: T): T {
  if (artist.enterpriseNumber === undefined) return artist;
  const raw = artist.enterpriseNumber.trim();
  if (!raw) return { ...artist, enterpriseNumber: '' };
  const vat = normaliseBelgianVat(raw);
  if (!vat) throw new Error('That is not a valid Belgian enterprise number (10 digits, like 0123.456.749).');
  return { ...artist, enterpriseNumber: formatEnterpriseNumber(vat.slice(2)) };
}

/** The Belgian VAT number an enterprise number stands for, or '' when it is not a valid one. */
export const vatFromEnterpriseNumber = (enterpriseNumber: string): string => normaliseBelgianVat(enterpriseNumber) ?? '';

/**
 * Links to adopt into a profile from the first version of the receipt
 * settings, which stored them on their own. Only fills a profile whose links
 * were never set: once they are (even cleared on purpose) the profile wins and
 * the old copy is never read back. Null means leave the profile as it is.
 */
export function adoptLegacyLinks(current: ProfileLinks | undefined, legacy: unknown): ProfileLinks | null {
  if (current) return null;
  let cleaned: ProfileLinks;
  try {
    cleaned = cleanProfileLinks(legacy);
  } catch {
    return null;
  }
  return hasProfileLinks(cleaned) ? cleaned : null;
}

/** "8000 Zürich" into postcode and city. Dutch postcodes carry letters; a bare city has no postcode. */
export function splitPostCodeCity(raw: string): { postalCode: string; city: string } {
  const s = raw.trim().replace(/\s+/g, ' ');
  const m = /^(\d{4} ?[A-Za-z]{2}|[A-Za-z]{1,2}-?\d{3,6}|\d{3,6})\s+(.+)$/.exec(s);
  return m ? { postalCode: m[1]!, city: m[2]! } : { postalCode: '', city: s };
}

/**
 * Peppol settings as stored: like the full settings, but a seller field may be
 * blank, which means "as on the business profile".
 */
export const PeppolStoredSettingsSchema = PeppolSettingsSchema.extend({
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).or(z.literal('')).default(''),
  peppolScheme: z.string().trim().regex(/^\d{4}$/).or(z.literal('')).default(''),
});

const SELLER_KEYS = ['name', 'vatNumber', 'companyId', 'street', 'city', 'postalCode', 'country', 'email', 'peppolScheme', 'peppolId'] as const;
export type PeppolSellerKey = (typeof SELLER_KEYS)[number];
export type PeppolSeller = Pick<PeppolParty, PeppolSellerKey>;

/**
 * What the profile says about the seller, in a Peppol party's terms. A field
 * the profile cannot fill is blank. A Belgian enterprise number gives the VAT
 * number and the Peppol address too, when those are not given.
 */
export function peppolSellerFromProfile(artist: Partial<ArtistDetails> | null | undefined): PeppolSeller {
  const a = artist ?? {};
  const be = isBelgium(a.countryOfOrigin);
  const { postalCode, city } = splitPostCodeCity(a.postCodeCity ?? '');
  const kbo = be ? (normaliseBelgianVat(a.enterpriseNumber ?? '')?.slice(2) ?? '') : '';
  const vatId = (a.vatId ?? '').trim();
  const vat = vatId ? (be ? (normaliseBelgianVat(vatId) ?? vatId) : vatId.replace(/\s+/g, '')) : kbo ? `BE${kbo}` : '';
  return {
    name: a.companyName?.trim() || a.fullName?.trim() || '',
    street: (a.street ?? '').trim(),
    postalCode,
    city,
    country: COUNTRY_CODES[(a.countryOfOrigin ?? '').trim().toLowerCase()] ?? '',
    email: (a.email ?? '').trim(),
    vatNumber: vat,
    companyId: kbo,
    peppolScheme: kbo ? '0208' : '',
    peppolId: kbo,
  };
}

/**
 * The settings invoices are made from: what the business stored, with the
 * profile filling every seller field left blank. Stored values win, so an
 * account that filled these in before keeps exactly what it had.
 */
export function resolvePeppolSettings(stored: Partial<PeppolSettings> | null | undefined, artist: Partial<ArtistDetails> | null | undefined): PeppolSettings {
  const from = peppolSellerFromProfile(artist);
  const own = (stored ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...own };
  for (const k of SELLER_KEYS) {
    const v = own[k];
    if (typeof v !== 'string' || !v.trim()) merged[k] = from[k];
  }
  if (!merged.country) merged.country = 'BE';
  if (!merged.peppolScheme) merged.peppolScheme = '0208';
  const parsed = PeppolSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : PeppolSettingsSchema.parse({});
}

/**
 * The seller fields worth storing: those that differ from the profile.
 * Everything else is blanked, so it keeps following the profile.
 */
export function peppolOverrides<T extends Partial<PeppolParty>>(settings: T, artist: Partial<ArtistDetails> | null | undefined): T {
  const from = peppolSellerFromProfile(artist);
  const out: Record<string, unknown> = { ...settings };
  for (const k of SELLER_KEYS) {
    const v = typeof out[k] === 'string' ? (out[k] as string).trim() : '';
    out[k] = v && v !== from[k] ? v : '';
  }
  return out as T;
}
