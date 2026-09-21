/**
 * Packing list / commercial invoice for the German side of the trip.
 *
 * This is a preparation document for a declarant or customs broker - it is
 * NOT an ATLAS-Ausfuhr export declaration or an ATLAS re-import message.
 * This module has no verified ATLAS test access, so it stops short of
 * generating anything submitted directly to German customs; the actual
 * ATLAS filing still needs to be made by hand or through certified software.
 *
 * Column set and the three format options (Detailed / Compressed / By type)
 * match customs-ch's import goods list (engine/goods-list.ts, docNum 1) -
 * same idea, same level of detail, checked against it directly. Two columns
 * from that document are deliberately left out: Tariff Rate and VAT Rate are
 * Swiss import-duty figures, assessed when the goods enter Switzerland; they
 * don't exist yet at the point this document is prepared (Germany, before
 * export) and aren't this module's to calculate.
 */
import { calcDeProduct, esc, fmtWeightKg, hasVariants } from './calc';
import type { CustomsDeState } from './model';

export type PackingListKind = 'export' | 'reimport';
export type PackingListFormat = 'detailed' | 'compressed' | 'bytype';

/** By-type group label; the HS code is appended only when two groups share a type. */
function byTypeGroupName(all: { type: string }[], g: { type: string; tariffNo: string }): string {
  const shared = all.filter((x) => x.type === g.type).length > 1;
  return shared ? `${esc(g.type)} (${esc(g.tariffNo || 'no HS code')})` : esc(g.type);
}

/** `r` cells are right-aligned via the same `td.r` rule the CSS block declares. */
function row(cells: { text: string | number; r?: boolean }[]): string {
  return `<tr>${cells.map((c) => `<td${c.r ? ' class="r"' : ''}>${c.text}</td>`).join('')}</tr>`;
}

export function buildPackingListHtml(state: CustomsDeState, kind: PackingListKind, format: PackingListFormat = 'detailed', now: Date = new Date()): string {
  const m = state.meta;
  const d = state.declarant;
  const cur = m.currency || 'EUR';
  const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const products = state.products.filter((p) => !p.unlisted);
  const title = kind === 'export' ? 'Export packing list' : 'Re-import packing list (unsold goods)';

  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; color: #000; padding: 15mm; }
  .doc-title { font-size: 16pt; font-weight: bold; text-transform: uppercase; margin-bottom: 6mm; }
  .parties { display: flex; gap: 10mm; margin-bottom: 6mm; }
  .party { flex: 1; border: 1px solid #ccc; padding: 4mm; }
  .party-label { font-size: 7pt; font-weight: bold; text-transform: uppercase; color: #666; margin-bottom: 2mm; border-bottom: 1px solid #ddd; padding-bottom: 1mm; }
  .party-name { font-size: 10pt; font-weight: bold; margin-bottom: 1mm; }
  .party-detail { font-size: 8pt; line-height: 1.5; color: #222; }
  .meta-row { display: flex; gap: 8mm; margin-bottom: 6mm; font-size: 8pt; flex-wrap: wrap; }
  .meta-item .meta-label { font-weight: bold; font-size: 7pt; text-transform: uppercase; color: #666; }
  .meta-item .meta-value { font-size: 9pt; margin-top: 1px; }
  .section-title { font-weight: bold; font-size: 9pt; margin: 0 0 2mm 0; }
  table.goods { width: 100%; border-collapse: collapse; font-size: 7pt; margin-bottom: 6mm; }
  table.goods th { background: #222; color: #fff; padding: 3px 5px; text-align: left; font-size: 6.5pt; white-space: nowrap; }
  table.goods th.r { text-align: right; }
  table.goods td { border-bottom: 1px solid #ddd; padding: 3px 5px; vertical-align: middle; }
  table.goods td.r { text-align: right; }
  table.goods tr:nth-child(even) td { background: #f8f8f8; }
  table.goods tfoot td { background: #eee; font-weight: bold; border-top: 2px solid #555; padding: 4px 5px; }
  .r { text-align: right; }
  .total-box { border: 2px solid #000; display: inline-block; padding: 4mm 8mm; margin-bottom: 6mm; }
  .total-box .total-label { font-size: 8pt; text-transform: uppercase; color: #555; }
  .total-box .total-value { font-size: 14pt; font-weight: bold; }
  .notice { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; margin-bottom: 6mm; line-height: 1.6; }
  .sig-line { border-top: 1px solid #000; padding-top: 2mm; font-size: 7.5pt; color: #777; margin-top: 10mm; width: 100mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

  let totQty = 0,
    totWkg = 0,
    totVal = 0,
    hasVal = false;
  let tableHtml: string;

  if (format === 'bytype') {
    const groups = new Map<string, { type: string; tariffNo: string; qty: number; wkg: number; val: number; hasVal: boolean }>();
    for (const p of products) {
      const c = calcDeProduct(p);
      const qty = kind === 'export' ? c.amount : c.reimportQty;
      if (qty <= 0) continue;
      const wkg = kind === 'export' ? c.totalWeightKg : c.reimportWeightKg;
      const val = kind === 'export' ? c.totalValue : c.reimportValue;
      const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}`;
      const g = groups.get(key) ?? { type: p.type || 'Other', tariffNo: p.tariffNo || '', qty: 0, wkg: 0, val: 0, hasVal: false };
      g.qty += qty;
      g.wkg += wkg;
      if (val != null) {
        g.val += val;
        g.hasVal = true;
      }
      groups.set(key, g);
      totQty += qty;
      totWkg += wkg;
      if (val != null) {
        totVal += val;
        hasVal = true;
      }
    }
    const groupList = [...groups.values()];
    const rows = groupList
      .map((g, i) =>
        row([
          { text: i + 1, r: true },
          { text: `<strong>${byTypeGroupName(groupList, g)}</strong>` },
          { text: esc(g.tariffNo || '-'), r: true },
          { text: g.qty, r: true },
          { text: fmtWeightKg(g.wkg), r: true },
          { text: g.hasVal ? g.val : '-', r: true },
        ]),
      )
      .join('');
    tableHtml = `<div class="section-title">List of goods (By type)</div>
<table class="goods"><thead><tr>
  <th class="r">#</th><th>Type</th><th class="r">HS / tariff code</th>
  <th class="r">Qty</th><th class="r">Weight</th><th class="r">Value (${esc(cur)})</th>
</tr></thead><tbody>${rows || `<tr><td colspan="6" style="text-align:center;padding:8px;color:#888">Nothing to list</td></tr>`}</tbody>
<tfoot><tr>
  <td colspan="3" style="text-align:right">TOTALS</td>
  <td class="r">${totQty}</td>
  <td class="r">${fmtWeightKg(totWkg)}</td>
  <td class="r">${hasVal ? Math.floor(totVal) : '-'}</td>
</tr></tfoot></table>`;
  } else {
    const rowsArr: string[] = [];
    let rowNum = 0;

    for (const p of products) {
      const origin = esc((p.originCountry || d.countryOfOrigin || '').toUpperCase());
      const forSaleLabel = p.forSale === false ? 'Not for sale' : 'For sale';

      if (format === 'detailed' && hasVariants(p)) {
        for (const v of p.variants!) {
          if (v.unlisted) continue;
          const vAmount = v.amount || 0;
          const qty = kind === 'export' ? vAmount : Math.max(0, vAmount - (v.soldQty || 0));
          if (qty <= 0) continue;
          const wgRaw = v.weightG != null && v.weightG !== '' ? v.weightG : p.weightG;
          const wg = parseFloat(String(wgRaw ?? '')) || 0;
          const priceRaw = v.price != null && v.price !== '' ? v.price : p.price;
          const price = priceRaw != null && priceRaw !== '' ? parseFloat(String(priceRaw)) : null;
          const weightKg = Math.round(qty * wg) / 1000;
          const value = price != null ? Math.round(price * qty) : null;
          totQty += qty;
          totWkg += weightKg;
          if (value != null) {
            totVal += value;
            hasVal = true;
          }
          rowNum++;
          rowsArr.push(
            row([
              { text: rowNum, r: true },
              { text: esc(v.sku || p.sku || '-') },
              { text: `${esc(p.title || '')} - ${esc(v.name || '')}` },
              { text: forSaleLabel },
              { text: esc(p.type || '') },
              { text: qty, r: true },
              { text: wg ? Math.round(wg) + ' g' : '-', r: true },
              { text: fmtWeightKg(weightKg), r: true },
              { text: price != null ? price : '-', r: true },
              { text: value != null ? value : '-', r: true },
              { text: esc(p.tariffNo || '-'), r: true },
              { text: origin, r: true },
            ]),
          );
        }
      } else {
        const c = calcDeProduct(p);
        const qty = kind === 'export' ? c.amount : c.reimportQty;
        if (qty <= 0) continue;
        const weightKg = kind === 'export' ? c.totalWeightKg : c.reimportWeightKg;
        const value = kind === 'export' ? c.totalValue : c.reimportValue;
        totQty += qty;
        totWkg += weightKg;
        if (value != null) {
          totVal += value;
          hasVal = true;
        }
        rowNum++;
        const listedVariants = hasVariants(p) ? p.variants!.filter((v) => !v.unlisted).length : 0;
        const titleDisplay = listedVariants ? `${esc(p.title || '')} (${listedVariants} variant${listedVariants === 1 ? '' : 's'})` : esc(p.title || '');
        rowsArr.push(
          row([
            { text: rowNum, r: true },
            { text: esc(p.sku || '-') },
            { text: titleDisplay },
            { text: forSaleLabel },
            { text: esc(p.type || '') },
            { text: qty, r: true },
            { text: c.effectiveUnitWeightG ? Math.round(c.effectiveUnitWeightG) + ' g' : '-', r: true },
            { text: fmtWeightKg(weightKg), r: true },
            { text: c.effectiveUnitPrice != null ? c.effectiveUnitPrice : '-', r: true },
            { text: value != null ? value : '-', r: true },
            { text: esc(p.tariffNo || '-'), r: true },
            { text: origin, r: true },
          ]),
        );
      }
    }

    const formatLabel = format === 'detailed' ? 'Detailed' : 'Compressed';
    tableHtml = `<div class="section-title">List of goods (${formatLabel})</div>
<table class="goods"><thead><tr>
  <th class="r">#</th><th>SKU</th><th>Title</th><th>For sale</th><th>Type</th>
  <th class="r">Qty</th><th class="r">Unit weight</th><th class="r">Total weight</th>
  <th class="r">Unit value (${esc(cur)})</th><th class="r">Total value (${esc(cur)})</th>
  <th class="r">HS / tariff code</th><th class="r">Origin</th>
</tr></thead><tbody>${rowsArr.join('') || `<tr><td colspan="12" style="text-align:center;padding:8px;color:#888">Nothing to list</td></tr>`}</tbody>
<tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td>
  <td class="r">${totQty}</td><td></td>
  <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
  <td class="r">${hasVal ? Math.floor(totVal) : '-'}</td>
  <td colspan="2"></td>
</tr></tfoot></table>`;
  }

  const declarantLines = [d.companyName || '', d.fullName || '', d.street || '', d.postCodeCity || '', d.countryOfOrigin || ''].filter(Boolean).join('<br>');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(title)} - ${esc(m.event || '')}</title>
<style>${CSS}</style></head><body>
<div class="doc-title">${esc(title)}</div>

<div class="parties">
  <div class="party">
    <div class="party-label">Exporter / declarant</div>
    <div class="party-name">${esc(d.companyName || d.fullName || '')}</div>
    <div class="party-detail">${declarantLines}</div>
  </div>
  <div class="party">
    <div class="party-label">Precheck office</div>
    <div class="party-detail">${esc(m.precheckOffice || '-')}<br>EORI: ${esc(m.eori || '-')}${m.exportMrn ? `<br>Export MRN: ${esc(m.exportMrn)}` : ''}</div>
  </div>
</div>

<div class="meta-row">
  <div class="meta-item"><div class="meta-label">Date</div><div class="meta-value">${today}</div></div>
  <div class="meta-item"><div class="meta-label">Event</div><div class="meta-value">${esc(m.event || '-')}</div></div>
  <div class="meta-item"><div class="meta-label">Event dates</div><div class="meta-value">${esc([m.eventDateStart, m.eventDateEnd].filter(Boolean).join(' - ') || '-')}</div></div>
  <div class="meta-item"><div class="meta-label">Currency</div><div class="meta-value">${esc(cur)}</div></div>
</div>

${tableHtml}

<div class="total-box">
  <div class="total-label">Total value</div>
  <div class="total-value">${esc(cur)} ${(hasVal ? Math.floor(totVal) : 0).toLocaleString('de-DE')}</div>
  <div class="total-label" style="margin-top:3mm">Total weight</div>
  <div class="total-value">${fmtWeightKg(totWkg)}</div>
</div>

<div class="notice">
  ${
    kind === 'export'
      ? 'These are the goods taken to the event for temporary export, pending sale. Unsold quantities are expected back into Germany afterwards - see the re-import list.'
      : `Quantities not sold at ${esc(m.event || 'the event')}, returning to Germany. ${m.exportMrn ? `References export MRN ${esc(m.exportMrn)}.` : 'Record the export MRN under Customs (Germany) → Declaration details once known, so it can be referenced here.'}`
  }
</div>

<div class="sig-line">${esc(d.fullName || d.companyName || '')} &nbsp;&nbsp;·&nbsp;&nbsp; Date: _______________</div>
</body></html>`;

  return html;
}
