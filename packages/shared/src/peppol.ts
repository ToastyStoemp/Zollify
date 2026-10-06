import { z } from 'zod';

/**
 * Belgian e-invoices over Peppol: Peppol BIS Billing 3.0 (UBL 2.1), the
 * format Belgian B2B invoices must use from 2026.
 *
 * Everything here is pure - checking Belgian numbers, computing totals by
 * the EN 16931 rules, validating a document against the rules that most
 * often reject one, and writing the UBL XML - so it is tested on its own and
 * the server only stores and numbers documents.
 */

export const PEPPOL_CUSTOMIZATION_ID = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
export const PEPPOL_PROFILE_ID = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

// ── Belgian numbers ─────────────────────────────────────────────────────────

const digits = (s: string): string => s.replace(/\D/g, '');

/** A Belgian enterprise number (KBO/BCE): 10 digits, the last two a mod-97 check on the first eight. */
/** Old 9-digit enterprise numbers are the same number without the leading 0. */
const enterpriseDigits = (raw: string): string => {
  const d = digits(raw);
  return d.length === 9 ? `0${d}` : d;
};

export function isBelgianEnterpriseNumber(raw: string): boolean {
  const d = enterpriseDigits(raw);
  if (d.length !== 10 || !/^[01]/.test(d)) return false;
  return 97 - (Number(d.slice(0, 8)) % 97) === Number(d.slice(8));
}

/** "BE0123.456.789" or "0123456789" → "BE0123456789", or null when it is not a valid Belgian VAT number. */
export function normaliseBelgianVat(raw: string): string | null {
  const d = enterpriseDigits(raw.replace(/^\s*BE/i, ''));
  return isBelgianEnterpriseNumber(d) ? `BE${d}` : null;
}

/** "0123.456.789" for display. */
export const formatEnterpriseNumber = (raw: string): string => {
  const d = digits(raw);
  return d.length === 10 ? `${d.slice(0, 4)}.${d.slice(4, 7)}.${d.slice(7)}` : raw;
};

/**
 * The Belgian structured payment reference ("gestructureerde mededeling",
 * +++123/4567/89002+++): ten digits and a mod-97 check (97 when the
 * remainder is 0). Banks match the payment to the invoice by it.
 */
export function structuredReference(base: number | string): string {
  const ten = digits(String(base)).slice(-10).padStart(10, '0');
  const check = Number(BigInt(ten) % 97n) || 97;
  const all = ten + String(check).padStart(2, '0');
  return `+++${all.slice(0, 3)}/${all.slice(3, 7)}/${all.slice(7)}+++`;
}
export function isStructuredReference(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 12) return false;
  return (Number(BigInt(d.slice(0, 10)) % 97n) || 97) === Number(d.slice(10));
}

/** IBAN checksum (ISO 13616, mod 97). */
export function isIban(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  const numeric = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

// ── The model ───────────────────────────────────────────────────────────────

/** Peppol participant identifier schemes most used here: Belgian enterprise number, Belgian VAT, Dutch KVK, GLN. */
export const PEPPOL_SCHEMES = ['0208', '9925', '0106', '0088', '9944', '0007', '0184', '9930'] as const;

const Country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
export const PeppolPartySchema = z.object({
  /** Required to issue (BR-06/BR-07), not to save a draft. */
  name: z.string().trim().max(200).default(''),
  /** VAT number with country prefix, e.g. BE0123456789; empty when not VAT-registered. */
  vatNumber: z.string().trim().max(30).default(''),
  /** Company registration number - for Belgium the enterprise number (KBO/BCE). */
  companyId: z.string().trim().max(30).default(''),
  street: z.string().trim().max(200).default(''),
  city: z.string().trim().max(100).default(''),
  postalCode: z.string().trim().max(20).default(''),
  country: Country.default('BE'),
  email: z.string().trim().max(200).default(''),
  /** Where the party receives Peppol documents: scheme and identifier, e.g. 0208 + 0123456789. */
  peppolScheme: z.string().trim().regex(/^\d{4}$/).default('0208'),
  peppolId: z.string().trim().max(60).default(''),
});
export type PeppolParty = z.infer<typeof PeppolPartySchema>;

export const PeppolSettingsSchema = PeppolPartySchema.extend({
  iban: z.string().trim().max(40).default(''),
  bic: z.string().trim().max(15).default(''),
  invoicePrefix: z.string().trim().max(12).regex(/^[\w-]*$/).default('INV'),
  creditPrefix: z.string().trim().max(12).regex(/^[\w-]*$/).default('CN'),
  paymentDays: z.number().int().min(0).max(365).default(30),
  /** Belgian small-business VAT exemption (art. 56bis): every line exempt, with the legal mention. */
  smallBusinessExempt: z.boolean().default(false),
  /** A note printed on every invoice, e.g. terms. */
  defaultNote: z.string().max(1000).default(''),
});
export type PeppolSettings = z.infer<typeof PeppolSettingsSchema>;
/** Settings before the business has filled anything in (the name is required to save, not to start). */
export const emptyPeppolSettings = (): PeppolSettings => PeppolSettingsSchema.parse({});

/**
 * VAT categories (UNCL5305 as Peppol uses them): S standard, Z zero rated,
 * E exempt, AE reverse charge, K intra-EU supply, G export, O not subject.
 */
export const VAT_CATEGORIES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];
export const VAT_CATEGORY_LABELS: Record<VatCategory, string> = {
  S: 'Standard rate',
  Z: 'Zero rated',
  E: 'Exempt',
  AE: 'Reverse charge (co-contractor)',
  K: 'Intra-EU supply',
  G: 'Export outside the EU',
  O: 'Not subject to VAT',
};
/** Belgian VAT rates. */
export const BELGIAN_VAT_RATES = [21, 12, 6, 0] as const;

/** Why a line carries no VAT, as the invoice must say. */
export const EXEMPTION_REASONS: Partial<Record<VatCategory, { code: string; text: string }>> = {
  AE: { code: 'VATEX-EU-AE', text: 'Verlegging van heffing - autoliquidation (art. 51 §2 WBTW/Code TVA)' },
  K: { code: 'VATEX-EU-IC', text: 'Intracommunautaire levering - livraison intracommunautaire (art. 39bis WBTW/Code TVA)' },
  G: { code: 'VATEX-EU-G', text: 'Export outside the EU (art. 39 WBTW/Code TVA)' },
  O: { code: 'VATEX-EU-O', text: 'Not subject to VAT' },
};
export const SMALL_BUSINESS_MENTION = 'Bijzondere vrijstellingsregeling kleine ondernemingen - Régime particulier de franchise des petites entreprises (art. 56bis WBTW/Code TVA)';

export const PeppolLineSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.number().min(-1_000_000).max(1_000_000).refine((q) => q !== 0, 'Quantity cannot be zero.'),
  /** UN/ECE Rec 20: C62 one/unit, H87 piece, HUR hour, DAY day, KGM kilogram, MTR metre, LS lump sum. */
  unitCode: z.string().trim().regex(/^[A-Z0-9]{1,3}$/).default('C62'),
  /** Net unit price, excluding VAT. */
  unitPrice: z.number().min(0).max(100_000_000),
  vatCategory: z.enum(VAT_CATEGORIES).default('S'),
  vatRate: z.number().min(0).max(100).default(21),
});
export type PeppolLine = z.infer<typeof PeppolLineSchema>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const PeppolDocumentInputSchema = z.object({
  kind: z.enum(['invoice', 'credit']).default('invoice'),
  issueDate: IsoDate,
  dueDate: IsoDate.optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR'),
  buyer: PeppolPartySchema,
  /** The buyer's reference (BT-10) - Peppol needs it or an order reference. */
  buyerReference: z.string().trim().max(200).default(''),
  orderReference: z.string().trim().max(200).default(''),
  lines: z.array(PeppolLineSchema).min(1).max(500),
  note: z.string().max(1000).default(''),
  /** When the goods or services were delivered, if not the invoice date (needed for intra-EU supplies). */
  deliveryDate: IsoDate.optional(),
  /** For a credit note: the invoice it corrects. */
  invoiceRef: z.object({ number: z.string().max(60), issueDate: IsoDate }).nullable().default(null),
  /** The till sale it was made from, if any. */
  saleId: z.string().max(100).nullable().default(null),
});
export type PeppolDocumentInput = z.infer<typeof PeppolDocumentInputSchema>;

export type PeppolStatus = 'draft' | 'issued' | 'sent' | 'paid';
export interface PeppolDocument extends PeppolDocumentInput {
  id: string;
  /** Assigned when issued, never before: drafts have no number, so the sequence has no gaps. */
  number: string | null;
  status: PeppolStatus;
  /** Structured payment reference, set when issued. */
  paymentReference: string | null;
  createdAt: number;
  updatedAt: number;
  issuedAt: number | null;
  /** Set once sent over Peppol: through which access point, when, and its reference. */
  sentVia?: { provider: string; at: number; reference: string | null };
}

// ── Totals (EN 16931 calculation rules) ─────────────────────────────────────

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface VatBreakdown {
  category: VatCategory;
  rate: number;
  taxable: number;
  tax: number;
}
export interface PeppolTotals {
  lines: number[];
  /** Sum of line net amounts (BT-106). */
  lineExtension: number;
  taxExclusive: number;
  tax: number;
  taxInclusive: number;
  payable: number;
  breakdown: VatBreakdown[];
}

/** Line nets rounded to cents, VAT per category and rate on the summed nets (BR-CO-10, BR-CO-14, BR-S-08…). */
export function peppolTotals(lines: Pick<PeppolLine, 'quantity' | 'unitPrice' | 'vatCategory' | 'vatRate'>[]): PeppolTotals {
  const nets = lines.map((l) => r2(l.quantity * l.unitPrice));
  const groups = new Map<string, VatBreakdown>();
  lines.forEach((l, i) => {
    const rate = l.vatCategory === 'S' ? l.vatRate : 0;
    const key = `${l.vatCategory}|${rate}`;
    const g = groups.get(key) ?? { category: l.vatCategory, rate, taxable: 0, tax: 0 };
    g.taxable = r2(g.taxable + nets[i]!);
    groups.set(key, g);
  });
  const breakdown = [...groups.values()].map((g) => ({ ...g, tax: r2((g.taxable * g.rate) / 100) }));
  const lineExtension = r2(nets.reduce((s, n) => s + n, 0));
  const tax = r2(breakdown.reduce((s, g) => s + g.tax, 0));
  return { lines: nets, lineExtension, taxExclusive: lineExtension, tax, taxInclusive: r2(lineExtension + tax), payable: r2(lineExtension + tax), breakdown };
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface PeppolProblem {
  /** The rule it breaks: a Peppol/EN 16931 rule id where there is one. */
  rule: string;
  message: string;
}

/**
 * What would get the document rejected, checked before it is issued: the
 * Peppol and EN 16931 rules that most often fail, and Belgian number checks.
 * Not a full Schematron run - the receiving access point does that - but it
 * catches what a person can fix in the form.
 */
export function validatePeppol(doc: PeppolDocumentInput, seller: PeppolSettings): PeppolProblem[] {
  const out: PeppolProblem[] = [];
  const add = (rule: string, message: string): void => void out.push({ rule, message });

  if (!seller.name) add('BR-06', 'Your business name is missing (Settings).');
  if (!seller.street || !seller.city || !seller.postalCode) add('BR-08', 'Your address is incomplete (Settings).');
  if (!seller.peppolId) add('PEPPOL-EN16931-R020', 'Your Peppol identifier is missing (Settings) - for Belgium usually your enterprise number.');
  if (seller.country === 'BE') {
    if (!isBelgianEnterpriseNumber(seller.companyId)) add('BE-KBO', 'Your enterprise number (KBO/BCE) is not valid.');
    // Small businesses under the franchise still have a VAT number (BE + enterprise number), and must state it.
    if (!sellerVat(seller)) add('BR-CO-09', 'Your Belgian VAT number is not valid.');
  }
  if (seller.peppolScheme === '0208' && seller.peppolId && !isBelgianEnterpriseNumber(seller.peppolId)) add('PEPPOL-COMMON-R043', 'Your Peppol identifier (scheme 0208) must be a valid enterprise number.');
  if (seller.iban && !isIban(seller.iban)) add('BR-50', 'Your IBAN is not valid.');
  if (!seller.iban) add('BR-50', 'Add your IBAN (Settings) so the buyer can pay by transfer.');

  const b = doc.buyer;
  if (!b.name) add('BR-07', "The buyer's name is missing.");
  if (!b.country) add('BR-11', "The buyer's country is missing.");
  if (!b.peppolId) add('PEPPOL-EN16931-R010', "The buyer's Peppol identifier is missing - for a Belgian company, its enterprise number.");
  if (b.peppolScheme === '0208' && b.peppolId && !isBelgianEnterpriseNumber(b.peppolId)) add('PEPPOL-COMMON-R043', "The buyer's Peppol identifier (scheme 0208) must be a valid enterprise number.");
  if (b.country === 'BE' && b.vatNumber && !normaliseBelgianVat(b.vatNumber)) add('BR-CO-09', "The buyer's Belgian VAT number is not valid.");
  if (!doc.buyerReference && !doc.orderReference) add('PEPPOL-EN16931-R003', "Add the buyer's reference or an order number - Peppol needs one of them (if the buyer gave none, their name or your customer number will do).");

  if (doc.dueDate && doc.dueDate < doc.issueDate) add('BR-CO-25', 'The due date is before the invoice date.');
  if (doc.kind === 'credit' && !doc.invoiceRef) add('BR-55', 'A credit note must name the invoice it corrects.');
  if (doc.currency !== 'EUR' && seller.country === 'BE') add('BE-CUR', 'Belgian invoices are normally in EUR; VAT must then also be stated in EUR, which this module does not do.');

  doc.lines.forEach((l, i) => {
    const n = i + 1;
    if (seller.smallBusinessExempt && l.vatCategory !== 'E') add('BE-56BIS', `Line ${n}: under the small-business exemption every line is exempt (E).`);
    if (l.vatCategory === 'S' && !(l.vatRate > 0)) add('BR-S-05', `Line ${n}: standard-rated lines need a VAT rate above 0.`);
    if (l.vatCategory !== 'S' && l.vatRate !== 0) add('BR-Z-05', `Line ${n}: only standard-rated lines carry a VAT rate.`);
    if (l.vatCategory === 'AE' && (!b.vatNumber || !seller.vatNumber)) add('BR-AE-02', `Line ${n}: reverse charge needs both your and the buyer's VAT numbers.`);
    if (l.vatCategory === 'K' && (!b.vatNumber || b.country === seller.country)) add('BR-IC-02', `Line ${n}: an intra-EU supply needs a buyer in another EU country with a VAT number.`);
    if (doc.kind === 'invoice' && l.quantity < 0 && l.unitPrice > 0 && !seller.smallBusinessExempt) {
      // Allowed in UBL, but a negative invoice is a credit note in Belgian practice.
      add('BE-NEG', `Line ${n}: use a credit note to take something back.`);
    }
  });
  const totals = peppolTotals(doc.lines);
  if (doc.kind === 'invoice' && totals.payable < 0) add('BR-CO-16', 'The invoice total is negative - make a credit note instead.');
  return out;
}

/** The seller's VAT number as stated: for a Belgian seller, BE + the enterprise number when none was entered. */
export function sellerVat(seller: Pick<PeppolSettings, 'country' | 'vatNumber' | 'companyId'>): string | null {
  if (seller.country !== 'BE') return seller.vatNumber || null;
  return normaliseBelgianVat(seller.vatNumber) ?? (seller.vatNumber ? null : normaliseBelgianVat(seller.companyId));
}

// ── UBL ─────────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const amt = (n: number): string => r2(n).toFixed(2);
const qty = (n: number): string => String(Math.round(n * 10000) / 10000);

function party(p: PeppolParty, role: 'supplier' | 'customer', vatOverride?: string | null): string {
  const vat = vatOverride ?? (p.country === 'BE' ? (normaliseBelgianVat(p.vatNumber) ?? p.vatNumber) : p.vatNumber);
  const companyId = p.companyId ? (p.country === 'BE' ? enterpriseDigits(p.companyId) : p.companyId) : '';
  const tag = role === 'supplier' ? 'cac:AccountingSupplierParty' : 'cac:AccountingCustomerParty';
  return `  <${tag}>
    <cac:Party>
      <cbc:EndpointID schemeID="${esc(p.peppolScheme)}">${esc(p.peppolScheme === '0208' ? enterpriseDigits(p.peppolId) : p.peppolId)}</cbc:EndpointID>
      <cac:PostalAddress>
${p.street ? `        <cbc:StreetName>${esc(p.street)}</cbc:StreetName>\n` : ''}${p.city ? `        <cbc:CityName>${esc(p.city)}</cbc:CityName>\n` : ''}${p.postalCode ? `        <cbc:PostalZone>${esc(p.postalCode)}</cbc:PostalZone>\n` : ''}        <cac:Country><cbc:IdentificationCode>${esc(p.country)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
${vat ? `      <cac:PartyTaxScheme>\n        <cbc:CompanyID>${esc(vat)}</cbc:CompanyID>\n        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>\n      </cac:PartyTaxScheme>\n` : ''}      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>
${companyId ? `        <cbc:CompanyID${p.country === 'BE' ? ' schemeID="0208"' : ''}>${esc(companyId)}</cbc:CompanyID>\n` : ''}      </cac:PartyLegalEntity>
${p.email ? `      <cac:Contact><cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail></cac:Contact>\n` : ''}    </cac:Party>
  </${tag}>
`;
}

function taxCategory(tag: string, category: VatCategory, rate: number, withReason: boolean, smallBusiness: boolean): string {
  const reason = category === 'E' ? (smallBusiness ? { code: '', text: SMALL_BUSINESS_MENTION } : { code: '', text: 'Exempt from VAT' }) : EXEMPTION_REASONS[category];
  return `<${tag}>
          <cbc:ID>${category}</cbc:ID>
${category === 'O' ? '' : `          <cbc:Percent>${qty(rate)}</cbc:Percent>\n`}${withReason && reason ? `${reason.code ? `          <cbc:TaxExemptionReasonCode>${reason.code}</cbc:TaxExemptionReasonCode>\n` : ''}          <cbc:TaxExemptionReason>${esc(reason.text)}</cbc:TaxExemptionReason>\n` : ''}          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </${tag}>`;
}

/** The document as Peppol BIS Billing 3.0 UBL: an Invoice (380) or a CreditNote (381). */
export function peppolUbl(doc: PeppolDocument, seller: PeppolSettings): string {
  const credit = doc.kind === 'credit';
  const root = credit ? 'CreditNote' : 'Invoice';
  const totals = peppolTotals(doc.lines);
  const small = seller.smallBusinessExempt;
  // Peppol allows one document note (PEPPOL-EN16931-R002): everything goes in it.
  const note = [doc.note, seller.defaultNote, small ? SMALL_BUSINESS_MENTION : ''].filter(Boolean).join('\n');
  const intraEu = doc.lines.some((l) => l.vatCategory === 'K');
  const deliveryDate = doc.deliveryDate ?? (intraEu ? doc.issueDate : undefined);
  const cur = esc(doc.currency);
  const lineTag = credit ? 'cac:CreditNoteLine' : 'cac:InvoiceLine';
  const qtyTag = credit ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';

  const lines = doc.lines
    .map(
      (l, i) => `  <${lineTag}>
    <cbc:ID>${i + 1}</cbc:ID>
    <${qtyTag} unitCode="${esc(l.unitCode)}">${qty(l.quantity)}</${qtyTag}>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(totals.lines[i]!)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(l.description.slice(0, 200))}</cbc:Name>
      ${taxCategory('cac:ClassifiedTaxCategory', l.vatCategory, l.vatCategory === 'S' ? l.vatRate : 0, false, small)}
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${cur}">${l.unitPrice.toFixed(Math.max(2, (String(l.unitPrice).split('.')[1] ?? '').length))}</cbc:PriceAmount>
    </cac:Price>
  </${lineTag}>
`,
    )
    .join('');

  const subtotals = totals.breakdown
    .map(
      (g) => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${amt(g.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${amt(g.tax)}</cbc:TaxAmount>
      ${taxCategory('cac:TaxCategory', g.category, g.rate, g.category !== 'S' && g.category !== 'Z', small)}
    </cac:TaxSubtotal>
`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${PEPPOL_CUSTOMIZATION_ID}</cbc:CustomizationID>
  <cbc:ProfileID>${PEPPOL_PROFILE_ID}</cbc:ProfileID>
  <cbc:ID>${esc(doc.number ?? 'DRAFT')}</cbc:ID>
  <cbc:IssueDate>${doc.issueDate}</cbc:IssueDate>
${!credit && doc.dueDate ? `  <cbc:DueDate>${doc.dueDate}</cbc:DueDate>\n` : ''}  <cbc:${root}TypeCode>${credit ? '381' : '380'}</cbc:${root}TypeCode>
${note ? `  <cbc:Note>${esc(note)}</cbc:Note>\n` : ''}  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
${doc.buyerReference ? `  <cbc:BuyerReference>${esc(doc.buyerReference)}</cbc:BuyerReference>\n` : ''}${doc.orderReference ? `  <cac:OrderReference><cbc:ID>${esc(doc.orderReference)}</cbc:ID></cac:OrderReference>\n` : ''}${credit && doc.invoiceRef ? `  <cac:BillingReference>\n    <cac:InvoiceDocumentReference>\n      <cbc:ID>${esc(doc.invoiceRef.number)}</cbc:ID>\n      <cbc:IssueDate>${doc.invoiceRef.issueDate}</cbc:IssueDate>\n    </cac:InvoiceDocumentReference>\n  </cac:BillingReference>\n` : ''}${party(seller, 'supplier', sellerVat(seller))}${party(doc.buyer, 'customer')}${
    deliveryDate
      ? `  <cac:Delivery>\n    <cbc:ActualDeliveryDate>${deliveryDate}</cbc:ActualDeliveryDate>\n${intraEu ? `    <cac:DeliveryLocation>\n      <cac:Address>\n        <cac:Country><cbc:IdentificationCode>${esc(doc.buyer.country)}</cbc:IdentificationCode></cac:Country>\n      </cac:Address>\n    </cac:DeliveryLocation>\n` : ''}  </cac:Delivery>\n`
      : ''
  }${seller.iban ? `  <cac:PaymentMeans>
    <cbc:PaymentMeansCode name="Credit transfer">30</cbc:PaymentMeansCode>
${doc.paymentReference ? `    <cbc:PaymentID>${esc(doc.paymentReference)}</cbc:PaymentID>\n` : ''}    <cac:PayeeFinancialAccount>
      <cbc:ID>${esc(seller.iban.replace(/\s+/g, '').toUpperCase())}</cbc:ID>
      <cbc:Name>${esc(seller.name)}</cbc:Name>
${seller.bic ? `      <cac:FinancialInstitutionBranch><cbc:ID>${esc(seller.bic)}</cbc:ID></cac:FinancialInstitutionBranch>\n` : ''}    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
` : ''}${!credit && doc.dueDate ? `  <cac:PaymentTerms><cbc:Note>Payable by ${doc.dueDate}</cbc:Note></cac:PaymentTerms>\n` : ''}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${amt(totals.tax)}</cbc:TaxAmount>
${subtotals}  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(totals.lineExtension)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${amt(totals.taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${amt(totals.taxInclusive)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${amt(totals.payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}</${root}>
`;
}
