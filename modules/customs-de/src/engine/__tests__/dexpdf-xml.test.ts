import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { buildDexpdfXml } from '../dexpdf-xml';
import { defaultCustomsDeDeclarant, defaultCustomsDeMeta, type CustomsDeState } from '../model';

// Patterns copied verbatim from the official schema (DEXPDF.xsd / DEXPDF.csv),
// not reinvented - if these ever disagree with the real schema, the schema wins.
const EORI_PATTERN = /^[A-Z]{2}[\x21-\x7E]{1,15}$/;
const OFFICE_PATTERN = /^[A-Z]{2}[A-Za-z0-9]{6}$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// parseTagValue: false - fast-xml-parser otherwise coerces numeric-looking text to
// JS numbers, silently eating the leading zeros this schema relies on (e.g. "00000100" -> 100).
const parser = new XMLParser({ parseTagValue: false, isArray: (name) => name === 'GoodsItem' });
const parse = (xml: string) => parser.parse(xml).DEXPDF;

function fullState(overrides: Partial<CustomsDeState['meta']> = {}): CustomsDeState {
  return {
    meta: {
      ...defaultCustomsDeMeta(),
      event: 'Zurich Pop Con',
      eori: 'DE607109170504586',
      messageSenderBin: '1234567890123456789012345',
      lrn: '20260921-BOOTHLY-001',
      precheckOffice: 'DE002152',
      exitOffice: 'DE004103',
      destinationCountry: 'Switzerland',
      consigneeName: 'Phuong Ninjin',
      consigneeStreet: 'Wallisellenstrasse 49',
      consigneePostcode: '8050',
      consigneeCity: 'Zürich',
      consigneeCountry: 'Switzerland',
      ...overrides,
    },
    declarant: {
      ...defaultCustomsDeDeclarant(),
      companyName: 'Phuong Ninjin',
      fullName: 'Wolf Van Herreweghe',
      street: 'Buckower Damm 83',
      postCodeCity: '12349 Berlin',
      countryOfOrigin: 'Germany',
      phone: '+49 30 12345678',
      email: 'phuongninjin@gmail.com',
    },
    products: [
      { title: 'Art Print', tariffNo: '4911910000', originCountry: 'Germany', weightG: 100, price: 25, amount: 10, soldQty: 3, soldValue: 75 },
      { title: 'Keychain "&" charm', tariffNo: '711719', originCountry: 'Germany', weightG: 20, price: 8, amount: 20, soldQty: 5, soldValue: 40 },
    ],
  };
}

describe('buildDexpdfXml', () => {
  it('produces well-formed XML', () => {
    const { xml } = buildDexpdfXml(fullState());
    const result = XMLValidator.validate(xml);
    expect(result).toBe(true);
  });

  it('emits the fixed envelope values exactly as required by the schema', () => {
    const { xml } = buildDexpdfXml(fullState());
    const doc = parse(xml);
    expect(doc.messageGroup).toBe('EXP');
    expect(doc.messageType).toBe('DEXPDF');
    expect(doc.messageVersion).toBe('F.1.15');
    expect(doc.ExportOperation.declarationType).toBe('EX');
    expect(doc.ExportOperation.exportDeclarationType).toBe('00000100');
  });

  it('required top-level fields match their schema regex patterns', () => {
    const { xml } = buildDexpdfXml(fullState());
    const doc = parse(xml);
    expect(doc.MessageSender.identificationNumber).toMatch(EORI_PATTERN);
    expect(doc.CustomsOfficeOfExport.referenceNumber).toMatch(OFFICE_PATTERN);
    expect(doc.CustomsOfficeOfExitDeclared.referenceNumber).toMatch(OFFICE_PATTERN);
    expect(doc.preparationDateAndTime).toMatch(DATETIME_PATTERN);
    expect(doc.ExportOperation.declarationSubmissionDateAndTime).toMatch(DATETIME_PATTERN);
    expect(doc.ExportOperation.LRN.length).toBeLessThanOrEqual(22);
  });

  it('sets Verfahren to the working value 23/00 on every goods item', () => {
    const { xml } = buildDexpdfXml(fullState());
    const items = parse(xml).GoodsShipment.GoodsItem;
    for (const item of items) {
      expect(item.Procedure.requestedProcedure).toBe('23');
      expect(item.Procedure.previousProcedure).toBe('00');
    }
  });

  it('one GoodsItem per claimed product, numbered sequentially', () => {
    const { xml } = buildDexpdfXml(fullState());
    const items = parse(xml).GoodsShipment.GoodsItem;
    expect(items).toHaveLength(2);
    expect(items[0].sequenceNumber).toBe('1');
    expect(items[1].sequenceNumber).toBe('2');
    expect(items[1].declarationGoodsItemNumber).toBe('2');
  });

  it('splits a 10-digit tariff number into 6-digit HS + 2-digit CN, padding a short code', () => {
    const { xml } = buildDexpdfXml(fullState());
    const items = parse(xml).GoodsShipment.GoodsItem;
    expect(items[0].Commodity.CommodityCode.harmonizedSystemSubHeadingCode).toBe('491191');
    expect(items[0].Commodity.CommodityCode.combinedNomenclatureCode).toBe('00');
    // "711719" is only 6 digits - CN2 must still come out as a valid 2-digit field, not empty.
    expect(items[1].Commodity.CommodityCode.harmonizedSystemSubHeadingCode).toBe('711719');
    expect(items[1].Commodity.CommodityCode.combinedNomenclatureCode).toBe('00');
  });

  it('escapes special characters in free-text fields without breaking the XML', () => {
    const { xml } = buildDexpdfXml(fullState());
    expect(XMLValidator.validate(xml)).toBe(true);
    const items = parse(xml).GoodsShipment.GoodsItem;
    expect(items[1].Commodity.descriptionOfGoods).toBe('Keychain "&" charm');
  });

  it('omits GoodsItem for products with zero claimed quantity', () => {
    const state = fullState();
    state.products.push({ title: 'Unclaimed thing', amount: 0, soldQty: 0, soldValue: 0 });
    const { xml } = buildDexpdfXml(state);
    const items = parse(xml).GoodsShipment.GoodsItem;
    expect(items).toHaveLength(2);
  });

  it('includes a variant product whose own amount field is 0 but whose variants have stock', () => {
    // p.amount is the flat/non-variant field - a variant product's real
    // quantity only shows up through calcDeProduct(p).amount, which sums
    // p.variants[].amount. Filtering eligibility on the flat field alone
    // silently dropped every variant product from this export entirely.
    const state = fullState();
    state.products.push({ title: 'Enamel Pin', tariffNo: '711719', amount: 0, soldQty: 0, soldValue: 0, variants: [{ name: 'Dragon', amount: 12, soldQty: 4, soldValue: 32 }] });
    const { xml } = buildDexpdfXml(state);
    const items = parse(xml).GoodsShipment.GoodsItem;
    expect(items).toHaveLength(3);
  });

  it('flags a missing BIN, LRN, EORI and consignee as warnings rather than silently emitting an invalid message', () => {
    const state = fullState({ eori: '', messageSenderBin: '', lrn: '', consigneeName: '' });
    const { warnings } = buildDexpdfXml(state);
    expect(warnings.some((w) => w.includes('BIN'))).toBe(true);
    expect(warnings.some((w) => w.includes('LRN'))).toBe(true);
    expect(warnings.some((w) => w.includes('EORI'))).toBe(true);
    expect(warnings.some((w) => w.includes('Empfänger'))).toBe(true);
  });

  it('flags zero GoodsItem entries as an error-level warning (schema requires at least one)', () => {
    const state = fullState();
    state.products = [];
    const { warnings } = buildDexpdfXml(state);
    expect(warnings.some((w) => w.includes('zero GoodsItem'))).toBe(true);
  });

  it('always warns that packaging is a generic placeholder, not the real per-box breakdown', () => {
    const { warnings } = buildDexpdfXml(fullState());
    expect(warnings.some((w) => w.includes('Packaging'))).toBe(true);
  });
});
