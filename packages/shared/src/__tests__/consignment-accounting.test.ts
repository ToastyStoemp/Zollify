import { describe, expect, it } from 'vitest';
import { invoiceLines, invoiceNumber, invoiceTotal, isValidIban, normalizeIban, pain001, sepaText } from '../consignment-accounting';

describe('IBAN', () => {
  it('accepts real IBANs with or without spaces and rejects a changed digit', () => {
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('dk5000400440116243')).toBe(true);
    expect(isValidIban('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(isValidIban('')).toBe(false);
    expect(normalizeIban(' de89 3704 ')).toBe('DE893704');
  });
});

describe('invoice lines', () => {
  it('shows the sale, takes the commission and costs off, and totals what the artist earned', () => {
    const lines = invoiceLines({ gross: 100, discounts: 0, commission: 40, artistShare: 60, cardFees: 1.2, rent: 20, fees: 5 });
    expect(lines.map((l) => [l.kind, l.amount])).toEqual([['sales', 100], ['commission', -40], ['card_costs', -1.2], ['rent', -20], ['fees', -5]]);
    expect(invoiceTotal(lines)).toBe(33.8);
  });

  it('has no lines for a period with nothing in it, and numbers by year', () => {
    expect(invoiceLines({ gross: 0, discounts: 0, commission: 0, artistShare: 0, cardFees: 0, rent: 0, fees: 0 })).toEqual([]);
    expect(invoiceNumber('SB', '2026-09-30', 42)).toBe('SB-2026-00042');
    expect(invoiceNumber('', '2026-09-30', 1)).toBe('2026-00001');
  });
});

describe('pain.001.001.03', () => {
  const base = { messageId: 'MSG1', createdAt: new Date('2026-10-07T08:00:00.123Z'), executionDate: '2026-10-08', debtor: { name: 'Shop & Co', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' } };
  const pay = { reference: 'SB-2026-00001', name: 'Søren Ørsted', iban: 'DK5000400440116243', amount: 60, currency: 'EUR', remittance: 'Shop <Sept>' };

  it('builds a group header, SEPA block and transfer with control sums', () => {
    const xml = pain001({ ...base, payments: [pay, { ...pay, reference: 'SB-2026-00002', amount: 0.1 }] });
    expect(xml).toContain('<CreDtTm>2026-10-07T08:00:00</CreDtTm>');
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs><CtrlSum>60.10</CtrlSum>');
    expect(xml).toContain('<SvcLvl><Cd>SEPA</Cd></SvcLvl>');
    expect(xml).toContain('<Nm>Shop  Co</Nm>'.replace('  ', ' '));
    expect(xml).toContain('<Nm>Soren Orsted</Nm>');
    expect(xml).toContain('<Ustrd>Shop Sept</Ustrd>');
    expect(xml).toContain('<BIC>COBADEFFXXX</BIC>');
    expect(xml).not.toMatch(/[ØøÆæ&<](?![a-z]+;)[^>]*<\/Nm>/);
  });

  it('splits currencies into their own blocks and drops SEPA outside euro', () => {
    const xml = pain001({ ...base, payments: [pay, { ...pay, currency: 'DKK', reference: 'X' }] });
    expect(xml.match(/<PmtInf>/g)).toHaveLength(2);
    expect(xml.match(/<SvcLvl>/g)).toHaveLength(1);
  });

  it('refuses what a bank would reject', () => {
    expect(() => pain001({ ...base, debtor: { name: 'S', iban: 'bad' }, payments: [pay] })).toThrow(/IBAN/);
    expect(() => pain001({ ...base, payments: [{ ...pay, iban: 'DE00' }] })).toThrow(/valid IBAN/);
    expect(() => pain001({ ...base, payments: [] })).toThrow(/Nothing/);
  });

  it('folds text into the SEPA character set', () => {
    expect(sepaText('Æbleskiver & Øl – Åse', 40)).toBe('AEbleskiver Ol Ase');
  });
});
