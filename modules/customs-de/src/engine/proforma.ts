/**
 * EU-compliant proforma invoice (Warenrechnung) - the German broker's mail
 * asks for this alongside the packing list. Same fields as customs-ch's
 * proforma-eu.ts (invoice number, seller VAT ID, ISO country codes, agreed
 * delivery term) so a German export broker gets what they ask for without a
 * name/address hunt. Still a proforma for a temporary export - no VAT is
 * charged, only the exemption reason is shown.
 */
import { calcDeProduct, countryToCode, esc, fmtWeightKg } from './calc';
import type { CustomsDeState } from './model';

export function buildProformaHtml(state: CustomsDeState, now: Date = new Date()): string {
  const m = state.meta;
  const d = state.declarant;
  const cur = m.currency || 'EUR';
  const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const pad = (n: number): string => String(n).padStart(2, '0');
  const invoiceNo = `PF-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  const products = state.products.filter((p) => !p.unlisted && p.amount > 0);

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
  .vat-note { font-size: 8pt; color: #333; margin-bottom: 6mm; }
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
      const c = calcDeProduct(p);
      const qty = p.amount || 0;
      const unitPrice = p.price != null && p.price !== '' ? Number(p.price) : null;
      totQty += qty;
      totVal += c.totalValue ?? 0;
      totWkg += c.totalWeightKg;
      const originCc = (p.originCountry || d.countryOfOrigin || '').toUpperCase();
      return `<tr>
      <td class="r">${i + 1}</td>
      <td>${esc(p.title || '')}${p.material?.trim() ? ` - ${esc(p.material)}` : ''}</td>
      <td>${esc(p.tariffNo || '-')}</td>
      <td class="r">${qty}</td>
      <td class="r">${fmtWeightKg(c.totalWeightKg)}</td>
      <td class="r">${unitPrice != null ? unitPrice : '-'}</td>
      <td class="r">${c.totalValue != null ? c.totalValue : '-'}</td>
      <td class="r">${esc(originCc)}</td>
    </tr>`;
    })
    .join('');

  const sellerCc = countryToCode(d.countryOfOrigin) || 'DE';
  const buyerCc = countryToCode(m.consigneeCountry) || countryToCode(m.destinationCountry) || '';

  const sellerLines = [
    d.companyName || '',
    d.fullName || '',
    d.street || '',
    d.postCodeCity || '',
    [d.countryOfOrigin || '', sellerCc ? `(${sellerCc})` : ''].filter(Boolean).join(' '),
    d.vatId ? `VAT/Tax ID: ${d.vatId}` : '',
    m.eori ? `EORI: ${m.eori}` : '',
  ]
    .filter(Boolean)
    .join('<br>');

  const buyerLines = [
    m.consigneeName || (m.event ? `c/o ${m.event}` : ''),
    m.consigneeStreet || '',
    [m.consigneePostcode, m.consigneeCity].filter(Boolean).join(' '),
    [m.consigneeCountry || m.destinationCountry || '', buyerCc ? `(${buyerCc})` : ''].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join('<br>');

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Proforma Invoice ${esc(invoiceNo)} - ${esc(m.event || '')}</title>
<style>${CSS}</style></head><body>
<div class="watermark">For Customs Clearance Purposes Only &mdash; Not for Commercial Use</div>
<div class="doc-title">Proforma Invoice</div>
<div class="doc-subtitle">This document is issued solely for customs clearance and does not constitute a commercial transaction.</div>

<div class="parties">
  <div class="party">
    <div class="party-label">Seller / Exporter</div>
    <div class="party-name">${esc(d.companyName || d.fullName || '')}</div>
    <div class="party-detail">${sellerLines}</div>
  </div>
  <div class="party">
    <div class="party-label">Buyer / Consignee / Importer</div>
    <div class="party-name">${esc(m.consigneeName || m.event || '')}</div>
    <div class="party-detail">${buyerLines || '<em style="color:#c00">missing</em>'}</div>
  </div>
</div>

<div class="meta-row">
  <div class="meta-item"><div class="meta-label">Invoice No.</div><div class="meta-value">${esc(invoiceNo)}</div></div>
  <div class="meta-item"><div class="meta-label">Invoice Date</div><div class="meta-value">${today}</div></div>
  <div class="meta-item"><div class="meta-label">Currency</div><div class="meta-value">${esc(cur)}</div></div>
  <div class="meta-item"><div class="meta-label">Delivery Term (Incoterms)</div><div class="meta-value">${esc(m.incoterms) || '<em style="color:#c00">not set</em>'}</div></div>
  <div class="meta-item"><div class="meta-label">Event</div><div class="meta-value">${esc(m.event || '-')}</div></div>
  <div class="meta-item"><div class="meta-label">Event Dates</div><div class="meta-value">${esc([m.eventDateStart, m.eventDateEnd].filter(Boolean).join(' - ') || '-')}</div></div>
</div>

<table class="goods">
  <thead><tr>
    <th class="r">#</th>
    <th>Description</th>
    <th>HS / Tariff Code</th>
    <th class="r">Qty</th>
    <th class="r">Weight</th>
    <th class="r">Unit Value (${esc(cur)})</th>
    <th class="r">Total Value (${esc(cur)})</th>
    <th class="r">Origin</th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="8" style="text-align:center;padding:8px;color:#888">No products claimed for this event</td></tr>'}</tbody>
  <tfoot><tr>
    <td></td><td style="text-align:right">TOTALS</td><td></td>
    <td class="r">${totQty}</td>
    <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
    <td class="r">${Math.floor(totVal)}</td><td></td>
  </tr></tfoot>
</table>

<div class="total-box">
  <div class="total-label">Total Declared Value</div>
  <div class="total-value">${esc(cur)} ${Math.floor(totVal).toLocaleString('de-DE')}</div>
  <div class="total-label" style="margin-top:3mm">Total Gross Weight</div>
  <div class="total-value">${fmtWeightKg(totWkg)}</div>
</div>

<div class="vat-note">VAT: not applicable - temporary export, no supply of goods against consideration at this point. No VAT is charged on this invoice.</div>

<div class="declaration">
  <strong>Declaration:</strong> I, the undersigned, hereby certify that the information on this proforma invoice is true and correct
  and that the contents of this consignment are as stated above. This invoice is issued for customs clearance purposes only
  and does not represent a commercial sale. The goods are temporarily exported from Germany for exhibition/sale at
  ${esc(m.event || 'the event')} and will be re-imported or accounted for after the event.
</div>

<div class="sig-block">
  <div class="sig-label">Signature &amp; Date</div>
  <div class="sig-line">${esc(d.fullName || d.companyName || '')} &nbsp;&nbsp;·&nbsp;&nbsp; Date: _______________</div>
</div>
</body></html>`;

  return html;
}
