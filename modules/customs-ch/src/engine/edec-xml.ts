/** e-dec import XML - exact port of legacy generateEdecXML() (golden-tested). */
import {
  calcProductByMaterial,
  countryToCode,
  escapeXml,
  getNonCustomsLawObligation,
  getPermitObligation,
  getVatCode,
  parsePostCodeCity,
  toEdecHsCode,
} from './calc';
import type { CustomsProduct, CustomsState } from './model';

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

  /**
   * One Positionsdaten entry per (HS code, material) instead of per product -
   * a booth easily sells a dozen designs of the same zinc-alloy pin or the
   * same-material print, each its own product but identical for customs
   * purposes, and e-dec has no interest in telling them apart. Splits back
   * out by material within a single product too (calcProductByMaterial), so
   * a product whose own variants use different materials still gets one
   * position per material rather than folding them together.
   *
   * vatCode/origin/packaging are taken from whichever product reaches
   * a given (HS code, material) key first - real catalogs practically always
   * agree on these for the same code and material (permit/vatCode already
   * both derive from the HS code by default), so this is a rounding
   * simplification, not a real ambiguity, and the same shortcut goods-list.ts's
   * own by-type grouping already takes.
   */
  interface EdecGroup {
    tariffNo: string;
    material: string;
    soldQty: number;
    statValue: number;
    weightKg: number;
    titles: string[];
    permit: number;
    nonCustomsLaw: number;
    vatCode: number;
    originCc: string;
    packagingType: string;
  }

  /** Same soldValue/price/totalValueCHF fallback as before, scoped to one (product, material) line. */
  function statValueFor(p: CustomsProduct, soldQty: number, soldVal: number): number {
    if (soldVal > 0) return soldVal;
    if (p.price != null && p.price !== '') return soldQty * parseFloat(p.price as string);
    if (p.totalValueCHF != null && p.amount) return (soldQty / p.amount) * parseFloat(p.totalValueCHF as string);
    return 0;
  }

  const groups = new Map<string, EdecGroup>();
  for (const p of soldProducts) {
    for (const mc of calcProductByMaterial(p)) {
      if (!(mc.soldQty > 0)) continue;
      // Keyed by the exported code, so 4202.22.10 and 4202.22.90 - the same
      // line once cut to the subheading - become one position, not two.
      const key = `${toEdecHsCode(p.tariffNo)}\x00${mc.material}`;
      // A product's own override sets both, as before; otherwise each comes
      // from the HS table on its own (they can differ - see HsCode).
      const permit = p.permitOverride != null ? p.permitOverride : getPermitObligation(p.tariffNo);
      const nonCustomsLaw = p.permitOverride != null ? p.permitOverride : getNonCustomsLawObligation(p.tariffNo);
      let g = groups.get(key);
      if (!g) {
        g = {
          tariffNo: p.tariffNo || '',
          material: mc.material,
          soldQty: 0,
          statValue: 0,
          weightKg: 0,
          titles: [],
          permit,
          nonCustomsLaw,
          vatCode: getVatCode(p.vatRate),
          originCc: p.originCountry && p.originCountry.trim() ? p.originCountry.trim().toUpperCase() : dispatchCountry,
          packagingType: p.packagingType || 'CT',
        };
        groups.set(key, g);
      }
      // A merged line needs a permit if any product in it does.
      g.permit = Math.max(g.permit, permit);
      g.nonCustomsLaw = Math.max(g.nonCustomsLaw, nonCustomsLaw);
      g.soldQty += mc.soldQty;
      g.statValue += statValueFor(p, mc.soldQty, mc.soldValue);
      g.weightKg += mc.soldWeightKg;
      const title = p.title || '';
      if (!g.titles.includes(title)) g.titles.push(title);
    }
  }

  [...groups.values()].forEach((g, idx) => {
    const hsCode = toEdecHsCode(g.tariffNo);
    // Round to nearest 100 g (0.1 kg), minimum 0.1 kg.
    const weightKg = Math.max(0.1, Math.round(g.weightKg * 10) / 10);
    const statValue = Math.floor(g.statValue);

    lines.push(`      <GoodsItemType>`);
    lines.push(`        <traderItemID>${idx}</traderItemID>`);
    // Material is part of what makes a position (see the grouping above), so
    // it goes in the description too: "14 Dragon Pin, Wolf Pin (Zinc alloy)".
    const material = g.material.trim();
    const description = `${g.soldQty} ${g.titles.join(', ')}${material ? ` (${material})` : ''}`;
    lines.push(`        <description>${escapeXml(description)}</description>`);
    lines.push(`        <commodityCode>${escapeXml(hsCode)}</commodityCode>`);
    lines.push(`        <grossMass>${weightKg}</grossMass>`);
    lines.push(`        <netMass>${weightKg}</netMass>`);
    lines.push(`        <permitObligation>${g.permit}</permitObligation>`);
    lines.push(`        <nonCustomsLawObligation>${g.nonCustomsLaw}</nonCustomsLawObligation>`);
    lines.push(`        <statistic>`);
    lines.push(`          <customsClearanceType>1</customsClearanceType>`);
    lines.push(`          <commercialGood>1</commercialGood>`);
    lines.push(`          <statisticalValue>${statValue}</statisticalValue>`);
    lines.push(`          <repair>0</repair>`);
    lines.push(`        </statistic>`);
    lines.push(`        <origin>`);
    lines.push(`          <originCountry>${escapeXml(g.originCc)}</originCountry>`);
    lines.push(`          <preference>0</preference>`);
    lines.push(`        </origin>`);
    if (g.packagingType === 'NE') {
      lines.push(`        <packaging>`);
      lines.push(`          <PackagingType>`);
      lines.push(`            <packagingType>NE</packagingType>`);
      lines.push(`            <quantity>0</quantity>`);
      lines.push(`          </PackagingType>`);
      lines.push(`        </packaging>`);
    } else {
      lines.push(`        <packaging>`);
      lines.push(`          <PackagingType>`);
      lines.push(`            <packagingType>${escapeXml(g.packagingType)}</packagingType>`);
      lines.push(`            <quantity>1</quantity>`);
      lines.push(`            <packagingReferenceNumber>1</packagingReferenceNumber>`);
      lines.push(`          </PackagingType>`);
      lines.push(`        </packaging>`);
    }
    lines.push(`        <valuation>`);
    lines.push(`          <netDuty>0</netDuty>`);
    lines.push(`          <vatValue>${statValue}</vatValue>`);
    lines.push(`          <vatCode>${g.vatCode}</vatCode>`);
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
