import { describe, expect, it } from 'vitest';
import {
  PeppolSettingsSchema,
  isBelgianEnterpriseNumber,
  isIban,
  isStructuredReference,
  normaliseBelgianVat,
  peppolTotals,
  peppolUbl,
  structuredReference,
  validatePeppol,
  type PeppolDocument,
} from '../index';

/** A valid enterprise number for any 8-digit base, by the mod-97 rule. */
const kbo = (base8: string): string => `${base8}${String(97 - (Number(base8) % 97)).padStart(2, '0')}`;
const SELLER_KBO = kbo('04031707');
const BUYER_KBO = kbo('08765432');

const seller = PeppolSettingsSchema.parse({
  name: 'Kunsthaus BV',
  vatNumber: `BE${SELLER_KBO}`,
  companyId: SELLER_KBO,
  street: 'Rue Haute 1',
  city: 'Brussels',
  postalCode: '1000',
  country: 'BE',
  peppolScheme: '0208',
  peppolId: SELLER_KBO,
  iban: 'BE68 5390 0754 7034',
});
const doc: PeppolDocument = {
  id: 'd1',
  kind: 'invoice',
  number: 'INV-2026-0001',
  status: 'issued',
  issueDate: '2026-10-06',
  dueDate: '2026-11-05',
  currency: 'EUR',
  buyer: { name: 'Café <Lumière> & Co', vatNumber: `BE${BUYER_KBO}`, companyId: BUYER_KBO, street: 'Meir 2', city: 'Antwerp', postalCode: '2000', country: 'BE', email: '', peppolScheme: '0208', peppolId: BUYER_KBO },
  buyerReference: 'PO-77',
  orderReference: '',
  lines: [
    { description: 'Fox print A4', quantity: 2, unitCode: 'C62', unitPrice: 100, vatCategory: 'S', vatRate: 21 },
    { description: 'Art book', quantity: 1, unitCode: 'C62', unitPrice: 49.99, vatCategory: 'S', vatRate: 6 },
  ],
  note: '',
  invoiceRef: null,
  saleId: null,
  paymentReference: structuredReference(20260001),
  createdAt: 0,
  updatedAt: 0,
  issuedAt: 0,
};

describe('Belgian numbers', () => {
  it('checks enterprise and VAT numbers by mod 97', () => {
    expect(isBelgianEnterpriseNumber(SELLER_KBO)).toBe(true);
    expect(isBelgianEnterpriseNumber(`${SELLER_KBO.slice(0, 9)}${(Number(SELLER_KBO[9]) + 1) % 10}`)).toBe(false);
    expect(normaliseBelgianVat(`be ${SELLER_KBO.slice(0, 4)}.${SELLER_KBO.slice(4, 7)}.${SELLER_KBO.slice(7)}`)).toBe(`BE${SELLER_KBO}`);
    expect(normaliseBelgianVat('BE0123456789')).toBeNull();
  });

  it('makes and checks structured payment references, and IBANs', () => {
    const ref = structuredReference(20260001);
    expect(ref).toMatch(/^\+\+\+\d{3}\/\d{4}\/\d{5}\+\+\+$/);
    expect(isStructuredReference(ref)).toBe(true);
    expect(isStructuredReference(ref.replace(/\d(?=\+\+\+$)/, (d) => String((Number(d) + 1) % 10)))).toBe(false);
    expect(isIban('BE68 5390 0754 7034')).toBe(true);
    expect(isIban('BE68 5390 0754 7035')).toBe(false);
  });
});

describe('totals', () => {
  it('rounds line nets, then VAT per rate on the sums', () => {
    const t = peppolTotals(doc.lines);
    expect(t).toMatchObject({ lineExtension: 249.99, tax: 45, taxInclusive: 294.99, payable: 294.99 });
    expect(t.breakdown).toEqual([
      { category: 'S', rate: 21, taxable: 200, tax: 42 },
      { category: 'S', rate: 6, taxable: 49.99, tax: 3 },
    ]);
  });
});

describe('validation', () => {
  it('passes a complete invoice', () => {
    expect(validatePeppol(doc, seller)).toEqual([]);
  });

  it('catches what Peppol would reject', () => {
    const problems = validatePeppol(
      { ...doc, buyerReference: '', buyer: { ...doc.buyer, peppolId: '' }, lines: [{ ...doc.lines[0]!, vatCategory: 'S', vatRate: 0 }] },
      { ...seller, iban: 'BE00 0000' },
    ).map((p) => p.rule);
    expect(problems).toEqual(expect.arrayContaining(['PEPPOL-EN16931-R003', 'PEPPOL-EN16931-R010', 'BR-S-05', 'BR-50']));
  });

  it('requires the exemption on every line for a small business, and a reference for a credit note', () => {
    const small = { ...seller, smallBusinessExempt: true, vatNumber: '' };
    expect(validatePeppol(doc, small).map((p) => p.rule)).toContain('BE-56BIS');
    const exempt = { ...doc, lines: doc.lines.map((l) => ({ ...l, vatCategory: 'E' as const, vatRate: 0 })) };
    expect(validatePeppol(exempt, small)).toEqual([]);
    expect(validatePeppol({ ...doc, kind: 'credit' }, seller).map((p) => p.rule)).toContain('BR-55');
  });
});

describe('UBL', () => {
  it('writes a BIS 3.0 invoice with escaped text and matching totals', () => {
    const xml = peppolUbl(doc, seller);
    expect(xml).toContain('<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>');
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(xml).toContain(`<cbc:EndpointID schemeID="0208">${BUYER_KBO}</cbc:EndpointID>`);
    expect(xml).toContain('Café &lt;Lumière&gt; &amp; Co');
    expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">294.99</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:PriceAmount currencyID="EUR">49.99</cbc:PriceAmount>');
    expect(xml).toContain(`<cbc:CompanyID>BE${SELLER_KBO}</cbc:CompanyID>`);
    expect(xml).toContain('<cbc:PaymentID>+++');
  });

  it('writes a credit note referring to its invoice, and the small-business mention', () => {
    const xml = peppolUbl(
      { ...doc, kind: 'credit', number: 'CN-2026-0001', invoiceRef: { number: 'INV-2026-0001', issueDate: '2026-10-06' }, lines: doc.lines.map((l) => ({ ...l, vatCategory: 'E' as const, vatRate: 0 })) },
      { ...seller, smallBusinessExempt: true, vatNumber: '' },
    );
    expect(xml).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(xml).toContain('<cbc:CreditedQuantity unitCode="C62">2</cbc:CreditedQuantity>');
    expect(xml).toContain('<cbc:ID>INV-2026-0001</cbc:ID>');
    expect(xml).toContain('art. 56bis');
    // An exempt Belgian seller still states its VAT number (BR-E-02), derived from the enterprise number.
    const supplier = xml.slice(xml.indexOf('<cac:AccountingSupplierParty>'), xml.indexOf('</cac:AccountingSupplierParty>'));
    expect(supplier).toContain(`<cbc:CompanyID>BE${SELLER_KBO}</cbc:CompanyID>`);
    expect(xml.match(/<cbc:Note>/g)).toHaveLength(1);
  });
});
