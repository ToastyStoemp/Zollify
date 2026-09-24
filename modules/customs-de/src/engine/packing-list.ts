/**
 * Packing list / commercial invoice for the German side of the trip.
 *
 * This is a preparation document for a declarant or customs broker - it is
 * NOT an ATLAS-Ausfuhr export declaration or an ATLAS re-import message.
 * This module has no verified ATLAS test access, so it stops short of
 * generating anything submitted directly to German customs; the actual
 * ATLAS filing still needs to be made by hand or through certified software.
 *
 * Built 1:1 against customs-ch's import goods list (engine/goods-list.ts,
 * docNum 1) - same header layout (doc-top + info-table), same goods-table
 * styling, same three format options (Detailed / Compressed / By type), same
 * type-grouped product order (see adapter.ts). Two differences, both
 * deliberate:
 *   - Tariff Rate and VAT Rate columns are left out - those are Swiss
 *     import-duty figures, assessed when the goods enter Switzerland; they
 *     don't exist yet at the point this document is prepared (Germany,
 *     before export) and aren't this module's to calculate.
 *   - The info-table's declarant fields are this module's own (EORI,
 *     precheck office) instead of customs-ch's LRP/artist fields.
 */
import { calcDeProduct, calcDeProductByMaterial, esc, fmtEventDates, fmtWeightKg, hasVariants } from './calc';
import type { CustomsDeProduct, CustomsDeState, CustomsDeVariant } from './model';
import { isArtwork } from '../lib/artwork';

export type PackingListKind = 'export' | 'reimport';
export type PackingListFormat = 'detailed' | 'compressed' | 'bytype';

/** By-type group label. Material and HS code both have their own column on this table, so neither is repeated here. Mirrors customs-ch/engine/goods-list.ts's byTypeGroupName(). */
function byTypeGroupName(g: { type: string }): string {
  return esc(g.type);
}

/**
 * Customs line name - an item is only as identifiable as its title, and two
 * booths' "Sunset" print aren't the same thing. Art prints read as
 * "Title (Year) - Artist". Mirrors customs-ch/engine/goods-list.ts's
 * titleForCustoms().
 */
function titleForCustoms(p: CustomsDeProduct, artistName?: string): string {
  const t = esc(p.title || '');
  if (isArtwork(p.type)) {
    const base = p.year ? `${t} (${p.year})` : t;
    const artist = (artistName ?? '').trim();
    return artist ? `${base} - ${esc(artist)}` : base;
  }
  return t;
}

/** A variant's own material override, falling back to the product's. Mirrors customs-ch/engine/goods-list.ts's resolveMaterial(). */
function resolveMaterial(p: CustomsDeProduct, v: CustomsDeVariant): string {
  return (v.material ?? p.material) || '';
}

function materialCell(material?: string): string {
  return `<td class="mat">${esc(material || '')}</td>`;
}

export function buildPackingListHtml(state: CustomsDeState, kind: PackingListKind, format: PackingListFormat = 'detailed', now: Date = new Date()): string {
  const m = state.meta;
  const d = state.declarant;
  const cur = m.currency || 'EUR';
  const products = state.products.filter((p) => !p.unlisted);
  const title = kind === 'export' ? 'Export packing list' : 'Re-import packing list (unsold goods)';

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
  .total-box { border: 2px solid #000; display: inline-block; padding: 4mm 8mm; margin: 4mm 0; }
  .total-box .total-label { font-size: 8pt; text-transform: uppercase; color: #555; }
  .total-box .total-value { font-size: 14pt; font-weight: bold; }
  .notice { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; margin-top: 4mm; line-height: 1.6; }
  .signature-section { margin-top: 8mm; }
  .signature-box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

  let totQty = 0,
    totWkg = 0,
    totVal = 0,
    hasVal = false;
  let tableHtml: string;

  if (format === 'bytype') {
    // Group by type + tariff code + material - a group can only ever have one
    // material, so a product whose own variants use different materials
    // splits across groups too (calcDeProductByMaterial). Mirrors
    // customs-ch/engine/goods-list.ts's by-type grouping.
    const groups = new Map<string, { type: string; tariffNo: string; material: string; qty: number; wkg: number; val: number; hasVal: boolean }>();
    for (const p of products) {
      for (const mc of calcDeProductByMaterial(p)) {
        const qty = kind === 'export' ? mc.amount : mc.reimportQty;
        if (qty <= 0) continue;
        const wkg = kind === 'export' ? mc.totalWeightKg : mc.reimportWeightKg;
        const val = kind === 'export' ? mc.totalValue : mc.reimportValue;
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}\x00${mc.material}`;
        const g = groups.get(key) ?? { type: p.type || 'Other', tariffNo: p.tariffNo || '', material: mc.material, qty: 0, wkg: 0, val: 0, hasVal: false };
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
    }
    const groupList = [...groups.values()];
    const rows = groupList
      .map(
        (g, i) =>
          `<tr><td class="c">${i + 1}</td><td><strong>${byTypeGroupName(g)}</strong></td>${materialCell(g.material)}<td class="r">${esc(g.tariffNo || '-')}</td><td class="r">${g.qty}</td><td class="r">${fmtWeightKg(g.wkg)}</td><td class="r">${g.hasVal ? g.val : '-'}</td></tr>`,
      )
      .join('');
    tableHtml = `<div class="section-title">List of goods (By type)</div>
<table class="goods"><thead><tr>
  <th>#</th><th>Type</th><th class="mat">Material</th><th class="r">HS / tariff code</th>
  <th class="r">Qty</th><th class="r">Weight</th><th class="r">Value (${esc(cur)})</th>
</tr></thead><tbody>${rows || `<tr><td colspan="7" style="text-align:center;padding:8px;color:#888">Nothing to list</td></tr>`}</tbody>
<tfoot><tr>
  <td colspan="2" style="text-align:right">TOTALS</td><td class="mat"></td><td></td>
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
            `<tr><td class="c">${rowNum}</td><td>${esc(v.sku || p.sku || '-')}</td><td>${titleForCustoms(p, d.fullName)} - ${esc(v.name || '')}</td><td>${forSaleLabel}</td><td>${esc(p.type || '')}</td>${materialCell(resolveMaterial(p, v))}` +
              `<td class="r">${qty}</td><td class="r">${wg ? Math.round(wg) + ' g' : '-'}</td><td class="r">${fmtWeightKg(weightKg)}</td><td class="r">${price != null ? price : '-'}</td><td class="r">${value != null ? value : '-'}</td><td class="r">${esc(p.tariffNo || '-')}</td><td class="c">${origin}</td></tr>`,
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
        const titleDisplay = listedVariants ? `${titleForCustoms(p, d.fullName)} (${listedVariants} variant${listedVariants === 1 ? '' : 's'})` : titleForCustoms(p, d.fullName);
        rowsArr.push(
          `<tr><td class="c">${rowNum}</td><td>${esc(p.sku || '-')}</td><td>${titleDisplay}</td><td>${forSaleLabel}</td><td>${esc(p.type || '')}</td>${materialCell(p.material)}` +
            `<td class="r">${qty}</td><td class="r">${c.effectiveUnitWeightG ? Math.round(c.effectiveUnitWeightG) + ' g' : '-'}</td><td class="r">${fmtWeightKg(weightKg)}</td><td class="r">${c.effectiveUnitPrice != null ? c.effectiveUnitPrice : '-'}</td><td class="r">${value != null ? value : '-'}</td><td class="r">${esc(p.tariffNo || '-')}</td><td class="c">${origin}</td></tr>`,
        );
      }
    }

    const formatLabel = format === 'detailed' ? 'Detailed' : 'Compressed';
    tableHtml = `<div class="section-title">List of goods (${formatLabel})</div>
<table class="goods"><thead><tr>
  <th>#</th><th>SKU</th><th>Title</th><th>For sale</th><th>Type</th><th class="mat">Material</th>
  <th class="r">Qty</th><th class="r">Unit weight</th><th class="r">Total weight</th>
  <th class="r">Unit value (${esc(cur)})</th><th class="r">Total value (${esc(cur)})</th>
  <th class="r">HS / tariff code</th><th class="c">Origin</th>
</tr></thead><tbody>${rowsArr.join('') || `<tr><td colspan="13" style="text-align:center;padding:8px;color:#888">Nothing to list</td></tr>`}</tbody>
<tfoot><tr>
  <td colspan="5" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totQty}</td><td></td>
  <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
  <td class="r">${hasVal ? Math.floor(totVal) : '-'}</td>
  <td colspan="2"></td>
</tr></tfoot></table>`;
  }

  const header = `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">${esc(title)}</div>
    <div class="doc-subtitle">${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${esc(m.event || '')}</div>
    <div class="lrp">EORI: ${esc(m.eori || '-')}</div>
    ${m.lrn ? `<div class="lrp">LRN: ${esc(m.lrn)}</div>` : ''}
    ${m.exportMrn ? `<div class="lrp">MRN: ${esc(m.exportMrn)}</div>` : ''}
  </div>
</div>
<table class="info-table">
  <tr><td class="lbl">Company Name</td><td>${esc(d.companyName || '')}</td>
      <td class="lbl">Name &amp; Surname</td><td>${esc(d.fullName || '')}</td></tr>
  <tr><td class="lbl">Street &amp; House Number</td><td>${esc(d.street || '')}</td>
      <td class="lbl">Postcode &amp; City</td><td>${esc(d.postCodeCity || '')}</td></tr>
  <tr><td class="lbl">Country of Origin</td><td>${esc(d.countryOfOrigin || '')}</td>
      <td class="lbl">Phone / Mobile</td><td>${esc(d.phone || '')}</td></tr>
  <tr><td class="lbl">Email</td><td>${esc(d.email || '')}</td>
      <td class="lbl">Precheck Office</td><td>${esc(m.precheckOffice || '-')}</td></tr>
</table>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(title)} - ${esc(m.event || '')}</title>
<style>${CSS}</style></head><body>
${header}
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

<div class="signature-section"><strong>Date and Signature</strong><div class="signature-box"></div></div>
</body></html>`;

  return html;
}
