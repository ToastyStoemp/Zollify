/** Proforma invoice — exact port of legacy printProformaInvoice() (golden-tested). */
import { calcProduct, countryToCode, esc, floorN, fmtWeightKg, formatNum, hasCustomsInfo } from './calc';
import type { CustomsState } from './model';

export function buildProformaHtml(state: CustomsState, now: Date = new Date()): string {
  const m = state.meta;
  const a = state.artist;
  const cur = state.meta && state.meta.currency ? state.meta.currency : 'CHF';
  const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  const products = state.products.filter(hasCustomsInfo);

  const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; color: #000; padding: 15mm; }
  .watermark { text-align: center; font-size: 8pt; color: #c00; font-weight: bold; letter-spacing: 1px;
               border: 1.5px solid #c00; padding: 4px 10px; display: inline-block; margin-bottom: 6mm; text-transform: uppercase; }
  .doc-title { font-size: 16pt; font-weight: bold; text-transform: uppercase; margin-bottom: 1mm; }
  .doc-subtitle { font-size: 8pt; color: #555; margin-bottom: 6mm; }
  .parties { display: flex; gap: 10mm; margin-bottom: 6mm; }
  .party { flex: 1; border: 1px solid #ccc; padding: 4mm; }
  .party-label { font-size: 7pt; font-weight: bold; text-transform: uppercase; color: #666; margin-bottom: 2mm; border-bottom: 1px solid #ddd; padding-bottom: 1mm; }
  .party-name { font-size: 10pt; font-weight: bold; margin-bottom: 1mm; }
  .party-detail { font-size: 8pt; line-height: 1.5; color: #222; }
  .meta-row { display: flex; gap: 8mm; margin-bottom: 6mm; font-size: 8pt; }
  .meta-item { }
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
  .declaration { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; margin-bottom: 6mm; line-height: 1.6; }
  .sig-block { display: inline-block; width: 100mm; }
  .sig-label { font-size: 7.5pt; color: #555; margin-bottom: 1mm; }
  .sig-line { border-top: 1px solid #000; padding-top: 2mm; font-size: 7.5pt; color: #777; margin-top: 10mm; }
  @media print { body { padding: 0; } @page { size: A4 portrait; margin: 15mm; } }`;

  let totQty = 0,
    totVal = 0,
    totWkg = 0;
  const rows = products
    .map((p, i) => {
      const c = calcProduct(p);
      const qty = c.amount || 0;
      const unitPrice = c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : p.priceNote || '—';
      const totalVal = c.totalValue != null ? c.totalValue : 0;
      const originCc =
        p.originCountry && p.originCountry.trim()
          ? p.originCountry.trim().toUpperCase()
          : countryToCode(a.countryOfOrigin) || '';
      totQty += qty;
      totVal += totalVal;
      totWkg += c.totalWeightKg;
      return `<tr>
      <td class="r">${i + 1}</td>
      <td>${esc(p.title || '')}</td>
      <td>${esc(p.tariffNo || '—')}</td>
      <td class="r">${qty}</td>
      <td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG as number) + ' g' : '—'}</td>
      <td class="r">${fmtWeightKg(c.totalWeightKg)}</td>
      <td class="r">${esc(String(unitPrice))}</td>
      <td class="r">${c.totalValue != null ? c.totalValue : '—'}</td>
      <td class="r">${originCc}</td>
    </tr>`;
    })
    .join('');

  const venueLines = [
    m.venueName || a.fullName || a.companyName || '',
    m.event ? 'c/o ' + m.event : '',
    m.venueStreet || '',
    [m.venuePostcode, m.venueCity].filter(Boolean).join(' '),
    m.venueCountry || '',
  ]
    .filter(Boolean)
    .join('<br>');

  const artistLines = [a.companyName || '', a.fullName || '', a.street || '', a.postCodeCity || '', a.countryOfOrigin || '']
    .filter(Boolean)
    .join('<br>');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Proforma Invoice -${esc(m.event || 'ZollTool')}</title>
<style>${CSS}</style></head><body>
<div class="watermark">For Customs Clearance Purposes Only &mdash; Not for Commercial Use</div>
<div class="doc-title">Proforma Invoice</div>
<div class="doc-subtitle">This document is issued solely for customs clearance and does not constitute a commercial transaction.</div>

<div class="parties">
  <div class="party">
    <div class="party-label">Seller / Exporter</div>
    <div class="party-name">${esc(a.companyName || a.fullName || '')}</div>
    <div class="party-detail">${artistLines}</div>
  </div>
  <div class="party">
    <div class="party-label">Consignee / Importer</div>
    <div class="party-name">${esc(m.venueName || a.fullName || '')}</div>
    <div class="party-detail">${venueLines}</div>
  </div>
</div>

<div class="meta-row">
  <div class="meta-item"><div class="meta-label">Invoice Date</div><div class="meta-value">${today}</div></div>
  <div class="meta-item"><div class="meta-label">Event</div><div class="meta-value">${esc(m.event || '—')}</div></div>
  <div class="meta-item"><div class="meta-label">Event Dates</div><div class="meta-value">${esc([m.eventDateStart, m.eventDateEnd].filter(Boolean).join(' – ') || '—')}</div></div>
  <div class="meta-item"><div class="meta-label">Currency</div><div class="meta-value">${esc(cur)}</div></div>
</div>

<table class="goods">
  <thead><tr>
    <th class="r">#</th>
    <th>Description</th>
    <th>HS / Tariff Code</th>
    <th class="r">Qty</th>
    <th class="r">Unit Weight</th>
    <th class="r">Total Weight</th>
    <th class="r">Unit Value (${esc(cur)})</th>
    <th class="r">Total Value (${esc(cur)})</th>
    <th class="r">Origin</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="9" style="text-align:center;padding:8px;color:#888">No products with customs information</td></tr>'}</tbody>
  <tfoot><tr>
    <td></td><td style="text-align:right">TOTALS</td><td></td>
    <td class="r">${totQty}</td><td></td>
    <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
    <td class="r">${Math.floor(totVal)}</td><td></td>
  </tr></tfoot>
</table>

<div class="total-box">
  <div class="total-label">Total Declared Value</div>
  <div class="total-value">${esc(cur)} ${Math.floor(totVal).toLocaleString('de-CH')}</div>
  <div class="total-label" style="margin-top:3mm">Total Gross Weight</div>
  <div class="total-value">${fmtWeightKg(totWkg)}</div>
</div>

<div class="declaration">
  <strong>Declaration:</strong> I, the undersigned, hereby certify that the information on this proforma invoice is true and correct
  and that the contents of this consignment are as stated above. This invoice is issued for customs clearance purposes only
  and does not represent a commercial sale. The goods are temporarily imported into ${esc(m.venueCountry || 'the destination country')} for exhibition/sale at
  ${esc(m.event || 'the event')} and will be re-exported or accounted for after the event.
</div>

<div class="sig-block">
  <div class="sig-label">Signature &amp; Date</div>
  <div class="sig-line">${esc(a.fullName || a.companyName || '')} &nbsp;&nbsp;·&nbsp;&nbsp; Date: _______________</div>
</div>
</body></html>`;

  return html;
}
