/**
 * DEXPDF (E_EXP_DAT) - the actual AES/ATLAS export declaration XML message.
 *
 * Built directly against the official schema: ATLAS-EDI-IHB v10.2.8 incl.
 * AES-EDI-IHB v3.0.15 (zoll.de, EDI-Implementierungshandbücher,
 * downloaded 2026-09-21), file
 * AUSFUHR/XML/Nachrichten/Ausfuhr/Ueberfuehrung+Erledigung/E_EXP_DAT/DEXPDF.xsd.
 * Element names, fixed values and structure below are read from that schema,
 * not guessed. IAA-Plus's own "AM in die IAA-Plus laden" screen accepts
 * exactly this message type.
 *
 * Scope is deliberately narrower than the full schema (1000+ fields across
 * ~50 optional segments: representatives, subcontractors, warehousing,
 * outward/inward processing, dangerous goods, supporting documents, and
 * more). Only the segments this module actually has real data for are
 * emitted; everything else is legitimately optional (minOccurs="0" in the
 * schema) and omitted rather than filled with invented values.
 *
 * NOT VERIFIED against a live ATLAS test environment - nobody on this team
 * has one. Structural correctness against the schema is checked by the
 * accompanying tests; legal correctness of the values themselves (Verfahren,
 * Geschäftsvorgang, partyConstellation, the missing BIN) is not, and is
 * flagged in `warnings`. Review those before this ever reaches IAA-Plus's
 * upload screen for real.
 */
import { calcDeProduct, countryToCode, escapeXml, parsePostCodeCity } from './calc';
import type { CustomsDeState } from './model';

export interface DexpdfResult {
  xml: string;
  filename: string;
  /** Things a human must check before this file is used for a real filing. */
  warnings: string[];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `n8` HS6 + `n2` CN2 split, e.g. "4911910000" -> ["491191", "00"]. Falls back to zeros. */
function splitCommodityCode(tariffNo: string | undefined): [string, string] {
  const digits = (tariffNo || '').replace(/\D/g, '');
  const hs6 = (digits.slice(0, 6) || '000000').padEnd(6, '0');
  const cn2 = (digits.slice(6, 8) || '00').padEnd(2, '0');
  return [hs6, cn2];
}

function address(tag: string, indent: string, street: string, postcode: string, city: string, country: string): string[] {
  const lines: string[] = [];
  lines.push(`${indent}<${tag}>`);
  lines.push(`${indent}  <streetAndNumber>${escapeXml(street)}</streetAndNumber>`);
  if (postcode) lines.push(`${indent}  <postcode>${escapeXml(postcode)}</postcode>`);
  lines.push(`${indent}  <city>${escapeXml(city)}</city>`);
  lines.push(`${indent}  <country>${escapeXml(country)}</country>`);
  lines.push(`${indent}</${tag}>`);
  return lines;
}

export function buildDexpdfXml(state: CustomsDeState, now: Date = new Date()): DexpdfResult {
  const m = state.meta;
  const d = state.declarant;
  const warnings: string[] = [];

  const products = state.products.filter((p) => !p.unlisted && p.amount > 0);
  if (products.length === 0) warnings.push('No products with a claimed quantity > 0 - the message would have zero GoodsItem entries, which the schema does not allow (minOccurs="1").');
  if (products.length > 0) warnings.push('Packaging is emitted as one generic "CS" (case) package per item - this model has no per-product packaging-group field, so it does not reflect the real box breakdown (e.g. the cardboard box for art prints, or boxes shared across several products via Packstück-Verweis). Fix by hand before real use, or add that field to the model.');

  const declarantAddr = parsePostCodeCity(d.postCodeCity);
  const declarantCC = countryToCode(d.countryOfOrigin) || 'DE';
  const destCC = countryToCode(m.destinationCountry) || 'CH';

  if (!m.eori) warnings.push('No EORI set - MessageSender/Declarant identificationNumber will be empty.');
  if (!m.messageSenderBin) warnings.push('No MessageSender authenticationNumber (BIN) - this is a required 25-digit field this module has no source for. Message will not validate without it.');
  if (!m.lrn) warnings.push('No LRN set - required field, currently empty.');
  if (!m.exitOffice) warnings.push('No Ausgangszollstelle (CustomsOfficeOfExitDeclared) set.');
  if (!m.consigneeName) warnings.push('No Empfänger (Consignee) set.');
  if (m.partyConstellation === '0000') warnings.push('partyConstellation left at the default "0000" - verify against ATLAS codelist A0127 for your actual Anmelder/Vertreter/Subunternehmer setup before real use.');

  const iso = (dt: Date) =>
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;

  const L: string[] = [];
  const push = (s: string) => L.push(s);

  push(`<?xml version="1.0" encoding="UTF-8"?>`);
  push(`<DEXPDF>`);
  push(`  <preparationDateAndTime>${iso(now)}</preparationDateAndTime>`);
  push(`  <messageIdentification>${escapeXml(m.lrn || 'UNSET')}</messageIdentification>`);
  push(`  <messageGroup>EXP</messageGroup>`);
  push(`  <messageType>DEXPDF</messageType>`);
  push(`  <messageVersion>F.1.15</messageVersion>`);
  push(`  <MessageSender>`);
  push(`    <identificationNumber>${escapeXml(m.eori)}</identificationNumber>`);
  push(`    <subsidiaryNumber>0000</subsidiaryNumber>`);
  push(`    <authenticationNumber>${escapeXml(m.messageSenderBin)}</authenticationNumber>`);
  push(`  </MessageSender>`);
  push(`  <MessageRecipient>`);
  push(`    <referenceNumber>${escapeXml(m.precheckOffice)}</referenceNumber>`);
  push(`  </MessageRecipient>`);
  push(`  <ExportOperation>`);
  push(`    <LRN>${escapeXml(m.lrn)}</LRN>`);
  push(`    <declarationType>EX</declarationType>`);
  push(`    <exportDeclarationType>00000100</exportDeclarationType>`);
  push(`    <partyConstellation>${escapeXml(m.partyConstellation)}</partyConstellation>`);
  push(`    <declarationSubmissionDateAndTime>${iso(now)}</declarationSubmissionDateAndTime>`);
  push(`    <security>${escapeXml(m.security)}</security>`);
  push(`  </ExportOperation>`);
  push(`  <CustomsOfficeOfExport>`);
  push(`    <referenceNumber>${escapeXml(m.precheckOffice)}</referenceNumber>`);
  push(`  </CustomsOfficeOfExport>`);
  if (m.exitOffice) {
    push(`  <CustomsOfficeOfExitDeclared>`);
    push(`    <referenceNumber>${escapeXml(m.exitOffice)}</referenceNumber>`);
    push(`  </CustomsOfficeOfExitDeclared>`);
  }
  push(`  <Declarant>`);
  push(`    <identificationNumber>${escapeXml(m.eori)}</identificationNumber>`);
  push(`    <subsidiaryNumber>0000</subsidiaryNumber>`);
  push(`    <name>${escapeXml(d.companyName || d.fullName)}</name>`);
  L.push(...address('Address', '    ', d.street, declarantAddr.postCode, declarantAddr.city, declarantCC));
  push(`    <ContactPerson>`);
  push(`      <name>${escapeXml(d.fullName || d.companyName)}</name>`);
  push(`      <phoneNumber>${escapeXml(d.phone)}</phoneNumber>`);
  if (d.email) push(`      <eMailAddress>${escapeXml(d.email)}</eMailAddress>`);
  push(`    </ContactPerson>`);
  push(`  </Declarant>`);
  push(`  <GoodsShipment>`);
  push(`    <Consignment>`);
  push(`      <Consignor>`);
  push(`        <name>${escapeXml(d.companyName || d.fullName)}</name>`);
  L.push(...address('Address', '        ', d.street, declarantAddr.postCode, declarantAddr.city, declarantCC));
  push(`      </Consignor>`);
  if (m.consigneeName) {
    push(`      <Consignee>`);
    push(`        <name>${escapeXml(m.consigneeName)}</name>`);
    L.push(...address('Address', '        ', m.consigneeStreet, m.consigneePostcode, m.consigneeCity, countryToCode(m.consigneeCountry) || destCC));
    push(`      </Consignee>`);
  }
  push(`      <LocationOfGoods>`);
  push(`        <typeOfLocation>D</typeOfLocation>`);
  push(`        <qualifierOfIdentification>Z</qualifierOfIdentification>`);
  L.push(...address('Address', '        ', d.street, declarantAddr.postCode, declarantAddr.city, declarantCC));
  push(`      </LocationOfGoods>`);
  push(`    </Consignment>`);

  products.forEach((p, i) => {
    const n = i + 1;
    const c = calcDeProduct(p);
    const [hs6, cn2] = splitCommodityCode(p.tariffNo);
    if (!p.tariffNo) warnings.push(`Product "${p.title}" has no tariff number - CommodityCode will be all zeros.`);
    const originCC = countryToCode(p.originCountry || d.countryOfOrigin) || 'DE';

    push(`    <GoodsItem>`);
    push(`      <sequenceNumber>${n}</sequenceNumber>`);
    push(`      <declarationGoodsItemNumber>${n}</declarationGoodsItemNumber>`);
    if (c.totalValue != null) push(`      <statisticalValue>${c.totalValue}</statisticalValue>`);
    push(`      <natureOfTransaction>${escapeXml(m.natureOfTransaction)}</natureOfTransaction>`);
    push(`      <countryOfExport>DE</countryOfExport>`);
    push(`      <Procedure>`);
    push(`        <requestedProcedure>23</requestedProcedure>`);
    push(`        <previousProcedure>00</previousProcedure>`);
    push(`      </Procedure>`);
    push(`      <Origin>`);
    push(`        <countryOfOrigin>${escapeXml(originCC)}</countryOfOrigin>`);
    push(`        <regionOfDispatch>11</regionOfDispatch>`);
    push(`      </Origin>`);
    push(`      <Commodity>`);
    push(`        <descriptionOfGoods>${escapeXml(p.title || 'unbenannt')}</descriptionOfGoods>`);
    push(`        <CommodityCode>`);
    push(`          <harmonizedSystemSubHeadingCode>${hs6}</harmonizedSystemSubHeadingCode>`);
    push(`          <combinedNomenclatureCode>${cn2}</combinedNomenclatureCode>`);
    push(`        </CommodityCode>`);
    push(`      </Commodity>`);
    push(`      <GoodsMeasure>`);
    push(`        <grossMass>${c.totalWeightKg}</grossMass>`);
    push(`        <netMass>${c.totalWeightKg}</netMass>`);
    push(`      </GoodsMeasure>`);
    push(`      <Packaging>`);
    push(`        <sequenceNumber>1</sequenceNumber>`);
    push(`        <typeOfPackages>CS</typeOfPackages>`);
    push(`        <numberOfPackages>1</numberOfPackages>`);
    push(`      </Packaging>`);
    push(`    </GoodsItem>`);
  });

  push(`  </GoodsShipment>`);
  push(`</DEXPDF>`);

  const eventName = m.event || 'event';
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `${eventName}_DEXPDF_${dateStr}`.replace(/[^a-zA-Z0-9_\-.]/g, '_') + '.xml';

  return { xml: L.join('\n'), filename, warnings };
}
