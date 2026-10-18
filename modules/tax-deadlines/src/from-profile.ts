import { EU_COUNTRIES, countryCodeOf, type AccountProfile, type TaxDeadlineProfile } from '@zollify/shared';

/**
 * The business already says where it is and how it handles VAT - in the
 * business profile and under Settings → VAT (asked in first-run setup). The
 * deadlines start from those answers rather than asking them a second time,
 * and say so when the two drift apart.
 */

type Profile = Pick<AccountProfile, 'artist' | 'vat'> | null | undefined;

interface VatFacts {
  home: string;
  scheme: '' | 'sme' | 'vat';
  /** Exempt in the home country itself (Kleinunternehmer at home). */
  exemptAtHome: boolean;
  /** Uses the cross-border scheme: an EX number, or exempt in another EU country. */
  crossBorder: boolean;
}

function facts(profile: Profile): VatFacts {
  const home = countryCodeOf(profile?.artist?.countryOfOrigin);
  const vat = profile?.vat;
  const exempt = vat?.exemptCountries ?? [];
  return {
    home,
    scheme: vat?.scheme || (exempt.length ? 'sme' : ''),
    exemptAtHome: !!home && exempt.includes(home),
    crossBorder: !!vat?.exNumber?.trim() || exempt.some((c) => c !== home && EU_COUNTRIES.includes(c)),
  };
}

/** The deadline profile to start from, before it was ever saved. Fields the business never answered stay as they are. */
export function fromBusinessProfile(current: TaxDeadlineProfile, profile: Profile): TaxDeadlineProfile {
  const f = facts(profile);
  const next = { ...current };
  if (/^[A-Z]{2}$/.test(f.home)) {
    if (next.country !== f.home) next.region = '';
    next.country = f.home;
  }
  // On a scheme but no countries ticked yet: nearly always exempt at home.
  if (f.scheme === 'sme') next.vat = f.exemptAtHome || !profile?.vat?.exemptCountries?.length ? 'small-business' : 'regular';
  else if (f.scheme === 'vat') next.vat = 'regular';
  if (EU_COUNTRIES.includes(next.country)) next.euSmeScheme = f.crossBorder;
  if (next.vat !== 'regular') next.extension = false;
  return next;
}

/** Why the deadlines' VAT setup disagrees with Settings → VAT, in words, or null when they agree. */
export function vatMismatch(deadlines: TaxDeadlineProfile, profile: Profile): string | null {
  const f = facts(profile);
  if (f.home && deadlines.country !== f.home) return null; // a different business set-up on purpose; nothing to compare
  if (f.scheme === 'vat' && deadlines.vat === 'small-business') return 'Settings → VAT says you charge VAT, but this says Kleinunternehmer.';
  if (f.exemptAtHome && deadlines.vat === 'regular') return 'Settings → VAT has you exempt at home, but this says you charge VAT - you would be reminded of VAT returns you do not file.';
  if (f.crossBorder && EU_COUNTRIES.includes(deadlines.country) && !deadlines.euSmeScheme) return 'You have an EX number or are exempt abroad, so the quarterly SME scheme report is due - tick it below.';
  return null;
}
