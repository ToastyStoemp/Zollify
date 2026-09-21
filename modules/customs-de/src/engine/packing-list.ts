/**
 * Packing list / commercial invoice for the German side of the trip.
 *
 * This is a preparation document for a declarant or customs broker - it is
 * NOT an ATLAS-Ausfuhr export declaration or an ATLAS re-import message.
 * This module has no verified ATLAS test access, so it stops short of
 * generating anything submitted directly to German customs; the actual
 * ATLAS filing still needs to be made by hand or through certified software.
 */
import { calcDeProduct, esc, fmtWeightKg } from './calc';
import type { CustomsDeState } from './model';

export type PackingListKind = 'export' | 'reimport';

export function buildPackingListHtml(state: CustomsDeState, kind: PackingListKind, now: Date = new Date()): string {
  const m = state.meta;
  const d = state.declarant;
  const cur = m.currency || 'EUR';
  const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const products = state.products.filter((p) => !p.unlisted && p.amount > 0);
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
  table.goods { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 6mm; }
  table.goods th { background: #222; color: #fff; padding: 4px 6px; text-align: left; font-size: 7.5pt; white-space: nowrap; }
  table.goods th.r { text-align: right; }
  table.goods td { border-bottom: 1px solid #ddd; padding: 4px 6px; vertical-align: middle; }
  table.goods tr:nth-child(even) td { background: #f8f8f8; }
  table.goods tfoot td { background: #eee; font-weight: bold; border-top: 2px solid #555; padding: 5px 6px; }
  .r { text-align: right; }
  .total-box { border: 2px solid #000; display: inline-block; padding: 4mm 8mm; margin-bottom: 6mm; }
  .total-box .total-label { font-size: 8pt; text-transform: uppercase; color: #555; }
  .total-box .total-value { font-size: 14pt; font-weight: bold; }
  .notice { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; margin-bottom: 6mm; line-height: 1.6; }
  .sig-line { border-top: 1px solid #000; padding-top: 2mm; font-size: 7.5pt; color: #777; margin-top: 10mm; width: 100mm; }
  @media print { body { padding: 0; } @page { size: A4 portrait; margin: 15mm; } }`;

  let totQty = 0,
    totVal = 0,
    totWkg = 0;
  const rows = products
    .map((p, i) => {
      const c = calcDeProduct(p);
      const qty = kind === 'export' ? p.amount : c.reimportQty;
      const weightKg = kind === 'export' ? c.totalWeightKg : c.reimportWeightKg;
      const value = kind === 'export' ? c.totalValue : c.reimportValue;
      if (kind === 'reimport' && qty <= 0) return '';
      totQty += qty;
      totVal += value ?? 0;
      totWkg += weightKg;
      return `<tr>
      <td class="r">${i + 1}</td>
      <td>${esc(p.title || '')}</td>
      <td>${esc(p.sku || '-')}</td>
      <td>${esc(p.tariffNo || '-')}</td>
      <td class="r">${qty}</td>
      <td class="r">${fmtWeightKg(weightKg)}</td>
      <td class="r">${value != null ? value : '-'}</td>
      <td class="r">${esc((p.originCountry || d.countryOfOrigin || '').toUpperCase())}</td>
    </tr>`;
    })
    .join('');

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

<table class="goods">
  <thead><tr>
    <th class="r">#</th>
    <th>Description</th>
    <th>SKU</th>
    <th>HS / tariff code</th>
    <th class="r">Qty</th>
    <th class="r">Weight</th>
    <th class="r">Value (${esc(cur)})</th>
    <th class="r">Origin</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="8" style="text-align:center;padding:8px;color:#888">Nothing to list</td></tr>'}</tbody>
  <tfoot><tr>
    <td></td><td style="text-align:right">TOTALS</td><td></td><td></td>
    <td class="r">${totQty}</td>
    <td class="r">${fmtWeightKg(totWkg)}</td>
    <td class="r">${Math.floor(totVal)}</td>
    <td></td>
  </tr></tfoot>
</table>

<div class="total-box">
  <div class="total-label">Total value</div>
  <div class="total-value">${esc(cur)} ${Math.floor(totVal).toLocaleString('de-DE')}</div>
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
