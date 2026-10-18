import { BooksSettingsSchema, isTimeZone, type BooksSettings } from './consignment-books';
import type { EventVat } from './vat';

/**
 * The questions a new store is set up with, and how the answers become the
 * store's own settings (its VAT) and the account's consignment books. Every
 * field is what the person typed, as text, so a half-filled form is never
 * lost; `storeSetupProblem` says what stops a step, `storeVat` and `booksFrom`
 * read the answers once they pass.
 */

export const STORE_SETUP_STEPS = ['store', 'vat', 'artists', 'money', 'review'] as const;
export type StoreSetupStep = (typeof STORE_SETUP_STEPS)[number];

export interface StoreSetupForm {
  name: string;
  street: string;
  postcode: string;
  city: string;
  country: string;
  currency: string;
  vatMode: 'auto' | 'charge' | 'exempt';
  /** Blank = the country's rate. */
  vatStandard: string;
  vatReduced: string;
  /** The store sells other people's work, so the consignment books apply. */
  consignment: boolean;
  defaultCommissionPct: string;
  artistDiscounts: boolean;
  artistDiscountMaxPct: string;
  reportPeriod: 'biweekly' | 'monthly';
  emailReport: boolean;
  timeZone: string;
  passCardFees: boolean;
  cardFeePct: string;
  cardFeeFixed: string;
}

/** The steps a store with these answers goes through: no artist questions for a store selling only its own work. */
export const storeSetupSteps = (f: Pick<StoreSetupForm, 'consignment'>): StoreSetupStep[] =>
  STORE_SETUP_STEPS.filter((s) => f.consignment || (s !== 'artists' && s !== 'money'));

// The form's number inputs hand back a Number once typed in (v-model on type="number"),
// a string while untouched; both must read the same.
const text = (v: string | number): string => (typeof v === 'number' ? String(v) : (v ?? '')).trim();
const num = (v: string | number): number => (text(v) === '' ? NaN : Number(text(v).replace(',', '.')));
const within = (v: string | number, min: number, max: number): boolean => num(v) >= min && num(v) <= max;
const rateOk = (v: string | number): boolean => text(v) === '' || within(v, 0, 99.99);

/** Why this step cannot be left yet, in words for the person, or null. */
export function storeSetupProblem(step: StoreSetupStep, f: StoreSetupForm): string | null {
  switch (step) {
    case 'store':
      if (!f.name.trim()) return 'Give the store a name.';
      if (!/^[A-Za-z]{3}$/.test(f.currency.trim())) return 'Pick the currency the store sells in.';
      return null;
    case 'vat':
      return rateOk(f.vatStandard) && rateOk(f.vatReduced) ? null : 'A VAT rate is a percentage between 0 and 99.';
    case 'artists':
      if (!within(f.defaultCommissionPct, 0, 100)) return 'Commission is a percentage between 0 and 100.';
      if (f.artistDiscounts && !within(f.artistDiscountMaxPct, 1, 100)) return 'The deepest discount is a percentage between 1 and 100.';
      return null;
    case 'money':
      if (!isTimeZone(f.timeZone.trim())) return 'Pick the time zone the store is in.';
      if (f.passCardFees && !(within(f.cardFeePct || '0', 0, 20) && within(f.cardFeeFixed || '0', 0, 100))) return 'Card costs are a percentage up to 20 and a fixed amount up to 100.';
      return null;
    default:
      return null;
  }
}

/** The store's own VAT setting; absent when everything is automatic. */
export function storeVat(f: Pick<StoreSetupForm, 'vatMode' | 'vatStandard' | 'vatReduced'>): EventVat | undefined {
  const vat: EventVat = {};
  if (f.vatMode !== 'auto') vat.mode = f.vatMode;
  if (f.vatMode !== 'exempt') {
    if (text(f.vatStandard) !== '' && rateOk(f.vatStandard)) vat.standard = num(f.vatStandard);
    if (text(f.vatReduced) !== '' && rateOk(f.vatReduced)) vat.reduced = num(f.vatReduced);
  }
  return Object.keys(vat).length ? vat : undefined;
}

/**
 * The consignment books after these answers. Only what the wizard asks about
 * changes; the payout account, invoice numbering and ledger accounts already
 * set stay as they are, because the books are the account's, not one store's.
 */
export function booksFrom(f: StoreSetupForm, current: BooksSettings): BooksSettings {
  return BooksSettingsSchema.parse({
    ...current,
    defaultCommissionPct: num(f.defaultCommissionPct),
    artistDiscounts: f.artistDiscounts,
    artistDiscountMaxPct: f.artistDiscounts ? num(f.artistDiscountMaxPct) : current.artistDiscountMaxPct,
    reportPeriod: f.reportPeriod,
    emailReport: f.emailReport,
    timeZone: f.timeZone.trim(),
    passCardFees: f.passCardFees,
    cardFeePct: f.passCardFees ? num(f.cardFeePct || '0') : current.cardFeePct,
    cardFeeFixed: f.passCardFees ? num(f.cardFeeFixed || '0') : current.cardFeeFixed,
  });
}

/** The answers a store starts from: the books already set, so a second store shows what the first chose. */
export function storeSetupDefaults(books: BooksSettings, base: { country?: string; currency?: string; timeZone?: string }): StoreSetupForm {
  return {
    name: '',
    street: '',
    postcode: '',
    city: '',
    country: base.country ?? '',
    currency: base.currency ?? '',
    vatMode: 'auto',
    vatStandard: '',
    vatReduced: '',
    consignment: false,
    defaultCommissionPct: String(books.defaultCommissionPct),
    artistDiscounts: books.artistDiscounts,
    artistDiscountMaxPct: String(books.artistDiscountMaxPct),
    reportPeriod: books.reportPeriod,
    emailReport: books.emailReport,
    // The books default to UTC until someone says where the store is.
    timeZone: books.timeZone !== 'UTC' ? books.timeZone : (base.timeZone ?? 'UTC'),
    passCardFees: books.passCardFees,
    cardFeePct: String(books.cardFeePct),
    cardFeeFixed: String(books.cardFeeFixed),
  };
}
