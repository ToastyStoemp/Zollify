import { z } from 'zod';
import { COUNTRY_CODES } from './countries';
import { paidLineTotals } from './charged-lines';
import type { SalesEvent, Transaction } from './types';

/**
 * VAT at an event: which rates apply where the booth is selling, or that the
 * booth is exempt there under a small-business scheme.
 *
 * The rate table is a starting point, not tax advice - every event shows the
 * rates it will use and can override them, and the sale keeps a snapshot of
 * what was applied (see SaleTax) so a later change to this table or to an
 * event never rewrites history.
 */

/** When the table below was last checked against published rates. */
export const VAT_RATES_AS_OF = '2026-07';

/** Standard rate and the reduced rates, in percent. The first reduced rate is the default for "reduced" products. */
export const VAT_RATES: Record<string, { standard: number; reduced: number[] }> = {
  AT: { standard: 20, reduced: [10, 13] },
  BE: { standard: 21, reduced: [6, 12] },
  BG: { standard: 20, reduced: [9] },
  HR: { standard: 25, reduced: [5, 13] },
  CY: { standard: 19, reduced: [5, 9, 3] },
  CZ: { standard: 21, reduced: [12] },
  DK: { standard: 25, reduced: [] },
  EE: { standard: 24, reduced: [9, 13] },
  FI: { standard: 25.5, reduced: [10, 13.5] },
  FR: { standard: 20, reduced: [5.5, 10, 2.1] },
  DE: { standard: 19, reduced: [7] },
  GR: { standard: 24, reduced: [6, 13, 4] },
  HU: { standard: 27, reduced: [5, 18] },
  IE: { standard: 23, reduced: [9, 13.5, 4.8] },
  IT: { standard: 22, reduced: [10, 5, 4] },
  LV: { standard: 21, reduced: [5, 12] },
  LT: { standard: 21, reduced: [5, 12] },
  LU: { standard: 17, reduced: [8, 14, 3] },
  MT: { standard: 18, reduced: [5, 7] },
  NL: { standard: 21, reduced: [9] },
  PL: { standard: 23, reduced: [8, 5] },
  PT: { standard: 23, reduced: [6, 13] },
  RO: { standard: 21, reduced: [11, 5] },
  SK: { standard: 23, reduced: [19, 5] },
  SI: { standard: 22, reduced: [9.5, 5] },
  ES: { standard: 21, reduced: [10, 4] },
  SE: { standard: 25, reduced: [12, 6] },
  // Outside the EU, where booths commonly travel.
  CH: { standard: 8.1, reduced: [2.6] },
  LI: { standard: 8.1, reduced: [2.6] },
  NO: { standard: 25, reduced: [15, 12] },
  GB: { standard: 20, reduced: [5] },
};

/** EU member states - where the cross-border SME scheme (EX number) applies. */
export const EU_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

/** ISO code for a country stored by name ("Germany") or code ("DE"); '' when unknown. */
export function countryCodeOf(country: string | undefined | null): string {
  return COUNTRY_CODES[(country ?? '').trim().toLowerCase()] ?? '';
}

/** Which rate a product takes: the country's standard rate, or its reduced rate (books, some art). */
export type TaxClass = 'standard' | 'reduced';

/**
 * The booth's small-business exemptions, shared by every device (account
 * profile). Under the EU SME scheme a small business established in one
 * member state can be exempt in others too; it then gets an identification
 * number with the suffix "EX", which receipts in those countries must show.
 */
const vatProfileFields = {
  /** ISO codes of the countries where the booth is exempt (home country included, if so). */
  exemptCountries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(40),
  /** EX identification number, for exempt sales outside the home country. */
  exNumber: z.string().trim().max(40),
  /** Overrides the note printed on exempt receipts at home (e.g. the national legal wording). */
  homeNote: z.string().trim().max(200),
  /** Overrides the note printed on exempt receipts in other countries. */
  crossBorderNote: z.string().trim().max(200),
};
export const VatProfileSchema = z.object({
  exemptCountries: vatProfileFields.exemptCountries.default([]),
  exNumber: vatProfileFields.exNumber.default(''),
  homeNote: vatProfileFields.homeNote.default(''),
  crossBorderNote: vatProfileFields.crossBorderNote.default(''),
});
export type VatProfile = z.infer<typeof VatProfileSchema>;
/** A change to some fields - no defaults, so fields left out stay as they are. */
export const VatProfileUpdateSchema = z.object(vatProfileFields).partial();

/** Per-event VAT, set on the event form. Absent fields fall back to the country and the business profile. */
export interface EventVat {
  /** 'auto' (default) = exempt if the profile lists the country, else charge the country's rates. */
  mode?: 'auto' | 'charge' | 'exempt';
  standard?: number;
  reduced?: number;
}

/**
 * The exemption wording a receipt carries. At home, the national wording for
 * the few countries whose phrasing is well established; elsewhere the EU SME
 * scheme's own requirement - a mention that the supply is exempt under it,
 * next to the EX number.
 */
const HOME_NOTES: Record<string, string> = {
  DE: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
  AT: 'Umsatzsteuerbefreit - Kleinunternehmer gem. § 6 Abs. 1 Z 27 UStG',
  FR: 'TVA non applicable, art. 293 B du CGI',
};
const GENERIC_HOME_NOTE = 'VAT exempt - small business scheme';
const CROSS_BORDER_NOTE = 'VAT exempt under the EU SME scheme';

/** The notes used when the profile sets none: national wording at home where known, the EU scheme's elsewhere. */
export function defaultExemptionNotes(homeCountry: string): { home: string; crossBorder: string } {
  return { home: HOME_NOTES[countryCodeOf(homeCountry) || homeCountry] ?? GENERIC_HOME_NOTE, crossBorder: CROSS_BORDER_NOTE };
}

export interface ResolvedVat {
  /** ISO code of the event's country; '' when unknown. */
  country: string;
  exempt: boolean;
  standard: number | null;
  reduced: number | null;
  /** Exempt only: the note to print. */
  note?: string;
  /** Exempt in another EU country than home: the EX number to print. */
  exNumber?: string;
}

/** What VAT an event's sales take, from its country, its own settings and the booth's exemptions. */
export function resolveEventVat(
  event: Pick<SalesEvent, 'venue'> & { vat?: EventVat } | null | undefined,
  profile: { vat?: Partial<VatProfile>; artist?: { countryOfOrigin?: string } } | null | undefined,
): ResolvedVat {
  const country = countryCodeOf(event?.venue?.country);
  const home = countryCodeOf(profile?.artist?.countryOfOrigin);
  const vp = profile?.vat ?? {};
  const mode = event?.vat?.mode ?? 'auto';
  const exempt = mode === 'exempt' || (mode === 'auto' && !!country && (vp.exemptCountries ?? []).includes(country));
  const table = VAT_RATES[country];
  if (exempt) {
    const atHome = !!country && country === home;
    const crossBorder = !atHome && EU_COUNTRIES.includes(country);
    const note = atHome
      ? vp.homeNote || HOME_NOTES[country] || GENERIC_HOME_NOTE
      : vp.crossBorderNote || (crossBorder ? CROSS_BORDER_NOTE : GENERIC_HOME_NOTE);
    return { country, exempt: true, standard: null, reduced: null, note, ...(crossBorder && vp.exNumber ? { exNumber: vp.exNumber } : {}) };
  }
  return {
    country,
    exempt: false,
    standard: event?.vat?.standard ?? table?.standard ?? null,
    reduced: event?.vat?.reduced ?? table?.reduced[0] ?? table?.standard ?? null,
  };
}

/**
 * The VAT applied to one sale, kept on the transaction as it was at the time:
 * rates and exemption must not change when an event or this table does later.
 * `rates` pairs with `items` by index; null = no rate known (charged nothing).
 */
export interface SaleTax {
  country: string;
  exempt: boolean;
  rates: (number | null)[];
  note?: string;
  exNumber?: string;
}

/** The snapshot for a sale, given each line's tax class. */
export function saleTaxFor(resolved: ResolvedVat, classes: (TaxClass | undefined)[]): SaleTax {
  if (resolved.exempt) {
    return { country: resolved.country, exempt: true, rates: classes.map(() => null), ...(resolved.note ? { note: resolved.note } : {}), ...(resolved.exNumber ? { exNumber: resolved.exNumber } : {}) };
  }
  return {
    country: resolved.country,
    exempt: false,
    rates: classes.map((c) => (c === 'reduced' ? resolved.reduced : resolved.standard)),
  };
}

export interface VatRow {
  rate: number;
  /** Receipt marker for lines at this rate when a sale has more than one ("A", "B", …). */
  letter: string;
  gross: number;
  net: number;
  vat: number;
}

/**
 * VAT per rate, in the currency the customer paid, from what each line
 * actually came to (discounts included). Prices are gross: the VAT inside a
 * gross amount is gross × rate / (100 + rate), rounded once per rate.
 */
export function vatBreakdown(tx: Pick<Transaction, 'items' | 'total' | 'currency' | 'baseCurrency' | 'baseTotal' | 'discounts' | 'asCharged' | 'tax'>): VatRow[] {
  if (!tx.tax || tx.tax.exempt) return [];
  const paid = paidLineTotals(tx);
  const byRate = new Map<number, number>();
  tx.items.forEach((_, i) => {
    const rate = tx.tax!.rates[i];
    if (rate == null) return;
    byRate.set(rate, (byRate.get(rate) ?? 0) + Math.round((paid[i] ?? 0) * 100));
  });
  return [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, grossMinor], n) => {
      const vatMinor = Math.round((grossMinor * rate) / (100 + rate));
      return { rate, letter: String.fromCharCode(65 + n), gross: grossMinor / 100, net: (grossMinor - vatMinor) / 100, vat: vatMinor / 100 };
    });
}

/** "19%" / "8.1%" */
export const fmtRate = (rate: number): string => `${Number.isInteger(rate) ? rate : rate.toFixed(1).replace(/\.0$/, '')}%`;
