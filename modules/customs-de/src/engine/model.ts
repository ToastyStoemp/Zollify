/**
 * Customs (Germany / ATLAS) state model.
 *
 * Deliberately thin: this module has no verified ATLAS test access, so it
 * does not generate an ATLAS-Ausfuhr (export) or re-import message. It
 * prepares the data and paperwork a declarant or customs broker needs to
 * make that declaration by hand or through their own ATLAS-connected
 * software, and tracks the export MRN so the eventual re-import can
 * reference it.
 */

export interface CustomsDeMeta {
  event: string;
  eventDateStart: string;
  eventDateEnd: string;
  eventLocation: string;
  /** e.g. "Hauptzollamt Berlin" - where the export precheck happens. */
  precheckOffice: string;
  /** EORI number of the exporter, required on the ATLAS export declaration. */
  eori: string;
  /** MRN assigned at export precheck; carried forward so the re-import can reference it. */
  exportMrn: string;
  /** Box 17a - where the goods are going, e.g. "CH". Derived from the event's venue. */
  destinationCountry: string;
  /** Box 18/25 - mode of transport, e.g. "3 - Road". */
  transportMode: string;
  /** Box 18 - vehicle registration / plate number. */
  vehicleReg: string;
  /** Box 6 - number of packages (boxes/crates), not item count. */
  totalPackages: number;
  /** Box 7 - your own reference, optional. IAA-Plus doesn't require one. */
  referenceNumber: string;
  /** Box 21 - nationality of the active means of transport, e.g. "DE". */
  transportNationality: string;
  /** Box 29 - customs office of exit; often a different office than the precheck. */
  exitOffice: string;
  /** Box 54 - place the declaration is made, for the signature block. */
  placeOfDeclaration: string;
  /** LRN - your own unique reference for this declaration, required by ATLAS (not optional like referenceNumber/UCR). */
  lrn: string;
  /** "Art des Geschäfts" / nature-of-transaction code, e.g. "32" (goods on approval/consignment). */
  natureOfTransaction: string;
  /** "Sicherheit" - whether this declaration also carries separate summary safety/security data. "0" = no. */
  security: string;
  /**
   * "Beteiligten-Konstellation" - 4-digit code encoding the Anmelder/Vertreter/Subunternehmer
   * relationship (from ATLAS codelist A0127, not decoded here). "0000" is the base case: no
   * representative, no subcontractor, filing on own account - verify against A0127 before real use.
   */
  partyConstellation: string;
  /**
   * MessageSender authentication number (BIN, 25 digits) - a distinct credential from the EORI,
   * issued as part of ATLAS participant registration. Not obtainable from IAA-Plus's UI; nothing
   * this module has seen names where it comes from. Left blank until known.
   */
  messageSenderBin: string;
  /** Empfänger (Consignee) - who receives the goods at the event. */
  consigneeName: string;
  consigneeStreet: string;
  consigneePostcode: string;
  consigneeCity: string;
  consigneeCountry: string;
  currency: string;
  /** Delivery term shown on the proforma invoice, e.g. "EXW Berlin" (Incoterms 2020) - self-transported, self-consigned goods have no real buyer/seller split, so EXW at the exporter's own address is the defensible default. Requested by German export brokers as "Angabe auf der Rechnung". */
  incoterms: string;
}

export interface CustomsDeDeclarant {
  companyName: string;
  fullName: string;
  street: string;
  postCodeCity: string;
  countryOfOrigin: string;
  phone: string;
  email: string;
  /** Seller VAT/tax identifier - expected on an EU-compliant invoice, distinct from the EORI. */
  vatId: string;
}

export interface CustomsDeVariant {
  name?: string;
  sku?: string;
  price?: number | string | null;
  weightG?: number | string | null;
  unlisted?: boolean;
  amount?: number;
  soldQty?: number;
  soldValue?: number;
}

export interface CustomsDeProduct {
  id?: string;
  title?: string;
  sku?: string;
  type?: string;
  forSale?: boolean;
  unlisted?: boolean;
  price?: number | string | null;
  weightG?: number | string | null;
  /** Free text - this module does not look up or verify tariff rates. */
  tariffNo?: string;
  originCountry?: string;
  /** Year an art print was produced - shown as "Title (Year)" on the packing list. */
  year?: number;
  /** Material composition of a purse - shown as "Title - Material" on the packing list. */
  material?: string;
  /** Brought to the event (what was declared for export). */
  amount: number;
  /** Sold at the event, so not coming back to Germany. */
  soldQty: number;
  soldValue: number;
  variants?: CustomsDeVariant[];
}

export interface CustomsDeState {
  meta: CustomsDeMeta;
  declarant: CustomsDeDeclarant;
  products: CustomsDeProduct[];
}

export function defaultCustomsDeMeta(): CustomsDeMeta {
  return {
    event: '',
    eventDateStart: '',
    eventDateEnd: '',
    eventLocation: '',
    precheckOffice: '',
    eori: '',
    exportMrn: '',
    destinationCountry: '',
    transportMode: '3 - Road',
    vehicleReg: '',
    totalPackages: 1,
    referenceNumber: '',
    transportNationality: 'DE',
    exitOffice: '',
    placeOfDeclaration: '',
    lrn: '',
    natureOfTransaction: '32',
    security: '0',
    partyConstellation: '0000',
    messageSenderBin: '',
    consigneeName: '',
    consigneeStreet: '',
    consigneePostcode: '',
    consigneeCity: '',
    consigneeCountry: '',
    currency: 'EUR',
    incoterms: '',
  };
}

export function defaultCustomsDeDeclarant(): CustomsDeDeclarant {
  return {
    companyName: '',
    fullName: '',
    street: '',
    postCodeCity: '',
    countryOfOrigin: 'Germany',
    phone: '',
    email: '',
    vatId: '',
  };
}
