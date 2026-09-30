/**
 * Packing list - replaces the old "Import" goods list (former docNum 1 in
 * goods-list.ts). Same header layout, same goods-table styling, same three
 * format options (Detailed / Compressed / By type) and the same eligibility
 * (hasCustomsInfo + a nonzero computed amount) as the list it replaces.
 *
 * One deliberate difference: no Tariff Rate / VAT Rate columns. Nothing in
 * this module calculates duty from them for this document, and the account
 * shouldn't need to think about tariff/VAT percentages just to see what's
 * being brought to an event - the HS code (Tariff no.) column stays, since
 * that's still an identification detail. vatRate is still used elsewhere
 * (edec-xml.ts's own VAT code), tariffRate is not used by anything but a
 * table cell, but neither is a calc.ts concept - removing them here doesn't
 * touch the product model.
 */
import {
  buildDocHeaderHtml,
  buildGoodsTableHtml,
  buildPrintableDocumentHtml,
  buildSignatureSectionHtml,
  byTypeGroupName as coreByTypeGroupName,
  goodsDocCss,
  materialCell as coreMaterialCell,
  resolveMaterial as coreResolveMaterial,
  titleForCustoms as coreTitleForCustoms,
} from '@zollify/customs-core';
import { calcProduct, calcProductByMaterial, computeLRP, countryToCode, esc, floorN, fmtEventDates, fmtWeightKg, formatNum, hasCustomsInfo, hasVariants } from './calc';
import type { CustomsProduct, CustomsState } from './model';
import { isArtwork } from '../lib/artwork';

export type PackingListFormat = 'detailed' | 'compressed' | 'bytype';

/** Mirrors goods-list.ts's titleForCustoms(). */
function titleForCustoms(p: { title?: string; type?: string; year?: number }, artistName?: string): string {
  return coreTitleForCustoms(esc, isArtwork, p, artistName);
}

/** Mirrors goods-list.ts's resolveMaterial(). */
function resolveMaterial(p: { material?: string }, v?: { material?: string }): string | undefined {
  return coreResolveMaterial(p, v);
}

function materialCell(material: string | undefined): string {
  return coreMaterialCell(esc, material);
}

/** Mirrors goods-list.ts's byTypeGroupName(). */
function byTypeGroupName(g: { type: string; products: Set<CustomsProduct> }, artistName?: string): string {
  return coreByTypeGroupName(esc, titleForCustoms, g, artistName);
}

function getCurrency(state: CustomsState): string {
  return state.meta && state.meta.currency ? state.meta.currency : 'CHF';
}

export function buildPackingListHtml(state: CustomsState, format: PackingListFormat = 'detailed', now: Date = new Date()): string {
  const m = state.meta;
  const a = state.artist;
  // 1: the LRP numbering this list always had as the account's first document.
  const lrp = computeLRP(state, 1);
  const cur = getCurrency(state);

  const CSS = goodsDocCss({ mono: true, totalBox: true });

  const header = buildDocHeaderHtml({
    docTitleHtml: 'Packing List',
    subtitleHtml: `${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}`,
    eventNameHtml: esc(m.event || ''),
    cornerLinesHtml: [`LRP: ${esc(lrp || '-')}`],
    infoRows: [
      { label1: 'Artist / Company Name', value1: esc(a.companyName || ''), label2: 'Name &amp; Surname', value2: esc(a.fullName || '') },
      { label1: 'Street &amp; House Number', value1: esc(a.street || ''), label2: 'Postcode &amp; City', value2: esc(a.postCodeCity || '') },
      { label1: 'Country of Origin', value1: esc(a.countryOfOrigin || ''), label2: 'Phone / Mobile', value2: esc(a.phone || '') },
      { label: 'Email', value: esc(a.email || ''), colspan: 3 },
    ],
  });

  let totAmt = 0,
    totWkg = 0,
    totVal = 0;
  let tableHtml: string;

  const eligible = state.products.filter((p) => hasCustomsInfo(p) && calcProduct(p).amount > 0);

  if (format === 'bytype') {
    // By-type: group by type + tariff code + material (none of the three are
    // ever combined across groups, so a group's material is never ambiguous).
    const groups = new Map<string, { type: string; tariffNo: string; material: string; amount: number; wkg: number; val: number; hasVal: boolean; products: Set<CustomsProduct> }>();
    eligible.forEach((p) => {
      for (const mc of calcProductByMaterial(p)) {
        if (mc.amount <= 0) continue;
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}\x00${mc.material}`;
        const g = groups.get(key) ?? { type: p.type || 'Other', tariffNo: p.tariffNo || '', material: mc.material, amount: 0, wkg: 0, val: 0, hasVal: false, products: new Set() };
        g.amount += mc.amount;
        g.wkg += mc.totalWeightKg;
        if (mc.totalValue != null) {
          g.val += mc.totalValue;
          g.hasVal = true;
        }
        g.products.add(p);
        groups.set(key, g);
        totAmt += mc.amount;
        totWkg += mc.totalWeightKg;
        if (mc.totalValue != null) totVal += mc.totalValue;
      }
    });
    const rows = [...groups.values()]
      .map(
        (g, i) =>
          `<tr><td class="c">${i + 1}</td><td>${byTypeGroupName(g, a.fullName)}</td>${materialCell(g.material)}<td class="r">${esc(g.tariffNo)}</td><td class="r">${g.amount}</td><td class="r">${fmtWeightKg(g.wkg)}</td><td class="r">${g.hasVal ? g.val : '-'}</td></tr>`,
      )
      .join('');
    tableHtml = buildGoodsTableHtml({
      sectionTitle: 'List of goods (By Type)',
      theadRowHtml: `  <th>#</th><th>Type</th><th class="mat">Material</th><th class="r">HS Code</th>
  <th class="r">Total Amount</th><th class="r">Total Weight</th>
  <th class="r">Total Value (${esc(cur)})</th>`,
      bodyRowsHtml: rows,
      emptyColspan: 7,
      emptyMessage: 'Nothing to list',
      tfootRowHtml: `  <td colspan="3" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totAmt}</td><td class="r">${fmtWeightKg(totWkg)}</td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td>`,
    });
  } else {
    const rows: string[] = [];
    let rowNum = 0;
    eligible.forEach((p) => {
      const c = calcProduct(p);
      const pOrig = p.originCountry && p.originCountry.trim() ? p.originCountry.trim().toUpperCase() : countryToCode(a.countryOfOrigin) || '';

      if (format === 'detailed' && hasVariants(p)) {
        p.variants!.filter((v) => !v.unlisted && (v.amount || 0) > 0).forEach((v) => {
          const i = rowNum++;
          const varWg = v.weightG != null ? v.weightG : p.weightG;
          const varPrice = v.price != null ? v.price : p.price;
          const varAmt = v.amount || 0;
          const varTotalWkg = Math.round(varAmt * ((varWg as number) || 0)) / 1000;
          const varTotalVal = varPrice != null ? Math.round((varPrice as number) * varAmt) : null;
          const pd = p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '-');
          const tv = varTotalVal != null ? varTotalVal : '-';
          totAmt += varAmt;
          totWkg += varTotalWkg;
          if (varTotalVal != null) totVal += varTotalVal;
          rows.push(`<tr><td class="c">${i + 1}</td><td>${esc(v.sku || p.sku || '')}</td><td>${titleForCustoms(p, a.fullName)} - ${esc(v.name || '')}</td>
            <td>${p.forSale ? 'For Sale' : 'Not For Sale'}</td><td>${esc(p.type || '')}</td>
            ${materialCell(resolveMaterial(p, v))}
            <td class="r">${varAmt}</td><td class="r">${varWg != null ? varWg + ' g' : ''}</td>
            <td class="r">${fmtWeightKg(varTotalWkg)}</td><td class="r">${esc(pd)}</td>
            <td class="r">${tv}</td><td class="r">${esc(p.tariffNo || '')}</td>
            <td class="c">${esc(pOrig)}</td></tr>`);
        });
      } else {
        const i = rowNum++;
        const pd = p.priceNote || (c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '-');
        const tv = c.totalValue != null ? c.totalValue : '-';
        totAmt += c.amount || 0;
        totWkg += c.totalWeightKg;
        if (c.totalValue != null) totVal += c.totalValue;
        const titleDisplay = hasVariants(p) ? `${titleForCustoms(p, a.fullName)} (${p.variants!.filter((v) => !v.unlisted).length} variants)` : titleForCustoms(p, a.fullName);
        rows.push(`<tr><td class="c">${i + 1}</td><td>${esc(p.sku || '')}</td><td>${titleDisplay}</td>
          <td>${p.forSale ? 'For Sale' : 'Not For Sale'}</td><td>${esc(p.type || '')}</td>
          ${materialCell(p.material)}
          <td class="r">${c.amount ?? ''}</td><td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG as number) + ' g' : ''}</td>
          <td class="r">${fmtWeightKg(c.totalWeightKg)}</td><td class="r">${esc(pd)}</td>
          <td class="r">${tv}</td><td class="r">${esc(p.tariffNo || '')}</td>
          <td class="c">${esc(pOrig)}</td></tr>`);
      }
    });

    const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
    tableHtml = buildGoodsTableHtml({
      sectionTitle: `List of goods${formatLabel}`,
      theadRowHtml: `  <th>#</th><th>SKU</th><th>Title</th><th>For Sale / Not For Sale</th><th>Type</th><th class="mat">Material</th>
  <th class="r">Amount</th><th class="r">Unit Weight</th><th class="r">Total Weight</th>
  <th class="r">Unit Price (${esc(cur)})</th><th class="r">Total Value (${esc(cur)})</th>
  <th class="r">Tariff no.</th><th class="c">Origin</th>`,
      bodyRowsHtml: rows.join(''),
      emptyColspan: 13,
      emptyMessage: 'Nothing to list',
      tfootRowHtml: `  <td colspan="5" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totAmt}</td><td></td><td class="r">${fmtWeightKg(totWkg)}</td><td></td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td><td colspan="2"></td>`,
    });
  }

  const html = buildPrintableDocumentHtml({
    titleHtml: `Packing List -${esc(m.event || 'ZollTool')}`,
    css: CSS,
    bodyHtml: `${header}
${tableHtml}

<div class="total-box">
  <div class="total-label">Total value</div>
  <div class="total-value">${esc(cur)} ${Math.floor(totVal).toLocaleString('de-CH')}</div>
  <div class="total-label" style="margin-top:3mm">Total weight</div>
  <div class="total-value">${fmtWeightKg(totWkg)}</div>
</div>

${buildSignatureSectionHtml()}`,
  });

  return html;
}
