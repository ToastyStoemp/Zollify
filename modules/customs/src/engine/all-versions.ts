/**
 * "Print all formats" combined document — exact port of legacy
 * printAllVersions(). Its inner buildGoodsTable differs slightly from
 * printGoodsList (e.g. import-detailed includes unlisted variants), so it is
 * ported verbatim rather than shared (golden-tested).
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
import type { GoodsDocNum, GoodsFormat } from './goods-list';

export function buildAllVersionsHtml(state: CustomsState, onlyDocNum: GoodsDocNum | null = null): string {
  const m = state.meta;
  const a = state.artist;
  const cur = state.meta && state.meta.currency ? state.meta.currency : 'CHF';

  function buildGoodsTable(docNum: number, format: GoodsFormat): string {
    let tableHtml = '';

    // ── IMPORT ──
    if (docNum === 1) {
      let totAmt = 0,
        totWkg = 0,
        totVal = 0,
        rowNum = 0;
      const rows: string[] = [];
      if (format === 'bytype') {
        const groups: Record<string, { type: string; tariffNo: string; tariffRate: unknown; vatRate: unknown; amount: number; wkg: number; val: number; hasVal: boolean }> = {};
        state.products.filter(hasCustomsInfo).forEach((p) => {
          const c = calcProduct(p);
          const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
          if (!groups[key]) groups[key] = { type: p.type || 'Other', tariffNo: p.tariffNo || '', tariffRate: p.tariffRate, vatRate: p.vatRate, amount: 0, wkg: 0, val: 0, hasVal: false };
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
        Object.values(groups).forEach((g, i) => {
          rows.push(`<tr><td class="c">${i + 1}</td><td><strong>${esc(g.type)}</strong></td><td class="r">${esc(g.tariffNo)}</td><td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td><td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td><td class="r">${g.amount}</td><td class="r">${fmtWeightKg(g.wkg)}</td><td class="r">${g.hasVal ? g.val : '—'}</td></tr>`);
        });
        tableHtml = `<div class="section-title">List of goods (By Type)</div>
<table class="goods"><thead><tr><th>#</th><th>Type</th><th class="r">HS Code</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="r">Total Amount</th><th class="r">Total Weight</th><th class="r">Total Value (${cur})</th></tr></thead>
<tbody>${rows.join('')}</tbody><tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r">${totAmt}</td><td class="r">${fmtWeightKg(totWkg)}</td><td class="r" style="color:#c00">${Math.floor(totVal)}</td></tr></tfoot></table>`;
      } else {
        state.products.filter(hasCustomsInfo).forEach((p) => {
          const c = calcProduct(p);
          const pOrig = p.originCountry && p.originCountry.trim() ? p.originCountry.trim().toUpperCase() : countryToCode(a.countryOfOrigin) || '';
          if (format === 'detailed' && hasVariants(p)) {
            p.variants!.forEach((v) => {
              const i = rowNum++;
              const varWg = v.weightG != null ? v.weightG : p.weightG;
              const varPrice = v.price != null ? v.price : p.price;
              const varAmt = v.amount || 0;
              const varTWkg = Math.round(varAmt * ((varWg as number) || 0)) / 1000;
              const varTV = varPrice != null ? Math.round((varPrice as number) * varAmt) : null;
              totAmt += varAmt;
              totWkg += varTWkg;
              if (varTV != null) totVal += varTV;
              rows.push(`<tr><td class="c">${i + 1}</td><td>${esc(v.sku || p.sku || '')}</td><td>${esc(p.title || '')} - ${esc(v.name || '')}</td><td>${p.forSale ? 'For Sale' : 'Not For Sale'}</td><td>${esc(p.type || '')}</td><td class="r">${varAmt}</td><td class="r">${varWg != null ? varWg + ' g' : ''}</td><td class="r">${fmtWeightKg(varTWkg)}</td><td class="r">${p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '—')}</td><td class="r">${varTV != null ? varTV : '—'}</td><td class="r">${esc(p.tariffNo || '')}</td><td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td><td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td><td class="c">${esc(pOrig)}</td></tr>`);
            });
          } else {
            const i = rowNum++;
            totAmt += c.amount || 0;
            totWkg += c.totalWeightKg;
            if (c.totalValue != null) totVal += c.totalValue;
            const td = hasVariants(p) ? `${esc(p.title || '')} (${p.variants!.length} variants)` : `${esc(p.title || '')}`;
            rows.push(`<tr><td class="c">${i + 1}</td><td>${esc(p.sku || '')}</td><td>${td}</td><td>${p.forSale ? 'For Sale' : 'Not For Sale'}</td><td>${esc(p.type || '')}</td><td class="r">${c.amount ?? ''}</td><td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG as number) + ' g' : ''}</td><td class="r">${fmtWeightKg(c.totalWeightKg)}</td><td class="r">${p.priceNote || (c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '—')}</td><td class="r">${c.totalValue != null ? c.totalValue : '—'}</td><td class="r">${esc(p.tariffNo || '')}</td><td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td><td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td><td class="c">${esc(pOrig)}</td></tr>`);
          }
        });
        const fl = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
        tableHtml = `<div class="section-title">List of goods${fl}</div>
<table class="goods"><thead><tr><th>#</th><th>SKU</th><th>Title</th><th>For Sale / Not For Sale</th><th>Type</th><th class="r">Amount</th><th class="r">Unit Weight</th><th class="r">Total Weight</th><th class="r">Unit Price (${cur})</th><th class="r">Total Value (${cur})</th><th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th></tr></thead>
<tbody>${rows.join('')}</tbody><tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r">${totAmt}</td><td></td><td class="r">${fmtWeightKg(totWkg)}</td><td></td><td class="r" style="color:#c00">${Math.floor(totVal)}</td><td colspan="4"></td></tr></tfoot></table>`;
      }

      // ── SOLD ──
    } else if (docNum === 2) {
      let totSQ = 0,
        totSV = 0,
        totSWkg = 0,
        rowNum = 0;
      const rows: string[] = [];
      if (format === 'bytype') {
        const groups: Record<string, { type: string; tariffNo: string; tariffRate: unknown; vatRate: unknown; soldQty: number; soldVal: number; soldWkg: number }> = {};
        state.products.forEach((p) => {
          if (!hasCustomsInfo(p)) return;
          const c = calcProduct(p);
          if (!(c.soldQty > 0)) return;
          const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
          if (!groups[key]) groups[key] = { type: p.type || 'Other', tariffNo: p.tariffNo || '', tariffRate: p.tariffRate, vatRate: p.vatRate, soldQty: 0, soldVal: 0, soldWkg: 0 };
          const g = groups[key];
          g.soldQty += c.soldQty || 0;
          g.soldVal += floorN(c.soldValue || 0, 2);
          g.soldWkg += c.soldWeightKg;
          totSQ += c.soldQty || 0;
          totSV += floorN(c.soldValue || 0, 2);
          totSWkg += c.soldWeightKg;
        });
        Object.values(groups).forEach((g, i) => {
          rows.push(`<tr><td class="c">${i + 1}</td><td><strong>${esc(g.type)}</strong></td><td class="r">${esc(g.tariffNo)}</td><td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td><td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td><td class="r">${g.soldQty}</td><td class="r">${formatNum(floorN(g.soldVal, 2), 2)}</td><td class="r">${fmtWeightKg(g.soldWkg)}</td></tr>`);
        });
        tableHtml = `<div class="section-title">List of goods sold (By Type)</div>
<table class="goods"><thead><tr><th>#</th><th>Type</th><th class="r">HS Code</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="r">Qty Sold</th><th class="r">Value Sold (${cur})</th><th class="r">Sold Weight</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r">${totSQ}</td><td class="r">${formatNum(floorN(totSV, 2), 2)}</td><td class="r">${fmtWeightKg(totSWkg)}</td></tr></tfoot></table>`;
      } else {
        state.products.forEach((p) => {
          if (!hasCustomsInfo(p)) return;
          const c = calcProduct(p);
          if (format === 'detailed' && hasVariants(p)) {
            p.variants!.forEach((v) => {
              if (!((v.soldQty as number) > 0)) return;
              rowNum++;
              const varWg = v.weightG != null ? v.weightG : p.weightG;
              const rowSV = floorN(v.soldValue || 0, 2);
              const varSWkg = ((v.soldQty || 0) * ((varWg as number) || 0)) / 1000;
              totSQ += v.soldQty || 0;
              totSV += rowSV;
              totSWkg += varSWkg;
              rows.push(`<tr><td class="c">${rowNum}</td><td>${esc(p.title || '')} - ${esc(v.name || '')}</td><td>${esc(p.type || '')}</td><td class="r">${esc(p.tariffNo || '')}</td><td class="r">${v.soldQty || 0}</td><td class="r">${formatNum(rowSV, 2)}</td><td class="r">${fmtWeightKg(varSWkg)}</td></tr>`);
            });
          } else if (c.soldQty > 0) {
            rowNum++;
            const rowSV = floorN(c.soldValue || 0, 2);
            totSQ += c.soldQty || 0;
            totSV += rowSV;
            totSWkg += c.soldWeightKg;
            const td = hasVariants(p) ? `${esc(p.title || '')} (${p.variants!.length} variants)` : esc(p.title || '');
            rows.push(`<tr><td class="c">${rowNum}</td><td>${td}</td><td>${esc(p.type || '')}</td><td class="r">${esc(p.tariffNo || '')}</td><td class="r">${c.soldQty || 0}</td><td class="r">${formatNum(rowSV, 2)}</td><td class="r">${fmtWeightKg(c.soldWeightKg)}</td></tr>`);
          }
        });
        const fl = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
        tableHtml = `<div class="section-title">List of goods sold${fl}</div>
<table class="goods"><thead><tr><th>#</th><th>Title</th><th>Type</th><th class="r">Tariff no.</th><th class="r">Qty Sold</th><th class="r">Value Sold (${cur})</th><th class="r">Sold Weight</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="7" style="text-align:center;color:#888;padding:8px">No sold quantities entered</td></tr>'}</tbody>
<tfoot><tr><td colspan="4" style="text-align:right">TOTALS</td><td class="r">${totSQ}</td><td class="r">${formatNum(floorN(totSV, 2), 2)}</td><td class="r">${fmtWeightKg(totSWkg)}</td></tr></tfoot></table>`;
      }

      // ── RETURN ──
    } else {
      let totRQ = 0,
        totRWkg = 0,
        totRVal = 0,
        rowNum = 0;
      const rows: string[] = [];
      if (format === 'bytype') {
        const groups: Record<string, { type: string; tariffNo: string; tariffRate: unknown; vatRate: unknown; retQty: number; retWkg: number; retVal: number; hasVal: boolean }> = {};
        state.products.forEach((p) => {
          if (!hasCustomsInfo(p)) return;
          const rs = calcReturnStats(p);
          if (rs.retQty <= 0) return;
          const { retQty, retWkg, retVal } = rs;
          const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
          if (!groups[key]) groups[key] = { type: p.type || 'Other', tariffNo: p.tariffNo || '', tariffRate: p.tariffRate, vatRate: p.vatRate, retQty: 0, retWkg: 0, retVal: 0, hasVal: false };
          const g = groups[key];
          g.retQty += retQty;
          g.retWkg += retWkg;
          if (retVal != null) {
            g.retVal += retVal;
            g.hasVal = true;
          }
          totRQ += retQty;
          totRWkg += retWkg;
          if (retVal != null) totRVal += retVal;
        });
        Object.values(groups).forEach((g, i) => {
          rows.push(`<tr><td class="c">${i + 1}</td><td><strong>${esc(g.type)}</strong></td><td class="r">${esc(g.tariffNo)}</td><td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td><td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td><td class="r"><strong>${g.retQty}</strong></td><td class="r">${fmtWeightKg(g.retWkg)}</td><td class="r">${g.hasVal ? g.retVal : '—'}</td></tr>`);
        });
        tableHtml = `<div class="section-title">Return goods list (re-export) (By Type)</div>
<table class="goods"><thead><tr><th>#</th><th>Type</th><th class="r">HS Code</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="r">Return Qty</th><th class="r">Return Weight</th><th class="r">Return Value (${cur})</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="8" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r"><strong>${totRQ}</strong></td><td class="r">${fmtWeightKg(totRWkg)}</td><td class="r" style="color:#c00">${Math.floor(totRVal)}</td></tr></tfoot></table>`;
      } else {
        state.products.forEach((p) => {
          if (!hasCustomsInfo(p)) return;
          const pOrig = p.originCountry && p.originCountry.trim() ? p.originCountry.trim().toUpperCase() : countryToCode(a.countryOfOrigin) || '';
          if (format === 'detailed' && hasVariants(p)) {
            p.variants!.forEach((v) => {
              const varRetQty = (v.amount || 0) - (v.soldQty || 0);
              if (varRetQty <= 0) return;
              rowNum++;
              const varWg = v.weightG != null ? v.weightG : p.weightG;
              const varPrice = v.price != null ? v.price : p.price;
              const varRWkg = Math.round(varRetQty * ((varWg as number) || 0)) / 1000;
              const varRVal = varPrice != null ? Math.round((varPrice as number) * varRetQty) : null;
              totRQ += varRetQty;
              totRWkg += varRWkg;
              if (varRVal != null) totRVal += varRVal;
              rows.push(`<tr><td class="c">${rowNum}</td><td>${esc(p.title || '')} - ${esc(v.name || '')}</td><td>${esc(p.type || '')}</td><td class="r">${v.amount || 0}</td><td class="r">${v.soldQty || 0}</td><td class="r"><strong>${varRetQty}</strong></td><td class="r">${varWg != null ? varWg + ' g' : ''}</td><td class="r">${fmtWeightKg(varRWkg)}</td><td class="r">${p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '—')}</td><td class="r">${varRVal != null ? varRVal : '—'}</td><td class="r">${esc(p.tariffNo || '')}</td><td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td><td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td><td class="c">${esc(pOrig)}</td></tr>`);
            });
          } else {
            const rs = calcReturnStats(p);
            if (rs.retQty <= 0) return;
            rowNum++;
            const { retQty, retWkg, retVal } = rs;
            const c2 = calcProduct(p);
            totRQ += retQty;
            totRWkg += retWkg;
            if (retVal != null) totRVal += retVal;
            const td = hasVariants(p) ? `${esc(p.title || '')} (${p.variants!.filter((v) => !v.unlisted).length} variants)` : esc(p.title || '');
            rows.push(`<tr><td class="c">${rowNum}</td><td>${td}</td><td>${esc(p.type || '')}</td><td class="r">${c2.amount ?? ''}</td><td class="r">${c2.soldQty || 0}</td><td class="r"><strong>${retQty}</strong></td><td class="r">${c2.effectiveUnitWeightG != null ? Math.round(c2.effectiveUnitWeightG as number) + ' g' : ''}</td><td class="r">${fmtWeightKg(retWkg)}</td><td class="r">${p.priceNote || (c2.effectiveUnitPrice != null ? formatNum(floorN(c2.effectiveUnitPrice, 2), 2) : '—')}</td><td class="r">${retVal != null ? retVal : '—'}</td><td class="r">${esc(p.tariffNo || '')}</td><td class="r">${p.tariffRate != null ? p.tariffRate + '%' : ''}</td><td class="r">${p.vatRate != null ? p.vatRate + '%' : ''}</td><td class="c">${esc(pOrig)}</td></tr>`);
          }
        });
        const fl = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
        tableHtml = `<div class="section-title">Return goods list (re-export)${fl}</div>
<table class="goods"><thead><tr><th>#</th><th>Title</th><th>Type</th><th class="r">Original Qty</th><th class="r">Sold Qty</th><th class="r">Return Qty</th><th class="r">Unit Weight</th><th class="r">Return Weight</th><th class="r">Unit Price (${cur})</th><th class="r">Return Value (${cur})</th><th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="14" style="text-align:center;color:#888;padding:8px">All items sold - no return goods</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right">TOTALS</td><td class="r"><strong>${totRQ}</strong></td><td></td><td class="r">${fmtWeightKg(totRWkg)}</td><td></td><td class="r" style="color:#c00">${Math.floor(totRVal)}</td><td colspan="4"></td></tr></tfoot></table>`;
      }
    }
    return tableHtml;
  }

  // ── Build the combined CSS ──
  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #000; padding: 12mm; }
  .doc-section { page-break-after: always; padding-bottom: 8mm; }
  .doc-section:last-child { page-break-after: auto; }
  .page-label { font-size: 9pt; font-weight: bold; color: #555; text-transform: uppercase;
                letter-spacing: 0.05em; border-bottom: 2px solid #888; padding-bottom: 3px;
                margin-bottom: 5mm; }
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
  .signature-section { margin-top: 8mm; }
  .signature-box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

  // ── Build each section ──
  const importerInfo = `<table class="info-table">
  <tr><td class="lbl">Artist / Company Name</td><td>${esc(a.companyName || '')}</td>
      <td class="lbl">Name &amp; Surname</td><td>${esc(a.fullName || '')}</td></tr>
  <tr><td class="lbl">Street &amp; House Number</td><td>${esc(a.street || '')}</td>
      <td class="lbl">Postcode &amp; City</td><td>${esc(a.postCodeCity || '')}</td></tr>
  <tr><td class="lbl">Country of Origin</td><td>${esc(a.countryOfOrigin || '')}</td>
      <td class="lbl">Phone / Mobile</td><td>${esc(a.phone || '')}</td></tr>
  <tr><td class="lbl">Email</td><td colspan="3">${esc(a.email || '')}</td></tr>
</table>`;

  function docHeader(docNum: number): string {
    const lrp = computeLRP(state, docNum);
    const docTitles: Record<number, string> = {
      1: 'Auxiliary Document for the Customs Declaration - Import',
      2: 'Auxiliary Document for the Customs Declaration - Sold Goods',
      3: 'Return Goods List - Re-export Declaration',
    };
    return `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">${esc(docTitles[docNum])}</div>
    <div class="doc-subtitle">${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${esc(m.event || '')}</div>
    <div class="lrp">LRP: ${esc(lrp || '—')}</div>
  </div>
</div>${importerInfo}`;
  }

  const formats: GoodsFormat[] = ['detailed', 'compressed', 'bytype'];
  const formatLabels: Record<GoodsFormat, string> = { detailed: 'Detailed', compressed: 'Compressed', bytype: 'By Type' };
  const docNums = onlyDocNum ? [onlyDocNum] : [1, 2, 3];
  const docShortNames: Record<number, string> = { 1: 'Import', 2: 'Sold', 3: 'Return' };

  const sections: string[] = [];
  docNums.forEach((docNum) => {
    formats.forEach((fmt) => {
      const label = `${docShortNames[docNum]} - ${formatLabels[fmt]}`;
      sections.push(`<div class="doc-section">
  <div class="page-label">${esc(label)}</div>
  ${docHeader(docNum)}
  ${buildGoodsTable(docNum, fmt)}
  <div class="signature-section"><strong>Date and Signature</strong><div class="signature-box"></div></div>
</div>`);
    });
  });

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>All Documents - ${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
${sections.join('\n')}
</body></html>`;

  return html;
}
