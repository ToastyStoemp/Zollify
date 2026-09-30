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
import {
  buildDocHeaderHtml,
  buildGoodsTableHtml,
  buildPrintableDocumentHtml,
  buildSignatureSectionHtml,
  byTypeGroupName as coreByTypeGroupName,
  goodsDocCss,
  materialCell as coreMaterialCell,
  resolveMaterial as coreResolveMaterial,
  titleForCustoms as coreTitleForCustoms,
} from '@zollify/customs-core';
import { calcDeProduct, calcDeProductByMaterial, esc, fmtEventDates, floorN, formatNum, fmtWeightKg, hasVariants } from './calc';
import type { CustomsDeProduct, CustomsDeState, CustomsDeVariant } from './model';
import { isArtwork } from '../lib/artwork';

export type PackingListKind = 'export' | 'sold' | 'reimport';
export type PackingListFormat = 'detailed' | 'compressed' | 'bytype';

/**
 * By-type group label. Material and HS code both have their own column on
 * this table, so neither is repeated here. A group with only one product in
 * it is more useful named by that product than by its shared type. Mirrors
 * customs-ch/engine/goods-list.ts's byTypeGroupName().
 */
function byTypeGroupName(g: { type: string; products: Set<CustomsDeProduct> }, artistName?: string): string {
  return coreByTypeGroupName(esc, titleForCustoms, g, artistName);
}

/**
 * Customs line name - an item is only as identifiable as its title, and two
 * booths' "Sunset" print aren't the same thing. Art prints read as
 * "Title (Year) - Artist". Mirrors customs-ch/engine/goods-list.ts's
 * titleForCustoms().
 */
function titleForCustoms(p: CustomsDeProduct, artistName?: string): string {
  return coreTitleForCustoms(esc, isArtwork, p, artistName);
}

/** A variant's own material override, falling back to the product's. Mirrors customs-ch/engine/goods-list.ts's resolveMaterial(). */
function resolveMaterial(p: CustomsDeProduct, v: CustomsDeVariant): string {
  return coreResolveMaterial(p, v) || '';
}

function materialCell(material?: string): string {
  return coreMaterialCell(esc, material);
}

export function buildPackingListHtml(state: CustomsDeState, kind: PackingListKind, format: PackingListFormat = 'detailed', now: Date = new Date()): string {
  const m = state.meta;
  const d = state.declarant;
  const cur = m.currency || 'EUR';
  const products = state.products.filter((p) => !p.unlisted);
  const title =
    kind === 'export' ? 'Export packing list' : kind === 'sold' ? 'Sold goods list (definitive export)' : 'Re-import packing list (unsold goods)';

  const CSS = goodsDocCss({ totalBox: true, notice: true });

  // 'sold' is the definitive-export declaration - the one document customs-ch
  // has a direct counterpart for (goods-list.ts docNum 2). Its columns mirror
  // that one exactly (Title/Type/Material/Tariff/Qty/Value/Weight, no SKU,
  // For sale, unit weight/price, or Origin) so the two only differ by
  // currency, not layout. Export/reimport have no CH counterpart to match
  // and keep their own fuller column set (SKU/Origin/unit figures matter
  // there for cross-referencing the temporary-export declaration).
  const isSold = kind === 'sold';

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
    const groups = new Map<string, { type: string; tariffNo: string; material: string; qty: number; wkg: number; val: number; hasVal: boolean; products: Set<CustomsDeProduct> }>();
    for (const p of products) {
      for (const mc of calcDeProductByMaterial(p)) {
        const qty = kind === 'export' ? mc.amount : kind === 'sold' ? mc.soldQty : mc.reimportQty;
        if (qty <= 0) continue;
        const wkg = kind === 'export' ? mc.totalWeightKg : kind === 'sold' ? mc.soldWeightKg : mc.reimportWeightKg;
        // floorN before summing, not just at render time - a discount-adjusted
        // soldValue can land on something like 464.90999999999997, and that
        // needs settling before it's added into a running total too, not just
        // where it's printed.
        const valRaw = kind === 'export' ? mc.totalValue : kind === 'sold' ? mc.soldValue : mc.reimportValue;
        const val = valRaw != null ? floorN(valRaw, 2) : null;
        const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}\x00${mc.material}`;
        const g = groups.get(key) ?? { type: p.type || 'Other', tariffNo: p.tariffNo || '', material: mc.material, qty: 0, wkg: 0, val: 0, hasVal: false, products: new Set() };
        g.qty += qty;
        g.wkg += wkg;
        if (val != null) {
          g.val += val;
          g.hasVal = true;
        }
        g.products.add(p);
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
      .map((g, i) =>
        isSold
          ? `<tr><td class="c">${i + 1}</td><td>${byTypeGroupName(g, d.fullName)}</td>${materialCell(g.material)}<td class="r">${esc(g.tariffNo || '-')}</td><td class="r">${g.qty}</td><td class="r">${g.hasVal ? formatNum(floorN(g.val, 2), 2) : '-'}</td><td class="r">${fmtWeightKg(g.wkg)}</td></tr>`
          : `<tr><td class="c">${i + 1}</td><td>${byTypeGroupName(g, d.fullName)}</td>${materialCell(g.material)}<td class="r">${esc(g.tariffNo || '-')}</td><td class="r">${g.qty}</td><td class="r">${fmtWeightKg(g.wkg)}</td><td class="r">${g.hasVal ? formatNum(floorN(g.val, 2), 2) : '-'}</td></tr>`,
      )
      .join('');
    tableHtml = isSold
      ? buildGoodsTableHtml({
          sectionTitle: 'List of goods (By type)',
          theadRowHtml: `  <th>#</th><th>Type</th><th class="mat">Material</th><th class="r">Tariff no.</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${esc(cur)})</th><th class="r">Sold Weight</th>`,
          bodyRowsHtml: rows,
          emptyColspan: 7,
          emptyMessage: 'Nothing to list',
          tfootRowHtml: `  <td colspan="2" style="text-align:right">TOTALS</td><td class="mat"></td><td></td>
  <td class="r">${totQty}</td>
  <td class="r">${hasVal ? formatNum(floorN(totVal, 2), 2) : '-'}</td>
  <td class="r">${fmtWeightKg(totWkg)}</td>`,
        })
      : buildGoodsTableHtml({
          sectionTitle: 'List of goods (By type)',
          theadRowHtml: `  <th>#</th><th>Type</th><th class="mat">Material</th><th class="r">HS / tariff code</th>
  <th class="r">Qty</th><th class="r">Weight</th><th class="r">Value (${esc(cur)})</th>`,
          bodyRowsHtml: rows,
          emptyColspan: 7,
          emptyMessage: 'Nothing to list',
          tfootRowHtml: `  <td colspan="2" style="text-align:right">TOTALS</td><td class="mat"></td><td></td>
  <td class="r">${totQty}</td>
  <td class="r">${fmtWeightKg(totWkg)}</td>
  <td class="r">${hasVal ? formatNum(floorN(totVal, 2), 2) : '-'}</td>`,
        });
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
          const qty = kind === 'export' ? vAmount : kind === 'sold' ? v.soldQty || 0 : Math.max(0, vAmount - (v.soldQty || 0));
          if (qty <= 0) continue;
          const wgRaw = v.weightG != null && v.weightG !== '' ? v.weightG : p.weightG;
          const wg = parseFloat(String(wgRaw ?? '')) || 0;
          const priceRaw = v.price != null && v.price !== '' ? v.price : p.price;
          const price = priceRaw != null && priceRaw !== '' ? parseFloat(String(priceRaw)) : null;
          const weightKg = Math.round(qty * wg) / 1000;
          // For 'sold', the variant's own soldValue (already net of any
          // discount) - not price * qty, which is the undiscounted catalog
          // price and was silently showing the wrong total for every variant
          // row (calcDeProduct/calcDeProductByMaterial get this right further
          // down; this per-variant "detailed" row never routed through them).
          // floorN either way - a discount-adjusted soldValue can land on
          // something like 464.90999999999997, and that needs settling before
          // it's summed into the running total too, not just where it's printed.
          const valueRaw = kind === 'sold' ? v.soldValue || 0 : price != null ? Math.round(price * qty) : null;
          const value = valueRaw != null ? floorN(valueRaw, 2) : null;
          totQty += qty;
          totWkg += weightKg;
          if (value != null) {
            totVal += value;
            hasVal = true;
          }
          rowNum++;
          rowsArr.push(
            isSold
              ? `<tr><td class="c">${rowNum}</td><td>${titleForCustoms(p, d.fullName)} - ${esc(v.name || '')}</td><td>${esc(p.type || '')}</td>${materialCell(resolveMaterial(p, v))}` +
                  `<td class="r">${esc(p.tariffNo || '-')}</td><td class="r">${qty}</td><td class="r">${value != null ? formatNum(value, 2) : '-'}</td><td class="r">${fmtWeightKg(weightKg)}</td></tr>`
              : `<tr><td class="c">${rowNum}</td><td>${esc(v.sku || p.sku || '-')}</td><td>${titleForCustoms(p, d.fullName)} - ${esc(v.name || '')}</td><td>${forSaleLabel}</td><td>${esc(p.type || '')}</td>${materialCell(resolveMaterial(p, v))}` +
                  `<td class="r">${qty}</td><td class="r">${wg ? Math.round(wg) + ' g' : '-'}</td><td class="r">${fmtWeightKg(weightKg)}</td><td class="r">${price != null ? price : '-'}</td><td class="r">${value != null ? formatNum(value, 2) : '-'}</td><td class="r">${esc(p.tariffNo || '-')}</td><td class="c">${origin}</td></tr>`,
          );
        }
      } else {
        const c = calcDeProduct(p);
        const qty = kind === 'export' ? c.amount : kind === 'sold' ? c.soldQty : c.reimportQty;
        if (qty <= 0) continue;
        const weightKg = kind === 'export' ? c.totalWeightKg : kind === 'sold' ? c.soldWeightKg : c.reimportWeightKg;
        const valueRaw = kind === 'export' ? c.totalValue : kind === 'sold' ? c.soldValue : c.reimportValue;
        const value = valueRaw != null ? floorN(valueRaw, 2) : null;
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
          isSold
            ? `<tr><td class="c">${rowNum}</td><td>${titleDisplay}</td><td>${esc(p.type || '')}</td>${materialCell(p.material)}` +
                `<td class="r">${esc(p.tariffNo || '-')}</td><td class="r">${qty}</td><td class="r">${value != null ? formatNum(value, 2) : '-'}</td><td class="r">${fmtWeightKg(weightKg)}</td></tr>`
            : `<tr><td class="c">${rowNum}</td><td>${esc(p.sku || '-')}</td><td>${titleDisplay}</td><td>${forSaleLabel}</td><td>${esc(p.type || '')}</td>${materialCell(p.material)}` +
                `<td class="r">${qty}</td><td class="r">${c.effectiveUnitWeightG ? Math.round(c.effectiveUnitWeightG) + ' g' : '-'}</td><td class="r">${fmtWeightKg(weightKg)}</td><td class="r">${c.effectiveUnitPrice != null ? c.effectiveUnitPrice : '-'}</td><td class="r">${value != null ? formatNum(value, 2) : '-'}</td><td class="r">${esc(p.tariffNo || '-')}</td><td class="c">${origin}</td></tr>`,
        );
      }
    }

    const formatLabel = format === 'detailed' ? 'Detailed' : 'Compressed';
    tableHtml = isSold
      ? buildGoodsTableHtml({
          sectionTitle: `List of goods sold${format === 'detailed' ? ' (Detailed)' : ' (Compressed)'}`,
          theadRowHtml: `  <th>#</th><th>Title</th><th>Type</th><th class="mat">Material</th>
  <th class="r">Tariff no.</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${esc(cur)})</th><th class="r">Sold Weight</th>`,
          bodyRowsHtml: rowsArr.join(''),
          emptyColspan: 8,
          emptyMessage: 'Nothing to list',
          tfootRowHtml: `  <td colspan="4" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totQty}</td>
  <td class="r">${hasVal ? formatNum(floorN(totVal, 2), 2) : '-'}</td>
  <td class="r">${fmtWeightKg(totWkg)}</td>`,
        })
      : buildGoodsTableHtml({
          sectionTitle: `List of goods (${formatLabel})`,
          theadRowHtml: `  <th>#</th><th>SKU</th><th>Title</th><th>For sale</th><th>Type</th><th class="mat">Material</th>
  <th class="r">Qty</th><th class="r">Unit weight</th><th class="r">Total weight</th>
  <th class="r">Unit value (${esc(cur)})</th><th class="r">Total value (${esc(cur)})</th>
  <th class="r">HS / tariff code</th><th class="c">Origin</th>`,
          bodyRowsHtml: rowsArr.join(''),
          emptyColspan: 13,
          emptyMessage: 'Nothing to list',
          tfootRowHtml: `  <td colspan="5" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totQty}</td><td></td>
  <td class="r">${fmtWeightKg(totWkg)}</td><td></td>
  <td class="r">${hasVal ? formatNum(floorN(totVal, 2), 2) : '-'}</td>
  <td colspan="2"></td>`,
        });
  }

  const header = buildDocHeaderHtml({
    docTitleHtml: esc(title),
    subtitleHtml: `${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}`,
    eventNameHtml: esc(m.event || ''),
    cornerLinesHtml: [`EORI: ${esc(m.eori || '-')}`, ...(m.lrn ? [`LRN: ${esc(m.lrn)}`] : []), ...(m.exportMrn ? [`MRN: ${esc(m.exportMrn)}`] : [])],
    infoRows: [
      { label1: 'Company Name', value1: esc(d.companyName || ''), label2: 'Name &amp; Surname', value2: esc(d.fullName || '') },
      { label1: 'Street &amp; House Number', value1: esc(d.street || ''), label2: 'Postcode &amp; City', value2: esc(d.postCodeCity || '') },
      { label1: 'Country of Origin', value1: esc(d.countryOfOrigin || ''), label2: 'Phone / Mobile', value2: esc(d.phone || '') },
      { label1: 'Email', value1: esc(d.email || ''), label2: 'Precheck Office', value2: esc(m.precheckOffice || '-') },
    ],
  });

  const html = buildPrintableDocumentHtml({
    titleHtml: `${esc(title)} - ${esc(m.event || '')}`,
    css: CSS,
    bodyHtml: `${header}
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
      : kind === 'sold'
        ? `Quantities actually sold at ${esc(m.event || 'the event')} - the definitive-export goods, not coming back to Germany. ${m.exportMrn ? `References export MRN ${esc(m.exportMrn)}.` : 'Record the export MRN under Customs (Germany) → Declaration details once known, so it can be referenced here.'}`
        : `Quantities not sold at ${esc(m.event || 'the event')}, returning to Germany. ${m.exportMrn ? `References export MRN ${esc(m.exportMrn)}.` : 'Record the export MRN under Customs (Germany) → Declaration details once known, so it can be referenced here.'}`
  }
</div>

${buildSignatureSectionHtml()}`,
  });

  return html;
}
