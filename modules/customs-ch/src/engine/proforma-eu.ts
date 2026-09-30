/**
 * EU-compliant proforma invoice.
 *
 * Same underlying figures as `proforma.ts`, laid out with the fields a
 * German export broker (or any EU customs officer) expects to find on an
 * invoice without asking: a unique invoice number, ISO country codes next
 * to every address, the seller's VAT/tax ID, and the agreed delivery term
 * (Incoterms) - these four are exactly what our broker's intake mail lists
 * as "Angabe auf der Rechnung" plus the identifiers EN 16931 (the EU e-invoice
 * standard) treats as mandatory on any invoice: BT-1 invoice number, BT-31
 * seller VAT identifier, BT-40/BT-55 country codes. This is still a proforma
 * for a temporary export - no VAT is charged, so no VAT breakdown is shown,
 * only the exemption reason.
 */
import { buildProformaHtml as coreBuildProformaHtml, proformaDocCss } from '@zollify/customs-core';
import { calcProduct, countryToCode, esc, floorN, fmtWeightKg, formatNum, hasCustomsInfo } from './calc';
import type { CustomsState } from './model';

export function buildProformaEuHtml(state: CustomsState, now: Date = new Date()): string {
  const m = state.meta;
  const a = state.artist;
  const cur = state.meta && state.meta.currency ? state.meta.currency : 'CHF';
  const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const pad = (n: number): string => String(n).padStart(2, '0');
  const invoiceNo = `PF-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;

  // hasCustomsInfo alone lets a zero-quantity item onto the invoice (nothing
  // brought/on hand this event) - the goods-list import doc already guards
  // against that (calcProduct(p).amount > 0), this didn't.
  const products = state.products.filter((p) => hasCustomsInfo(p) && calcProduct(p).amount > 0);

  const CSS = proformaDocCss({ metaRowWrap: true, vatNote: true });

  let totQty = 0,
    totVal = 0,
    totWkg = 0;
  const rows = products
    .map((p, i) => {
      const c = calcProduct(p);
      const qty = c.amount || 0;
      const unitPrice = c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : p.priceNote || '-';
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
      <td class="mat">${esc(p.material || '')}</td>
      <td>${esc(p.tariffNo || '-')}</td>
      <td class="r">${qty}</td>
      <td class="r">${c.effectiveUnitWeightG != null ? Math.round(c.effectiveUnitWeightG as number) + ' g' : '-'}</td>
      <td class="r">${fmtWeightKg(c.totalWeightKg)}</td>
      <td class="r">${esc(String(unitPrice))}</td>
      <td class="r">${c.totalValue != null ? c.totalValue : '-'}</td>
      <td class="r">${originCc}</td>
    </tr>`;
    })
    .join('');

  const sellerCc = countryToCode(a.countryOfOrigin);
  const buyerCc = countryToCode(m.venueCountry);

  const venueLines = [
    m.venueName || a.fullName || a.companyName || '',
    m.event ? 'c/o ' + m.event : '',
    m.venueStreet || '',
    [m.venuePostcode, m.venueCity].filter(Boolean).join(' '),
    [m.venueCountry, buyerCc ? `(${buyerCc})` : ''].filter(Boolean).join(' '),
    m.venueTIN ? `Tax/VAT ID: ${m.venueTIN}` : '',
  ]
    .filter(Boolean)
    .join('<br>');

  const artistLines = [
    a.companyName || '',
    a.fullName || '',
    a.street || '',
    a.postCodeCity || '',
    [a.countryOfOrigin || '', sellerCc ? `(${sellerCc})` : ''].filter(Boolean).join(' '),
    a.vatId ? `VAT/Tax ID: ${a.vatId}` : '',
  ]
    .filter(Boolean)
    .join('<br>');

  return coreBuildProformaHtml({
    titleHtml: `Proforma Invoice ${esc(invoiceNo)} - ${esc(m.event || 'ZollTool')}`,
    css: CSS,
    sellerLabel: 'Seller / Exporter',
    sellerName: esc(a.companyName || a.fullName || ''),
    sellerDetailHtml: artistLines,
    buyerLabel: 'Buyer / Consignee / Importer',
    buyerName: esc(m.venueName || a.fullName || ''),
    buyerDetailHtml: venueLines,
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
    emptyMessage: 'No products with customs information',
    tfootRowHtml: `    <td></td><td style="text-align:right">TOTALS</td><td class="mat"></td><td></td>
    <td class="r">${totQty}</td><td></td>
    <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
    <td class="r">${Math.floor(totVal)}</td><td></td>`,
    totalValueText: `${esc(cur)} ${Math.floor(totVal).toLocaleString('de-CH')}`,
    totalWeightHtml: fmtWeightKg(totWkg),
    vatNoteHtml: 'VAT: not applicable - temporary export, no supply of goods against consideration at this point. No VAT is charged on this invoice.',
    declarationHtml: `<strong>Declaration:</strong> I, the undersigned, hereby certify that the information on this proforma invoice is true and correct
  and that the contents of this consignment are as stated above. This invoice is issued for customs clearance purposes only
  and does not represent a commercial sale. The goods are temporarily imported into ${esc(m.venueCountry || 'the destination country')} for exhibition/sale at
  ${esc(m.event || 'the event')} and will be re-exported or accounted for after the event.`,
    signatoryName: esc(a.fullName || a.companyName || ''),
  });
}
