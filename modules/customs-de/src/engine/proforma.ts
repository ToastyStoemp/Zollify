/**
 * EU-compliant proforma invoice (Warenrechnung) - the German broker's mail
 * asks for this alongside the packing list. Same fields as customs-ch's
 * proforma-eu.ts (invoice number, seller VAT ID, ISO country codes, agreed
 * delivery term) so a German export broker gets what they ask for without a
 * name/address hunt. Still a proforma for a temporary export - no VAT is
 * charged, only the exemption reason is shown.
 */
import { buildProformaHtml as coreBuildProformaHtml, proformaDocCss } from '@zollify/customs-core';
import { calcDeProduct, countryToCode, esc, floorN, formatNum, fmtWeightKg } from './calc';
import type { CustomsDeState } from './model';

export function buildProformaHtml(state: CustomsDeState, now: Date = new Date()): string {
  const m = state.meta;
  const d = state.declarant;
  const cur = m.currency || 'EUR';
  const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const pad = (n: number): string => String(n).padStart(2, '0');
  const invoiceNo = `PF-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  // p.amount alone is the flat/non-variant field - a variant product (the
  // common case) carries its real quantity across p.variants[].amount
  // instead, calcDeProduct(p).amount is what actually sums that. Filtering
  // on the raw field silently dropped every variant product with stock from
  // this document entirely, which is exactly why its totals stopped
  // matching the packing list (which already used the computed amount) and
  // customs-ch's own documents.
  const products = state.products.filter((p) => !p.unlisted && calcDeProduct(p).amount > 0);

  const CSS = proformaDocCss({ metaRowWrap: true, vatNote: true });

  let totQty = 0,
    totVal = 0,
    totWkg = 0;
  const rows = products
    .map((p, i) => {
      const c = calcDeProduct(p);
      const qty = c.amount;
      totQty += qty;
      totVal += c.totalValue ?? 0;
      totWkg += c.totalWeightKg;
      const originCc = (p.originCountry || d.countryOfOrigin || '').toUpperCase();
      return `<tr>
      <td class="r">${i + 1}</td>
      <td>${esc(p.title || '')}</td>
      <td class="mat">${esc(p.material || '')}</td>
      <td>${esc(p.tariffNo || '-')}</td>
      <td class="r">${qty}</td>
      <td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG) + ' g' : '-'}</td>
      <td class="r">${fmtWeightKg(c.totalWeightKg)}</td>
      <td class="r">${c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '-'}</td>
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

  return coreBuildProformaHtml({
    titleHtml: `Proforma Invoice ${esc(invoiceNo)} - ${esc(m.event || '')}`,
    css: CSS,
    sellerLabel: 'Seller / Exporter',
    sellerName: esc(d.companyName || d.fullName || ''),
    sellerDetailHtml: sellerLines,
    buyerLabel: 'Buyer / Consignee / Importer',
    buyerName: esc(m.consigneeName || m.event || ''),
    buyerDetailHtml: buyerLines || '<em style="color:#c00">missing</em>',
    metaRowHtml: `  <div class="meta-item"><div class="meta-label">Invoice No.</div><div class="meta-value">${esc(invoiceNo)}</div></div>
  <div class="meta-item"><div class="meta-label">Invoice Date</div><div class="meta-value">${today}</div></div>
  <div class="meta-item"><div class="meta-label">Currency</div><div class="meta-value">${esc(cur)}</div></div>
  <div class="meta-item"><div class="meta-label">Delivery Term (Incoterms)</div><div class="meta-value">${esc(m.incoterms) || '<em style="color:#c00">not set</em>'}</div></div>
  <div class="meta-item"><div class="meta-label">Event</div><div class="meta-value">${esc(m.event || '-')}</div></div>
  <div class="meta-item"><div class="meta-label">Event Dates</div><div class="meta-value">${esc([m.eventDateStart, m.eventDateEnd].filter(Boolean).join(' - ') || '-')}</div></div>`,
    theadRowsHtml: `    <th class="r">#</th>
    <th>Description</th>
    <th class="mat">Material</th>
    <th>HS / Tariff Code</th>
    <th class="r">Qty</th>
    <th class="r">Unit Weight</th>
    <th class="r">Total Weight</th>
    <th class="r">Unit Value (${esc(cur)})</th>
    <th class="r">Total Value (${esc(cur)})</th>
    <th class="r">Origin</th>`,
    bodyRowsHtml: rows,
    emptyColspan: 10,
    emptyMessage: 'No products claimed for this event',
    tfootRowHtml: `    <td></td><td style="text-align:right">TOTALS</td><td class="mat"></td><td></td>
    <td class="r">${totQty}</td><td></td>
    <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
    <td class="r">${Math.floor(totVal)}</td><td></td>`,
    totalValueText: `${esc(cur)} ${Math.floor(totVal).toLocaleString('de-DE')}`,
    totalWeightHtml: fmtWeightKg(totWkg),
    vatNoteHtml: 'VAT: not applicable - temporary export, no supply of goods against consideration at this point. No VAT is charged on this invoice.',
    declarationHtml: `<strong>Declaration:</strong> I, the undersigned, hereby certify that the information on this proforma invoice is true and correct
  and that the contents of this consignment are as stated above. This invoice is issued for customs clearance purposes only
  and does not represent a commercial sale. The goods are temporarily exported from Germany for exhibition/sale at
  ${esc(m.event || 'the event')} and will be re-imported or accounted for after the event.`,
    signatoryName: esc(d.fullName || d.companyName || ''),
  });
}
