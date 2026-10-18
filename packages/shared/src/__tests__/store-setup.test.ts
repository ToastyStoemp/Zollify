import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOKS_SETTINGS } from '../consignment-books';
import { booksFrom, storeSetupDefaults, storeSetupProblem, storeSetupSteps, storeVat } from '../store-setup';

const form = (extra: Partial<ReturnType<typeof storeSetupDefaults>> = {}) => ({
  ...storeSetupDefaults(DEFAULT_BOOKS_SETTINGS, { country: 'Denmark', currency: 'DKK', timeZone: 'Europe/Copenhagen' }),
  name: 'Loppehjørnet',
  ...extra,
});

describe('store setup', () => {
  it('asks the artist questions only of a store that sells other people\'s work', () => {
    expect(storeSetupSteps({ consignment: false })).toEqual(['store', 'vat', 'review']);
    expect(storeSetupSteps({ consignment: true })).toEqual(['store', 'vat', 'artists', 'money', 'review']);
  });

  it('names what stops a step', () => {
    expect(storeSetupProblem('store', form({ name: ' ' }))).toMatch(/name/);
    expect(storeSetupProblem('store', form({ currency: 'DK' }))).toMatch(/currency/);
    expect(storeSetupProblem('store', form())).toBeNull();
    expect(storeSetupProblem('vat', form({ vatStandard: '150' }))).toMatch(/VAT rate/);
    expect(storeSetupProblem('artists', form({ defaultCommissionPct: '' }))).toMatch(/Commission/);
    expect(storeSetupProblem('artists', form({ defaultCommissionPct: '101' }))).toMatch(/Commission/);
    expect(storeSetupProblem('artists', form({ artistDiscounts: false, artistDiscountMaxPct: '' }))).toBeNull();
    expect(storeSetupProblem('money', form({ timeZone: 'Mars/Base' }))).toMatch(/time zone/);
    expect(storeSetupProblem('money', form({ passCardFees: true, cardFeePct: '25' }))).toMatch(/Card costs/);
    expect(storeSetupProblem('money', form())).toBeNull();
  });

  it('leaves VAT automatic unless asked, and drops rates for an exempt store', () => {
    expect(storeVat(form())).toBeUndefined();
    expect(storeVat(form({ vatMode: 'charge', vatStandard: '25', vatReduced: '0' }))).toEqual({ mode: 'charge', standard: 25, reduced: 0 });
    expect(storeVat(form({ vatMode: 'exempt', vatStandard: '25' }))).toEqual({ mode: 'exempt' });
    expect(storeVat(form({ vatStandard: '12,5' }))).toEqual({ standard: 12.5 });
  });

  it('changes only what it asked about in the books', () => {
    const current = { ...DEFAULT_BOOKS_SETTINGS, accounting: { ...DEFAULT_BOOKS_SETTINGS.accounting, payerName: 'Loppehjørnet ApS', invoicePrefix: 'AF' } };
    const books = booksFrom(form({ consignment: true, defaultCommissionPct: '30', reportPeriod: 'biweekly', passCardFees: true, cardFeePct: '1,5', cardFeeFixed: '0.1' }), current);
    expect(books).toMatchObject({ defaultCommissionPct: 30, reportPeriod: 'biweekly', timeZone: 'Europe/Copenhagen', passCardFees: true, cardFeePct: 1.5, cardFeeFixed: 0.1 });
    expect(books.accounting).toEqual(current.accounting);
  });

  it('keeps the card costs already set when they are not passed on', () => {
    const current = { ...DEFAULT_BOOKS_SETTINGS, cardFeePct: 1.2, artistDiscountMaxPct: 20 };
    const books = booksFrom(form({ consignment: true, passCardFees: false, artistDiscounts: false, cardFeePct: '9' }), current);
    expect(books).toMatchObject({ cardFeePct: 1.2, passCardFees: false, artistDiscounts: false, artistDiscountMaxPct: 20 });
  });

  it('starts a second store from the books the first one set', () => {
    const f = storeSetupDefaults({ ...DEFAULT_BOOKS_SETTINGS, timeZone: 'Europe/Berlin', reportPeriod: 'biweekly', defaultCommissionPct: 35 }, { timeZone: 'Europe/Copenhagen' });
    expect(f).toMatchObject({ timeZone: 'Europe/Berlin', reportPeriod: 'biweekly', defaultCommissionPct: '35' });
  });
});

describe('number inputs', () => {
  it('reads a Number from a type="number" field the same as its text', async () => {
    const { storeSetupDefaults, storeSetupProblem, storeVat, booksFrom, STORE_SETUP_STEPS } = await import('../store-setup');
    const { BooksSettingsSchema } = await import('../consignment-books');
    const books = BooksSettingsSchema.parse({});
    const f = { ...storeSetupDefaults(books, {}), name: 'Shop', currency: 'EUR', consignment: true, timeZone: 'Europe/Brussels' } as never as ReturnType<typeof storeSetupDefaults>;
    (f as unknown as Record<string, unknown>).defaultCommissionPct = 30;
    (f as unknown as Record<string, unknown>).vatStandard = 21;
    (f as unknown as Record<string, unknown>).artistDiscountMaxPct = 15;
    for (const step of STORE_SETUP_STEPS) expect(storeSetupProblem(step, f)).toBeNull();
    expect(storeVat(f)).toEqual({ standard: 21 });
    expect(booksFrom(f, books).defaultCommissionPct).toBe(30);
  });
});
