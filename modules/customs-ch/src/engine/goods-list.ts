/**
 * Goods-list documents (Sold / Return) - exact ports of legacy
 * printGoodsList() and printAllVersions() minus the window.open call.
 * The two legacy functions build the tables independently with small
 * differences; both are preserved verbatim (golden-tested).
 *
 * The former docNum 1 ("Import") was replaced by packing-list.ts - a
 * dedicated, simpler document without Tariff Rate/VAT Rate columns, mirroring
 * customs-de's own packing list. Sold/Return keep their tariffRate/vatRate
 * columns; those weren't part of this change.
 *
 * CSS, the declarant header block, and the table skeleton (thead/tbody/tfoot
 * + empty-state row) now come from @zollify/customs-core's goods-doc.ts,
 * shared with customs-ch's own packing-list.ts and customs-de's
 * packing-list.ts - each a straight relocation of this file's own exact
 * text, so the golden test below is unaffected (it only checks the final
 * string, never where the code producing it lives). Column sets and row
 * aggregation stay here - the golden-locked, genuinely CH-specific part.
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
import {
  calcProduct,
  calcProductByMaterial,
  calcReturnStats,
  calcReturnStatsByMaterial,
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
import type { CustomsProduct, CustomsState } from './model';
import { isArtwork } from '../lib/artwork';

export type GoodsDocNum = 2 | 3;

/**
 * Customs line name. Art prints read as "Title (Year) - Artist" (the artist's
 * full name attributes the work on the declaration); material has its own
 * column now (materialCell() below), not folded in here.
 */
function titleForCustoms(p: { title?: string; type?: string; year?: number }, artistName?: string): string {
  return coreTitleForCustoms(esc, isArtwork, p, artistName);
}

/** A variant's own material overrides the product's when set. */
export function resolveMaterial(p: { material?: string }, v?: { material?: string }): string | undefined {
  return coreResolveMaterial(p, v);
}

/**
 * The Material column's cell. A `mat` class marks it (not styling - the
 * golden-legacy test strips anything with this class from the ported HTML
 * before diffing against legacy, since legacy has no material column at all
 * to compare against; every OTHER cell still has to match byte-for-byte).
 */
export function materialCell(material: string | undefined): string {
  return coreMaterialCell(esc, material);
}

/** Name for the Sold / Return lists: art prints gain the year + artist, matching the Import list. */
function soldReturnName(p: { title?: string; type?: string; year?: number }, artistName?: string): string {
  return titleForCustoms(p, artistName);
}

/**
 * By-type group label, wrapped in its own <strong>. HS code and Material both
 * have their own column now, so this is just the name. A group with only one
 * product in it is more useful named by that product than by its shared type
 * - its cell carries a data-type attribute so the golden test can tell what
 * type it stood in for (see golden-legacy.test.ts's normalizeByTypeGroupName).
 */
export function byTypeGroupName(g: { type: string; products: Set<CustomsProduct> }, artistName?: string): string {
  return coreByTypeGroupName(esc, titleForCustoms, g, artistName, { dataTypeAttr: true });
}
export type GoodsFormat = 'detailed' | 'compressed' | 'bytype';

const DOC_TITLES: Record<number, string> = {
  2: 'Auxiliary Document for the Customs Declaration - Sold Goods',
  3: 'Return Goods List - Re-export Declaration',
};

function getCurrency(state: CustomsState): string {
  return state.meta && state.meta.currency ? state.meta.currency : 'CHF';
}

/** Full printable HTML document - port of printGoodsList(). */
export function buildGoodsListHtml(state: CustomsState, docNum: GoodsDocNum, format: GoodsFormat = 'detailed'): string {
  const m = state.meta;
  const a = state.artist;
  const lrp = computeLRP(state, docNum);

  const docTitles = DOC_TITLES;

  const CSS = goodsDocCss({ mono: true, soldHead: true });

  const header = buildDocHeaderHtml({
    docTitleHtml: esc(docTitles[docNum]),
    subtitleHtml: `${esc(fmtEventDates(m.eventDateStart, m.eventDateEnd))}${m.eventLocation ? ', ' + esc(m.eventLocation) : ''}`,
    eventNameHtml: esc(m.event || ''),
    cornerLinesHtml: [`LRP: ${esc(lrp || '-')}`],
    infoRows: [
      { label1: 'Artist / Company Name', value1: esc(a.companyName || ''), label2: 'Name &amp; Surname', value2: esc(a.fullName || '') },
      { label1: 'Street &amp; House Number', value1: esc(a.street || ''), label2: 'Postcode &amp; City', value2: esc(a.postCodeCity || '') },
      { label1: 'Country of Origin', value1: esc(a.countryOfOrigin || ''), label2: 'Phone / Mobile', value2: esc(a.phone || '') },
      { label: 'Email', value: esc(a.email || ''), colspan: 3 },
    ],
  });

  let tableHtml = '';

  if (docNum === 2) {
    // ── SOLD: only sold goods ──
    let totSQ = 0,
      totSV = 0,
      totSWkg = 0;
    let rowNum = 0;

    const detailedRows: string[] = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code + material (none of the three are
      // ever combined across groups, so a group's material is never ambiguous)
      const groups: Record<
        string,
        {
          type: string;
          tariffNo: string;
          material: string;
          tariffRate: unknown;
          vatRate: unknown;
          soldQty: number;
          soldVal: number;
          soldWkg: number;
          products: Set<CustomsProduct>;
        }
      > = {};
      state.products.forEach((p) => {
        if (!hasCustomsInfo(p)) return;
        for (const mc of calcProductByMaterial(p)) {
          if (!(mc.soldQty > 0)) continue;
          const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}\x00${mc.material}`;
          if (!groups[key])
            groups[key] = {
              type: p.type || 'Other',
              tariffNo: p.tariffNo || '',
              material: mc.material,
              tariffRate: p.tariffRate,
              vatRate: p.vatRate,
              soldQty: 0,
              soldVal: 0,
              soldWkg: 0,
              products: new Set(),
            };
          const g = groups[key];
          g.soldQty += mc.soldQty;
          g.soldVal += floorN(mc.soldValue, 2);
          g.soldWkg += mc.soldWeightKg;
          g.products.add(p);
          totSQ += mc.soldQty;
          totSV += floorN(mc.soldValue, 2);
          totSWkg += mc.soldWeightKg;
        }
      });
      const groupList = Object.values(groups);
      groupList.forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i + 1}</td><td>${byTypeGroupName(g, a.fullName)}</td>
          ${materialCell(g.material)}
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r">${g.soldQty}</td>
          <td class="r">${formatNum(floorN(g.soldVal, 2), 2)}</td>
          <td class="r">${fmtWeightKg(g.soldWkg)}</td></tr>`);
      });
      tableHtml = buildGoodsTableHtml({
        sectionTitle: 'List of goods sold (By Type)',
        theadRowHtml: `  <th>#</th><th>Type</th><th class="mat">Material</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${getCurrency(state)})</th>
  <th class="r">Sold Weight</th>`,
        bodyRowsHtml: detailedRows.join(''),
        emptyColspan: 9,
        emptyMessage: 'No sold quantities entered',
        tfootRowHtml: `  <td colspan="5" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totSQ}</td>
  <td class="r">${formatNum(floorN(totSV, 2), 2)}</td>
  <td class="r">${fmtWeightKg(totSWkg)}</td>`,
      });
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
              ${materialCell(resolveMaterial(p, v))}
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
            ${materialCell(p.material)}
            <td class="r">${esc(p.tariffNo || '')}</td>
            <td class="r">${c.soldQty || 0}</td>
            <td class="r">${formatNum(rowSV, 2)}</td>
            <td class="r">${fmtWeightKg(c.soldWeightKg)}</td></tr>`);
        }
      });

      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = buildGoodsTableHtml({
        sectionTitle: `List of goods sold${formatLabel}`,
        theadRowHtml: `  <th>#</th><th>Title</th><th>Type</th><th class="mat">Material</th>
  <th class="r">Tariff no.</th>
  <th class="r">Qty Sold</th><th class="r">Value Sold (${getCurrency(state)})</th>
  <th class="r">Sold Weight</th>`,
        bodyRowsHtml: detailedRows.join(''),
        emptyColspan: 8,
        emptyMessage: 'No sold quantities entered',
        tfootRowHtml: `  <td colspan="4" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r">${totSQ}</td>
  <td class="r">${formatNum(floorN(totSV, 2), 2)}</td>
  <td class="r">${fmtWeightKg(totSWkg)}</td>`,
      });
    }
  } else {
    // ── EXPORT/RETURN: unsold items going back (original qty − sold qty) ──
    let totRetQty = 0,
      totRetWkg = 0,
      totRetVal = 0;
    let rowNum = 0;

    const detailedRows: string[] = [];

    if (format === 'bytype') {
      // By-type: group by type + tariff code + material (none of the three are
      // ever combined across groups, so a group's material is never ambiguous)
      const groups: Record<
        string,
        {
          type: string;
          tariffNo: string;
          material: string;
          tariffRate: unknown;
          vatRate: unknown;
          retQty: number;
          retWkg: number;
          retVal: number;
          hasVal: boolean;
          products: Set<CustomsProduct>;
        }
      > = {};
      state.products.forEach((p) => {
        if (!hasCustomsInfo(p)) return;
        for (const mc of calcReturnStatsByMaterial(p)) {
          const key = `${p.type || 'Other'}\x00${p.tariffNo || ''}\x00${mc.material}`;
          if (!groups[key])
            groups[key] = {
              type: p.type || 'Other',
              tariffNo: p.tariffNo || '',
              material: mc.material,
              tariffRate: p.tariffRate,
              vatRate: p.vatRate,
              retQty: 0,
              retWkg: 0,
              retVal: 0,
              hasVal: false,
              products: new Set(),
            };
          const g = groups[key];
          g.retQty += mc.retQty;
          g.retWkg += mc.retWkg;
          if (mc.retVal != null) {
            g.retVal += mc.retVal;
            g.hasVal = true;
          }
          g.products.add(p);
          totRetQty += mc.retQty;
          totRetWkg += mc.retWkg;
          if (mc.retVal != null) totRetVal += mc.retVal;
        }
      });
      const groupList = Object.values(groups);
      groupList.forEach((g, i) => {
        detailedRows.push(`<tr>
          <td class="c">${i + 1}</td><td>${byTypeGroupName(g, a.fullName)}</td>
          ${materialCell(g.material)}
          <td class="r">${esc(g.tariffNo)}</td>
          <td class="r">${g.tariffRate != null ? g.tariffRate + '%' : ''}</td>
          <td class="r">${g.vatRate != null ? g.vatRate + '%' : ''}</td>
          <td class="r"><strong>${g.retQty}</strong></td>
          <td class="r">${fmtWeightKg(g.retWkg)}</td>
          <td class="r">${g.hasVal ? g.retVal : '-'}</td></tr>`);
      });
      tableHtml = buildGoodsTableHtml({
        sectionTitle: 'Return goods list (re-export) (By Type)',
        theadRowHtml: `  <th>#</th><th>Type</th><th class="mat">Material</th><th class="r">HS Code</th>
  <th class="r">Tariff Rate</th><th class="r">VAT Rate</th>
  <th class="r">Return Qty</th><th class="r">Return Weight</th>
  <th class="r">Return Value (${getCurrency(state)})</th>`,
        bodyRowsHtml: detailedRows.join(''),
        emptyColspan: 9,
        emptyMessage: 'All items sold - no return goods',
        tfootRowHtml: `  <td colspan="5" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r"><strong>${totRetQty}</strong></td>
  <td class="r">${fmtWeightKg(totRetWkg)}</td>
  <td class="r" style="color:#c00">${Math.floor(totRetVal)}</td>`,
      });
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
            const pd = p.priceNote || (varPrice != null ? formatNum(floorN(varPrice, 2), 2) : '-');
            const retValStr = varRetVal != null ? varRetVal : '-';
            detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${soldReturnName(p, a.fullName)} - ${esc(v.name || '')}</td><td>${esc(p.type || '')}</td>
              ${materialCell(resolveMaterial(p, v))}
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
          const pd = p.priceNote || (c.effectiveUnitPrice != null ? formatNum(floorN(c.effectiveUnitPrice, 2), 2) : '-');
          const retValStr = retVal != null ? retVal : '-';
          const titleDisplay = hasVariants(p)
            ? `${soldReturnName(p, a.fullName)} (${p.variants!.filter((v) => !v.unlisted).length} variants)`
            : soldReturnName(p, a.fullName);
          detailedRows.push(`<tr><td class="c">${rowNum}</td><td>${titleDisplay}</td><td>${esc(p.type || '')}</td>
            ${materialCell(p.material)}
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

      const formatLabel = format === 'detailed' ? ' (Detailed)' : ' (Compressed)';
      tableHtml = buildGoodsTableHtml({
        sectionTitle: `Return goods list (re-export)${formatLabel}`,
        theadRowHtml: `  <th>#</th><th>Title</th><th>Type</th><th class="mat">Material</th>
  <th class="r">Original Qty</th><th class="r">Sold Qty</th><th class="r">Return Qty</th>
  <th class="r">Unit Weight</th><th class="r">Return Weight</th>
  <th class="r">Unit Price (${getCurrency(state)})</th><th class="r">Return Value (${getCurrency(state)})</th>
  <th class="r">Tariff no.</th><th class="r">Tariff Rate</th><th class="r">VAT Rate</th><th class="c">Origin</th>`,
        bodyRowsHtml: detailedRows.join(''),
        emptyColspan: 15,
        emptyMessage: 'All items sold - no return goods',
        tfootRowHtml: `  <td colspan="5" style="text-align:right">TOTALS</td><td class="mat"></td>
  <td class="r"><strong>${totRetQty}</strong></td><td></td>
  <td class="r">${fmtWeightKg(totRetWkg)}</td><td></td>
  <td class="r" style="color:#c00">${Math.floor(totRetVal)}</td><td colspan="4"></td>`,
      });
    }
  }

  const html = buildPrintableDocumentHtml({
    titleHtml: `${esc(docTitles[docNum])} -${esc(m.event || 'ZollTool')}`,
    css: CSS,
    bodyHtml: `${header}\n${tableHtml}\n${buildSignatureSectionHtml()}`,
  });

  return html;
}
