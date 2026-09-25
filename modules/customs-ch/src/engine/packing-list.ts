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
import { calcProduct, calcProductByMaterial, computeLRP, countryToCode, esc, floorN, fmtEventDates, fmtWeightKg, formatNum, hasCustomsInfo, hasVariants } from './calc';
import type { CustomsProduct, CustomsState } from './model';
import { isArtwork } from '../lib/artwork';

export type PackingListFormat = 'detailed' | 'compressed' | 'bytype';

/** Mirrors goods-list.ts's titleForCustoms(). */
function titleForCustoms(p: { title?: string; type?: string; year?: number }, artistName?: string): string {
  const t = esc(p.title || '');
  if (isArtwork(p.type)) {
    const base = p.year ? `${t} (${p.year})` : t;
    const artist = (artistName ?? '').trim();
    return artist ? `${base} - ${esc(artist)}` : base;
  }
  return t;
}

/** Mirrors goods-list.ts's resolveMaterial(). */
function resolveMaterial(p: { material?: string }, v?: { material?: string }): string | undefined {
  return v?.material ?? p.material;
}

function materialCell(material: string | undefined): string {
  return `<td class="mat">${esc(material || '')}</td>`;
}

/** Mirrors goods-list.ts's byTypeGroupName(). */
function byTypeGroupName(g: { type: string; products: Set<CustomsProduct> }, artistName?: string): string {
  const typeEsc = esc(g.type);
  if (g.products.size === 1) return `<strong>${titleForCustoms([...g.products][0]!, artistName)}</strong>`;
  return `<strong>${typeEsc}</strong>`;
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

  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #000; padding: 12mm; }
  .doc-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6mm; }
  .doc-top-left .doc-title { font-size: 10pt; font-weight: bold; text-transform: uppercase; }
  .doc-top-left .doc-subtitle { font-size: 8pt; color: #444; margin-top: 2px; }
  .doc-top-right { text-align: right; }
  .doc-top-right .event-name { font-size: 11pt; font-weight: bold; }
  .doc-top-right .lrp { font-size: 8pt; margin-top: 3px; }
  .info-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
  .info-table td { padding: 2px 6px; font-size: 8pt; border: 1px solid #ccc; }
  .info-table td.lbl { font-weight: bold; background: #f4f4f4; width: 130px; font-size: 7.5pt; }
  .section-title { font-weight: bold; font-size: 9pt; margin: 4mm 0 2mm 0; border-bottom: 1.5px solid #000; padding-bottom: 1mm; }
  table.goods { width: 100%; border-collapse: collapse; font-size: 7pt; }
  table.goods th { background: #e8e8e8; border: 1px solid #aaa; padding: 3px 4px; text-align: left; font-size: 6.5pt; font-weight: bold; white-space: nowrap; }
  table.goods td { border: 1px solid #ccc; padding: 2px 4px; vertical-align: middle; }
  table.goods tr:nth-child(even) td { background: #fafafa; }
  table.goods tfoot td { background: #e8e8e8; font-weight: bold; border: 1px solid #aaa; padding: 3px 4px; }
  .r { text-align: right; } .c { text-align: center; }
  .mono { font-family: 'Courier New', monospace; font-size: 6.5pt; }
  .total-box { border: 2px solid #000; display: inline-block; padding: 4mm 8mm; margin: 4mm 0; }
  .total-box .total-label { font-size: 8pt; text-transform: uppercase; color: #555; }
  .total-box .total-value { font-size: 14pt; font-weight: bold; }
  .signature-section { margin-top: 8mm; }
  .signature-box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

  const header = `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">Packing List</div>
    <div class="doc-subtitle">${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${esc(m.event || '')}</div>
    <div class="lrp">LRP: ${esc(lrp || '-')}</div>
  </div>
</div>
<table class="info-table">
  <tr><td class="lbl">Artist / Company Name</td><td>${esc(a.companyName || '')}</td>
      <td class="lbl">Name &amp; Surname</td><td>${esc(a.fullName || '')}</td></tr>
  <tr><td class="lbl">Street &amp; House Number</td><td>${esc(a.street || '')}</td>
      <td class="lbl">Postcode &amp; City</td><td>${esc(a.postCodeCity || '')}</td></tr>
  <tr><td class="lbl">Country of Origin</td><td>${esc(a.countryOfOrigin || '')}</td>
      <td class="lbl">Phone / Mobile</td><td>${esc(a.phone || '')}</td></tr>
  <tr><td class="lbl">Email</td><td colspan="3">${esc(a.email || '')}</td></tr>
</table>`;

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
    tableHtml = `<div class="section-title">List of goods (By Type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="mat">Material</th><th class="r">HS Code</th>
  <th class="r">Total Amount</th><th class="r">Total Weight</th>
  <th class="r">Total Value (${esc(cur)})</th>
</tr></thead><tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:#888;padding:8px">Nothing to list</td></tr>`}</tbody><tfoot><tr>
  <td colspan="3" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totAmt}</td><td class="r">${fmtWeightKg(totWkg)}</td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td>
</tr></tfoot></table>`;
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
    tableHtml = `<div class="section-title">List of goods${formatLabel}</div>
<table class="goods"><thead><tr>
  <th>#</th><th>SKU</th><th>Title</th><th>For Sale / Not For Sale</th><th>Type</th><th class="mat">Material</th>
  <th class="r">Amount</th><th class="r">Unit Weight</th><th class="r">Total Weight</th>
  <th class="r">Unit Price (${esc(cur)})</th><th class="r">Total Value (${esc(cur)})</th>
  <th class="r">Tariff no.</th><th class="c">Origin</th>
</tr></thead><tbody>${rows.join('') || `<tr><td colspan="13" style="text-align:center;color:#888;padding:8px">Nothing to list</td></tr>`}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totAmt}</td><td></td><td class="r">${fmtWeightKg(totWkg)}</td><td></td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td><td colspan="2"></td>
</tr></tfoot></table>`;
  }

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Packing List -${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
${header}
${tableHtml}

<div class="total-box">
  <div class="total-label">Total value</div>
  <div class="total-value">${esc(cur)} ${Math.floor(totVal).toLocaleString('de-CH')}</div>
  <div class="total-label" style="margin-top:3mm">Total weight</div>
  <div class="total-value">${fmtWeightKg(totWkg)}</div>
</div>

<div class="signature-section"><strong>Date and Signature</strong><div class="signature-box"></div></div>
</body></html>`;

  return html;
}
