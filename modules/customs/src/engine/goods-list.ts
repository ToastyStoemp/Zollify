/**
 * Goods-list documents (Import / Sold / Return) — exact ports of legacy
 * printGoodsList() and printAllVersions() minus the window.open call.
 * The two legacy functions build the tables independently with small
 * differences; both are preserved verbatim (golden-tested).
 */
import {
  calcProduct,
  calcReturnStats,
  computeLRP,
  countryToCode,
  esc,
  floorN,
  fmtEventDates,
  fmtWeightKg,
  formatNum,
  hasCustomsInfo,
  hasVariants,
} from './calc';
import type { CustomsState } from './model';
import { isArtwork, isPurse } from '../lib/artwork';

export type GoodsDocNum = 1 | 2 | 3;

/**
 * Customs line name. Art prints read as "Title (Year) - Artist" (the artist's
 * full name attributes the work on the declaration); purses add their material.
 */
function titleForCustoms(
  p: { title?: string; type?: string; year?: number; material?: string },
  artistName?: string,
): string {
  const t = esc(p.title || '');
  if (isArtwork(p.type)) {
    const base = p.year ? `${t} (${p.year})` : t;
    const artist = (artistName ?? '').trim();
    return artist ? `${base} - ${esc(artist)}` : base;
  }
  if (isPurse(p.type) && p.material) return `${t} - ${esc(p.material)}`;
  return t;
}

/**
 * Name for the Sold / Return lists: art prints gain the year + artist so the
 * attribution is consistent across every goods list; every other product keeps
 * its plain title (unchanged from the legacy output).
 */
function soldReturnName(p: { title?: string; type?: string; year?: number }, artistName?: string): string {
  return isArtwork(p.type) ? titleForCustoms(p, artistName) : esc(p.title || '');
}

/**
 * By-type group label. When two groups share the same Type but differ by HS
 * code, the code is appended so the rows are not identically named; a type with
 * a single group is shown exactly as before.
 */
function byTypeGroupName(all: { type: string }[], g: { type: string; tariffNo?: string }): string {
  const shared = all.filter((x) => x.type === g.type).length > 1;
  return shared ? `${esc(g.type)} (${esc(g.tariffNo || 'no HS code')})` : esc(g.type);
}
export type GoodsFormat = 'detailed' | 'compressed' | 'bytype';

const DOC_TITLES: Record<number, string> = {
  1: 'Auxiliary Document for the Customs Declaration - Import',
  2: 'Auxiliary Document for the Customs Declaration - Sold Goods',
  3: 'Return Goods List - Re-export Declaration',
};

function getCurrency(state: CustomsState): string {
  return state.meta && state.meta.currency ? state.meta.currency : 'CHF';
}

/** Full printable HTML document — port of printGoodsList(). */
export function buildGoodsListHtml(state: CustomsState, docNum: GoodsDocNum, format: GoodsFormat = 'detailed'): string {
  const m = state.meta;
  const a = state.artist;
  const lrp = computeLRP(state, docNum);

  const docTitles = DOC_TITLES;

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
  .sold-head { border-left: 2px solid #666 !important; }
  td.sold-first { border-left: 2px solid #888; }
  .signature-section { margin-top: 8mm; }
  .signature-box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

  const header = `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">${esc(docTitles[docNum] || docTitles[1])}</div>
    <div class="doc-subtitle">${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${esc(m.event || '')}</div>
    <div class="lrp">LRP: ${esc(lrp || '—')}</div>
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

  let tableHtml = '';

  if (docNum === 1) {
    // ── IMPORT: no sold columns ──
    let totAmt = 0,
      totWkg = 0,
      totVal = 0;
    let rowNum = 0;

    const detailedRows: string[] = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code (different HS codes are never combined)
      const groups: Record<
        string,
        {
          type: string;
          tariffNo: string;
          tariffRate: unknown;
          vatRate: unknown;
          amount: number;
          wkg: number;
          val: number;
          hasVal: boolean;
        }
      > = {};
      state.products.filter((p) => hasCustomsInfo(p) && calcProduct(p).amount > 0).forEach((p) => {
        const c = calcProduct(p);
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
        if (!groups[key])
          groups[key] = {
            type: p.type || 'Other',
            tariffNo: p.tariffNo || '',
            tariffRate: p.tariffRate,
            vatRate: p.vatRate,
            amount: 0,
            wkg: 0,
            val: 0,
            hasVal: false,
          };
        const g = groups[key];
        g.amount += c.amount || 0;
        g.wkg += c.totalWeightKg;
        if (c.totalValue != null) {
          g.val += c.totalValue;
          g.hasVal = true;
        }
        totAmt += c.amount || 0;
        totWkg += c.totalWeightKg;
        if (c.totalValue != null) totVal += c.totalValue;
      });
      const groupList = Object.values(groups);
      groupList.forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i + 1}</td><td><strong>${byTypeGroupName(groupList, g)}</strong></td>
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r">${g.amount}</td>
          <td class="r">${fmtWeightKg(g.wkg)}</td>
          <td class="r">${g.hasVal ? g.val : '—'}</td></tr>`);
      });
      const rows = detailedRows.join('');
      tableHtml = `<div class="section-title">List of goods (By Type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Total Amount</th><th class="r">Total Weight</th>
  <th class="r">Total Value (${getCurrency(state)})</th>
</tr></thead><tbody>${rows}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r">${totAmt}</td><td class="r">${fmtWeightKg(totWkg)}</td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td>
</tr></tfoot></table>`;
    } else {
      state.products.filter((p) => hasCustomsInfo(p) && calcProduct(p).amount > 0).forEach((p) => {
        const c = calcProduct(p);
        const pOrig =
          p.originCountry && p.originCountry.trim()
            ? p.originCountry.trim().toUpperCase()
            : countryToCode(a.countryOfOrigin) || '';

        if (format === 'detailed' && hasVariants(p)) {
          // Detailed: each variant gets its own row (skip unlisted + zero-stock variants)
          p.variants!.filter((v) => !v.unlisted && (v.amount || 0) > 0).forEach((v) => {
            const i = rowNum++;
            const varWg = v.weightG != null ? v.weightG : p.weightG;
            const varPrice = v.price != null ? v.price : p.price;
            const varAmt = v.amount || 0;
            const varTotalWkg = Math.round(varAmt * ((varWg as number) || 0)) / 1000;
            const varTotalVal = varPrice != null ? Math.round((varPrice as number) * varAmt) : null;
            const pd = p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '—');
            const tv = varTotalVal != null ? varTotalVal : '—';
            totAmt += varAmt;
            totWkg += varTotalWkg;
            if (varTotalVal != null) totVal += varTotalVal;
            detailedRows.push(`<tr><td class="c">${i + 1}</td><td>${esc(v.sku || p.sku || '')}</td><td>${titleForCustoms(p, a.fullName)} - ${esc(v.name || '')}</td>
              <td>${p.forSale ? 'For Sale' : 'Not For Sale'}</td><td>${esc(p.type || '')}</td>
              <td class="r">${varAmt}</td><td class="r">${varWg != null ? varWg + ' g' : ''}</td>
              <td class="r">${fmtWeightKg(varTotalWkg)}</td><td class="r">${esc(pd)}</td>
              <td class="r">${tv}</td><td class="r">${esc(p.tariffNo || '')}</td>
              <td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td>
              <td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td>
              <td class="c">${esc(pOrig)}</td></tr>`);
          });
        } else {
          // Compressed or non-variant: one row per product
          const i = rowNum++;
          const pd = p.priceNote || (c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '—');
          const tv = c.totalValue != null ? c.totalValue : '—';
          totAmt += c.amount || 0;
          totWkg += c.totalWeightKg;
          if (c.totalValue != null) totVal += c.totalValue;
          const titleDisplay = hasVariants(p)
            ? `${titleForCustoms(p, a.fullName)} (${p.variants!.filter((v) => !v.unlisted).length} variants)`
            : titleForCustoms(p, a.fullName);
          detailedRows.push(`<tr><td class="c">${i + 1}</td><td>${esc(p.sku || '')}</td><td>${titleDisplay}</td>
            <td>${p.forSale ? 'For Sale' : 'Not For Sale'}</td><td>${esc(p.type || '')}</td>
            <td class="r">${c.amount ?? ''}</td><td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG as number) + ' g' : ''}</td>
            <td class="r">${fmtWeightKg(c.totalWeightKg)}</td><td class="r">${esc(pd)}</td>
            <td class="r">${tv}</td><td class="r">${esc(p.tariffNo || '')}</td>
            <td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td>
            <td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td>
            <td class="c">${esc(pOrig)}</td></tr>`);
        }
      });

      const rows = detailedRows.join('');
      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = `<div class="section-title">List of goods${formatLabel}</div>
<table class="goods"><thead><tr>
  <th>#</th><th>SKU</th><th>Title</th><th>For Sale / Not For Sale</th><th>Type</th>
  <th class="r">Amount</th><th class="r">Unit Weight</th><th class="r">Total Weight</th>
  <th class="r">Unit Price (${getCurrency(state)})</th><th class="r">Total Value (${getCurrency(state)})</th>
  <th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th>
</tr></thead><tbody>${rows}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r">${totAmt}</td><td></td><td class="r">${fmtWeightKg(totWkg)}</td><td></td>
  <td class="r" style="color:#c00">${Math.floor(totVal)}</td><td colspan="4"></td>
</tr></tfoot></table>`;
    }
  } else if (docNum === 2) {
    // ── SOLD: only sold goods ──
    let totSQ = 0,
      totSV = 0,
      totSWkg = 0;
    let rowNum = 0;

    const detailedRows: string[] = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code (different HS codes are never combined)
      const groups: Record<
        string,
        {
          type: string;
          tariffNo: string;
          tariffRate: unknown;
          vatRate: unknown;
          soldQty: number;
          soldVal: number;
          soldWkg: number;
        }
      > = {};
      state.products.forEach((p) => {
        if (!hasCustomsInfo(p)) return;
        const c = calcProduct(p);
        if (!(c.soldQty > 0)) return;
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
        if (!groups[key])
          groups[key] = {
            type: p.type || 'Other',
            tariffNo: p.tariffNo || '',
            tariffRate: p.tariffRate,
            vatRate: p.vatRate,
            soldQty: 0,
            soldVal: 0,
            soldWkg: 0,
          };
        const g = groups[key];
        g.soldQty += c.soldQty || 0;
        g.soldVal += floorN(c.soldValue || 0, 2);
        g.soldWkg += c.soldWeightKg;
        totSQ += c.soldQty || 0;
        totSV += floorN(c.soldValue || 0, 2);
        totSWkg += c.soldWeightKg;
      });
      const groupList = Object.values(groups);
      groupList.forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i + 1}</td><td><strong>${byTypeGroupName(groupList, g)}</strong></td>
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r">${g.soldQty}</td>
          <td class="r">${formatNum(floorN(g.soldVal, 2), 2)}</td>
          <td class="r">${fmtWeightKg(g.soldWkg)}</td></tr>`);
      });
      const rows = detailedRows.join('');
      const emptyRow = rows
        ? ''
        : `<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>`;
      tableHtml = `<div class="section-title">List of goods sold (By Type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${getCurrency(state)})</th>
  <th class="r">Sold Weight</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r">${totSQ}</td>
  <td class="r">${formatNum(floorN(totSV, 2), 2)}</td>
  <td class="r">${fmtWeightKg(totSWkg)}</td>
</tr></tfoot></table>`;
    } else {
      state.products.forEach((p) => {
        if (!hasCustomsInfo(p)) return;
        const c = calcProduct(p);

        if (format === 'detailed' && hasVariants(p)) {
          // Detailed: each variant gets its own row if it has sold qty (skip unlisted)
          p.variants!.filter((v) => !v.unlisted).forEach((v) => {
            if (!((v.soldQty as number) > 0)) return;
            rowNum++;
            const varWg = v.weightG != null ? v.weightG : p.weightG;
            const rowSV = floorN(v.soldValue || 0, 2);
            const varSoldWkg = ((v.soldQty || 0) * ((varWg as number) || 0)) / 1000;
            totSQ += v.soldQty || 0;
            totSV += rowSV;
            totSWkg += varSoldWkg;
            detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${soldReturnName(p, a.fullName)} - ${esc(v.name || '')}</td><td>${esc(p.type || '')}</td>
              <td class="r">${esc(p.tariffNo || '')}</td>
              <td class="r">${v.soldQty || 0}</td>
              <td class="r">${formatNum(rowSV, 2)}</td>
              <td class="r">${fmtWeightKg(varSoldWkg)}</td></tr>`);
          });
        } else if (!(c.soldQty > 0)) {
          return;
        } else {
          // Compressed or non-variant
          rowNum++;
          const rowSV = floorN(c.soldValue || 0, 2);
          totSQ += c.soldQty || 0;
          totSV += rowSV;
          totSWkg += c.soldWeightKg;
          const titleDisplay = hasVariants(p)
            ? `${soldReturnName(p, a.fullName)} (${p.variants!.filter((v) => !v.unlisted).length} variants)`
            : soldReturnName(p, a.fullName);
          detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${titleDisplay}</td><td>${esc(p.type || '')}</td>
            <td class="r">${esc(p.tariffNo || '')}</td>
            <td class="r">${c.soldQty || 0}</td>
            <td class="r">${formatNum(rowSV, 2)}</td>
            <td class="r">${fmtWeightKg(c.soldWeightKg)}</td></tr>`);
        }
      });

      const rows = detailedRows.join('');
      const emptyRow = rows
        ? ''
        : `<tr><td colspan="7" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>`;
      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = `<div class="section-title">List of goods sold${formatLabel}</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Title</th><th>Type</th>
  <th class="r">Tariff no.</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${getCurrency(state)})</th>
  <th class="r">Sold Weight</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="4" style="text-align:right">TOTALS</td>
  <td class="r">${totSQ}</td>
  <td class="r">${formatNum(floorN(totSV, 2), 2)}</td>
  <td class="r">${fmtWeightKg(totSWkg)}</td>
</tr></tfoot></table>`;
    }
  } else {
    // ── EXPORT/RETURN: unsold items going back (original qty − sold qty) ──
    let totRetQty = 0,
      totRetWkg = 0,
      totRetVal = 0;
    let rowNum = 0;

    const detailedRows: string[] = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code (different HS codes are never combined)
      const groups: Record<
        string,
        {
          type: string;
          tariffNo: string;
          tariffRate: unknown;
          vatRate: unknown;
          retQty: number;
          retWkg: number;
          retVal: number;
          hasVal: boolean;
        }
      > = {};
      state.products.forEach((p) => {
        if (!hasCustomsInfo(p)) return;
        const rs = calcReturnStats(p);
        if (rs.retQty <= 0) return;
        const { retQty, retWkg, retVal } = rs;
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
        if (!groups[key])
          groups[key] = {
            type: p.type || 'Other',
            tariffNo: p.tariffNo || '',
            tariffRate: p.tariffRate,
            vatRate: p.vatRate,
            retQty: 0,
            retWkg: 0,
            retVal: 0,
            hasVal: false,
          };
        const g = groups[key];
        g.retQty += retQty;
        g.retWkg += retWkg;
        if (retVal != null) {
          g.retVal += retVal;
          g.hasVal = true;
        }
        totRetQty += retQty;
        totRetWkg += retWkg;
        if (retVal != null) totRetVal += retVal;
      });
      const groupList = Object.values(groups);
      groupList.forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i + 1}</td><td><strong>${byTypeGroupName(groupList, g)}</strong></td>
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r"><strong>${g.retQty}</strong></td>
          <td class="r">${fmtWeightKg(g.retWkg)}</td>
          <td class="r">${g.hasVal ? g.retVal : '—'}</td></tr>`);
      });
      const rows = detailedRows.join('');
      const emptyRow = rows
        ? ''
        : `<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>`;
      tableHtml = `<div class="section-title">Return goods list (re-export) (By Type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Return Qty</th><th class="r">Return Weight</th>
  <th class="r">Return Value (${getCurrency(state)})</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r"><strong>${totRetQty}</strong></td>
  <td class="r">${fmtWeightKg(totRetWkg)}</td>
  <td class="r" style="color:#c00">${Math.floor(totRetVal)}</td>
</tr></tfoot></table>`;
    } else {
      state.products.forEach((p) => {
        if (!hasCustomsInfo(p)) return;
        const c = calcProduct(p);
        const pOrig =
          p.originCountry && p.originCountry.trim()
            ? p.originCountry.trim().toUpperCase()
            : countryToCode(a.countryOfOrigin) || '';

        if (format === 'detailed' && hasVariants(p)) {
          // Detailed: each variant gets its own row if there's a return qty (skip unlisted)
          p.variants!.filter((v) => !v.unlisted).forEach((v) => {
            const varRetQty = (v.amount || 0) - (v.soldQty || 0);
            if (varRetQty <= 0) return;
            rowNum++;
            const varWg = v.weightG != null ? v.weightG : p.weightG;
            const varPrice = v.price != null ? v.price : p.price;
            const varRetWkg = Math.round(varRetQty * ((varWg as number) || 0)) / 1000;
            const varRetVal = varPrice != null ? Math.round((varPrice as number) * varRetQty) : null;
            totRetQty += varRetQty;
            totRetWkg += varRetWkg;
            if (varRetVal != null) totRetVal += varRetVal;
            const pd = p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '—');
            const retValStr = varRetVal != null ? varRetVal : '—';
            detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${soldReturnName(p, a.fullName)} - ${esc(v.name || '')}</td><td>${esc(p.type || '')}</td>
              <td class="r">${v.amount || 0}</td><td class="r">${v.soldQty || 0}</td>
              <td class="r"><strong>${varRetQty}</strong></td>
              <td class="r">${varWg != null ? varWg + ' g' : ''}</td>
              <td class="r">${fmtWeightKg(varRetWkg)}</td>
              <td class="r">${esc(pd)}</td>
              <td class="r">${retValStr}</td>
              <td class="r">${esc(p.tariffNo || '')}</td>
              <td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td>
              <td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td>
              <td class="c">${esc(pOrig)}</td></tr>`);
          });
        } else {
          // Compressed or non-variant
          const rs = calcReturnStats(p);
          if (rs.retQty <= 0) return;
          rowNum++;
          const { retQty, retWkg, retVal } = rs;
          totRetQty += retQty;
          totRetWkg += retWkg;
          if (retVal != null) totRetVal += retVal;
          const pd = p.priceNote || (c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '—');
          const retValStr = retVal != null ? retVal : '—';
          const titleDisplay = hasVariants(p)
            ? `${soldReturnName(p, a.fullName)} (${p.variants!.filter((v) => !v.unlisted).length} variants)`
            : soldReturnName(p, a.fullName);
          detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${titleDisplay}</td><td>${esc(p.type || '')}</td>
            <td class="r">${c.amount ?? ''}</td><td class="r">${c.soldQty || 0}</td>
            <td class="r"><strong>${retQty}</strong></td>
            <td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG as number) + ' g' : ''}</td>
            <td class="r">${fmtWeightKg(retWkg)}</td>
            <td class="r">${esc(pd)}</td>
            <td class="r">${retValStr}</td>
            <td class="r">${esc(p.tariffNo || '')}</td>
            <td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td>
            <td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td>
            <td class="c">${esc(pOrig)}</td></tr>`);
        }
      });

      const rows = detailedRows.join('');
      const emptyRow = rows
        ? ''
        : `<tr><td colspan="14" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>`;
      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = `<div class="section-title">Return goods list (re-export)${formatLabel}</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Title</th><th>Type</th>
  <th class="r">Original Qty</th><th class="r">Sold Qty</th><th class="r">Return Qty</th>
  <th class="r">Unit Weight</th><th class="r">Return Weight</th>
  <th class="r">Unit Price (${getCurrency(state)})</th><th class="r">Return Value (${getCurrency(state)})</th>
  <th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th>
</tr></thead><tbody>${rows}${emptyRow}</tbody><tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r"><strong>${totRetQty}</strong></td><td></td>
  <td class="r">${fmtWeightKg(totRetWkg)}</td><td></td>
  <td class="r" style="color:#c00">${Math.floor(totRetVal)}</td><td colspan="4"></td>
</tr></tfoot></table>`;
    }
  }

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(docTitles[docNum])} -${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
${header}
${tableHtml}
<div class="signature-section"><strong>Date and Signature</strong><div class="signature-box"></div></div>
</body></html>`;

  return html;
}
