/** e-dec import XML — exact port of legacy generateEdecXML() (golden-tested). */
import {
  countryToCode,
  escapeXml,
  getPermitObligation,
  getVatCode,
  parsePostCodeCity,
  toEdecHsCode,
} from './calc';
import type { CustomsState } from './model';

export interface EdecResult {
  xml: string;
  filename: string;
}

/** Returns null when no product has sold quantities (legacy showed a toast). */
export function buildEdecXml(state: CustomsState, now: Date = new Date()): EdecResult | null {
  const soldProducts = state.products.filter((p) => {
    if (p.unlisted) return false;
    if (p.variants && p.variants.length > 0) return p.variants.some((v) => !v.unlisted && (v.soldQty || 0) > 0);
    return (p.soldQty || 0) > 0;
  });

  if (soldProducts.length === 0) return null;

  const e = state.edec;
  const a = state.artist;
  const dispatchCountry = countryToCode(a.countryOfOrigin);
  const declarantAddr = parsePostCodeCity(a.postCodeCity);

  const pad = (n: number) => String(n).padStart(2, '0');
  const createdDate =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}.000 UTC`;

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<EdecWeb version="4.0" createdDate="${escapeXml(createdDate)}">`);
  lines.push(`  <goodsDeclarationType>`);
  lines.push(`    <serviceType>1</serviceType>`);
  lines.push(`    <declarationType>1</declarationType>`);
  lines.push(`    <language>de</language>`);
  lines.push(`    <dispatchCountry>${escapeXml(dispatchCountry)}</dispatchCountry>`);
  const tMode = e.transportMode || '3';
  lines.push(`    <transportMeans>`);
  lines.push(`      <transportMode>${escapeXml(tMode)}</transportMode>`);
  // transportationType (road subtype) is only valid for road transport (mode 3)
  if (tMode === '3') {
    lines.push(`      <transportationType>${escapeXml(e.transportationType || '1')}</transportationType>`);
  }
  lines.push(
    `      <transportationCountry>${escapeXml((e.transportationCountry || '').toUpperCase())}</transportationCountry>`,
  );
  lines.push(`      <transportationNumber>${escapeXml(e.transportationNumber || '')}</transportationNumber>`);
  lines.push(`    </transportMeans>`);
  lines.push(`    <transportInContainer>0</transportInContainer>`);
  lines.push(`    <previousDocument/>`);

  const m = state.meta;
  const venueCC = countryToCode(m.venueCountry) || 'CH';

  // Importer
  lines.push(`    <importer>`);
  lines.push(`      <name>${escapeXml(m.venueName || '')}</name>`);
  lines.push(`      <addressSupplement1>${escapeXml('c/o ' + (m.event || ''))}</addressSupplement1>`);
  lines.push(`      <addressSupplement2>${escapeXml(m.venueStreet || '')}</addressSupplement2>`);
  lines.push(`      <postalCode>${escapeXml(m.venuePostcode || '')}</postalCode>`);
  lines.push(`      <city>${escapeXml(m.venueCity || '')}</city>`);
  lines.push(`      <country>${escapeXml(venueCC)}</country>`);
  lines.push(`      <traderIdentificationNumber>${escapeXml(m.venueTIN || '')}</traderIdentificationNumber>`);
  lines.push(`    </importer>`);

  // Consignee (same as importer)
  lines.push(`    <consignee>`);
  lines.push(`      <name>${escapeXml(m.venueName || '')}</name>`);
  lines.push(`      <addressSupplement1>${escapeXml('c/o ' + (m.event || ''))}</addressSupplement1>`);
  lines.push(`      <addressSupplement2>${escapeXml(m.venueStreet || '')}</addressSupplement2>`);
  lines.push(`      <postalCode>${escapeXml(m.venuePostcode || '')}</postalCode>`);
  lines.push(`      <city>${escapeXml(m.venueCity || '')}</city>`);
  lines.push(`      <country>${escapeXml(venueCC)}</country>`);
  lines.push(`      <traderIdentificationNumber>${escapeXml(m.venueTIN || '')}</traderIdentificationNumber>`);
  lines.push(`    </consignee>`);

  // Declarant (from artist info)
  lines.push(`    <declarant>`);
  lines.push(`      <traderIdentificationNumber></traderIdentificationNumber>`);
  lines.push(`      <name>${escapeXml(a.fullName || a.companyName || '')}</name>`);
  lines.push(`      <street>${escapeXml(a.street || '')}</street>`);
  lines.push(`      <postalCode>${escapeXml(declarantAddr.postCode)}</postalCode>`);
  lines.push(`      <city>${escapeXml(declarantAddr.city)}</city>`);
  lines.push(`      <country>${escapeXml(dispatchCountry)}</country>`);
  lines.push(`    </declarant>`);

  lines.push(`    <business>`);
  lines.push(`      <customsAccount>0</customsAccount>`);
  lines.push(`      <vatAccount>0</vatAccount>`);
  lines.push(`      <vatSuffix>0</vatSuffix>`);
  lines.push(`      <invoiceCurrencyType>1</invoiceCurrencyType>`);
  lines.push(`    </business>`);

  lines.push(`    <goodsItem>`);

  soldProducts.forEach((p, idx) => {
    // For variant products, aggregate only non-unlisted variants
    const listedVariants = p.variants && p.variants.length > 0 ? p.variants.filter((v) => !v.unlisted) : null;
    const soldQty = listedVariants ? listedVariants.reduce((s, v) => s + (v.soldQty || 0), 0) : p.soldQty || 0;
    const soldVal = listedVariants ? listedVariants.reduce((s, v) => s + (v.soldValue || 0), 0) : p.soldValue || 0;

    // Round to nearest 100 g (0.1 kg), minimum 0.1 kg
    const weightKg = Math.max(0.1, Math.round((soldQty * ((p.weightG as number) || 0)) / 100) / 10);
    const permit = p.permitOverride != null ? p.permitOverride : getPermitObligation(p.tariffNo);
    const vatCode = getVatCode(p.vatRate);
    const hsCode = toEdecHsCode(p.tariffNo);
    const originCc =
      p.originCountry && p.originCountry.trim() ? p.originCountry.trim().toUpperCase() : dispatchCountry;

    // Statistical value: prefer soldValue if entered, else qty × unit price, else proportional from totalValue
    let statValue = 0;
    if (soldVal > 0) {
      statValue = Math.floor(soldVal);
    } else if (p.price != null && p.price !== '') {
      statValue = Math.floor(soldQty * parseFloat(p.price as string));
    } else if (p.totalValueCHF != null && p.amount) {
      statValue = Math.floor((soldQty / p.amount) * parseFloat(p.totalValueCHF as string));
    }

    lines.push(`      <GoodsItemType>`);
    lines.push(`        <traderItemID>${idx}</traderItemID>`);
    lines.push(`        <description>${escapeXml(soldQty + ' ' + (p.title || ''))}</description>`);
    lines.push(`        <commodityCode>${escapeXml(hsCode)}</commodityCode>`);
    lines.push(`        <grossMass>${weightKg}</grossMass>`);
    lines.push(`        <netMass>${weightKg}</netMass>`);
    lines.push(`        <permitObligation>${permit}</permitObligation>`);
    lines.push(`        <nonCustomsLawObligation>${permit}</nonCustomsLawObligation>`);
    lines.push(`        <statistic>`);
    lines.push(`          <customsClearanceType>1</customsClearanceType>`);
    lines.push(`          <commercialGood>1</commercialGood>`);
    lines.push(`          <statisticalValue>${statValue}</statisticalValue>`);
    lines.push(`          <repair>0</repair>`);
    lines.push(`        </statistic>`);
    lines.push(`        <origin>`);
    lines.push(`          <originCountry>${escapeXml(originCc)}</originCountry>`);
    lines.push(`          <preference>0</preference>`);
    lines.push(`        </origin>`);
    const pkgType = p.packagingType || 'CT';
    if (pkgType === 'NE') {
      lines.push(`        <packaging>`);
      lines.push(`          <PackagingType>`);
      lines.push(`            <packagingType>NE</packagingType>`);
      lines.push(`            <quantity>0</quantity>`);
      lines.push(`          </PackagingType>`);
      lines.push(`        </packaging>`);
    } else {
      lines.push(`        <packaging>`);
      lines.push(`          <PackagingType>`);
      lines.push(`            <packagingType>${escapeXml(pkgType)}</packagingType>`);
      lines.push(`            <quantity>1</quantity>`);
      lines.push(`            <packagingReferenceNumber>1</packagingReferenceNumber>`);
      lines.push(`          </PackagingType>`);
      lines.push(`        </packaging>`);
    }
    lines.push(`        <valuation>`);
    lines.push(`          <netDuty>0</netDuty>`);
    lines.push(`          <vatValue>${statValue}</vatValue>`);
    lines.push(`          <vatCode>${vatCode}</vatCode>`);
    lines.push(`        </valuation>`);
    lines.push(`      </GoodsItemType>`);
  });

  lines.push(`    </goodsItem>`);
  lines.push(`  </goodsDeclarationType>`);
  lines.push(`</EdecWeb>`);

  const xmlString = lines.join('\n');

  const eventName = state.meta.event || 'ZollTool';
  const artist = state.artist.companyName || state.artist.fullName || '';
  const dateStr = now.toISOString().slice(0, 10);
  const filename =
    [eventName, artist, 'edec', dateStr]
      .filter(Boolean)
      .join('_')
      .replace(/[^a-zA-Z0-9_\-\.]/g, '_') + '.xml';

  return { xml: xmlString, filename };
}
