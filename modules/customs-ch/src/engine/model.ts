/**
 * Customs state model - mirrors the legacy v1 state shape exactly, because the
 * document generators are legal-consequence code verified byte-for-byte
 * against the old app. The adapter builds this from v2 data.
 */

export interface CustomsMeta {
  event: string;
  eventDateStart: string;
  eventDateEnd: string;
  eventLocation: string;
  companyCode: string;
  lrp: string;
  documentNumber: number;
  venueName: string;
  venueStreet: string;
  venuePostcode: string;
  venueCity: string;
  venueCountry: string;
  venueTIN: string;
  currency: string;
  /** Delivery term shown on the EU-compliant proforma, e.g. "EXW Berlin" (Incoterms 2020) - self-transported, self-consigned goods have no real buyer/seller split, so EXW at the exporter's own address is the defensible default. Required on the invoice by German export brokers. */
  incoterms: string;
}

export interface CustomsArtist {
  companyName: string;
  fullName: string;
  street: string;
  postCodeCity: string;
  countryOfOrigin: string;
  phone: string;
  email: string;
  /** Seller VAT/tax identifier - EN 16931 seller identifier field, expected on an EU-compliant invoice. */
  vatId: string;
}

export interface CustomsEdec {
  transportMode: string;
  transportationType: string;
  transportationCountry: string;
  transportationNumber: string;
  flightNumber: string;
  registrationPostcode: string;
  importerCountry: string;
}

export interface CustomsForm1174 {
  groupMode: 'auto' | 'manual';
  /** Parallel to products: 1 = group 1, anything else = group 2. */
  assignments: number[];
}

/** Numeric-ish: the legacy app stored raw input values, sometimes strings. */
export type NumLike = number | string | null | undefined;

export interface CustomsVariant {
  name?: string;
  sku?: string;
  price?: NumLike;
  weightG?: NumLike;
  unlisted?: boolean;
  amount?: number;
  soldQty?: number;
  soldValue?: number;
  /** Overrides the product's material for this variant only, when set. */
  material?: string;
}

export interface CustomsProduct {
  id?: string;
  title?: string;
  sku?: string;
  type?: string;
  forSale?: boolean;
  unlisted?: boolean;
  price?: NumLike;
  priceNote?: string;
  weightG?: NumLike;
  totalValueCHF?: NumLike;
  tariffNo?: string;
  tariffRate?: NumLike;
  vatRate?: NumLike;
  packagingType?: string;
  originCountry?: string;
  permitOverride?: number | null;
  /** Year an art print was produced - shown as "Title (Year)" on customs docs. */
  year?: number;
  /** Material composition - shown as "Title - Material" on customs docs.
   *  A variant's own material (CustomsVariant.material) overrides this. */
  material?: string;
  amount?: number;
  soldQty?: number;
  soldValue?: number;
  variants?: CustomsVariant[];
}

export interface CustomsState {
  meta: CustomsMeta;
  artist: CustomsArtist;
  edec: CustomsEdec;
  form1174: CustomsForm1174;
  products: CustomsProduct[];
}

export function defaultCustomsMeta(): CustomsMeta {
  return {
    event: '',
    eventDateStart: '',
    eventDateEnd: '',
    eventLocation: '',
    companyCode: '',
    lrp: '',
    documentNumber: 1,
    venueName: '',
    venueStreet: '',
    venuePostcode: '',
    venueCity: '',
    venueCountry: 'Switzerland',
    venueTIN: 'CHE222251936',
    currency: 'CHF',
    incoterms: '',
  };
}

export function defaultCustomsArtist(): CustomsArtist {
  return {
    companyName: '',
    fullName: '',
    street: '',
    postCodeCity: '',
    countryOfOrigin: '',
    phone: '',
    email: '',
    vatId: '',
  };
}

export function defaultCustomsEdec(): CustomsEdec {
  return {
    transportMode: '3',
    transportationType: '1',
    transportationCountry: '',
    transportationNumber: '',
    flightNumber: '',
    registrationPostcode: '',
    importerCountry: 'CH',
  };
}

export function defaultCustomsForm1174(): CustomsForm1174 {
  return { groupMode: 'auto', assignments: [] };
}
