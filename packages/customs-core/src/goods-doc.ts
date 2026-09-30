/**
 * Shared scaffolding for the "goods table" document family (packing lists,
 * sold/return lists) - CSS, the doc-top/info-table declarant header, the
 * table skeleton (thead/tbody/tfoot + empty-state row), and the outer
 * printable-document wrapper. Column sets and row-aggregation logic stay in
 * each country module - they genuinely differ (Sold vs Return vs by-type)
 * and that's exactly where duplicated logic drifted into real bugs before;
 * this file only removes the surrounding scaffolding that was byte-identical
 * (or near-identical, modulo a documented config flag) across files.
 *
 * customs-ch's goods-list.ts (Sold/Return, all formats) is golden-tested
 * byte-for-byte against the legacy tool - every function here is a straight
 * relocation of that file's own exact current text, parameterized so each
 * caller's config reproduces its own current output unchanged. The golden
 * test only checks the final string, never where the code that built it
 * lives, so this refactor cannot fail it as long as each call site's config
 * matches what it already emits today.
 */

// ── Cell/label helpers ───────────────────────────────────────────────────────

interface TitleableProduct {
  title?: string;
  type?: string;
  year?: number;
}

/**
 * Customs line name - art prints read as "Title (Year) - Artist". Byte-
 * identical across customs-ch's goods-list.ts/packing-list.ts and
 * customs-de's packing-list.ts before this consolidation (each had its own
 * copy, one commented "Mirrors goods-list.ts's titleForCustoms()").
 */
export function titleForCustoms(esc: (v: unknown) => string, isArtwork: (type: string | undefined) => boolean, p: TitleableProduct, artistName?: string): string {
  const t = esc(p.title || '');
  if (isArtwork(p.type)) {
    const base = p.year ? `${t} (${p.year})` : t;
    const artist = (artistName ?? '').trim();
    return artist ? `${base} - ${esc(artist)}` : base;
  }
  return t;
}

/** A variant's own material override, falling back to the product's. */
export function resolveMaterial(p: { material?: string }, v?: { material?: string }): string | undefined {
  return v?.material ?? p.material;
}

/**
 * The Material column's cell. A `mat` class marks it - customs-ch's golden
 * test strips anything with this class before diffing against legacy (which
 * has no material column at all), so this column is free to exist/move/be
 * removed without touching the byte-locked parts of any golden-tested file.
 */
export function materialCell(esc: (v: unknown) => string, material: string | undefined): string {
  return `<td class="mat">${esc(material || '')}</td>`;
}

/**
 * By-type group label. A group with only one product in it is named by that
 * product instead of its shared type. `dataTypeAttr` emits a `data-type`
 * attribute on the single-product case - only customs-ch's goods-list.ts
 * needs this (its golden test's normalizeByTypeGroupName() reads it to swap
 * the name back to the type before diffing against legacy, which always
 * showed the type). Every other caller leaves it off, matching their own
 * current (attribute-free) output.
 */
export function byTypeGroupName<P>(
  esc: (v: unknown) => string,
  titleFor: (p: P, artistName?: string) => string,
  g: { type: string; products: Set<P> },
  artistName: string | undefined,
  opts: { dataTypeAttr?: boolean } = {},
): string {
  const typeEsc = esc(g.type);
  if (g.products.size === 1) {
    const attr = opts.dataTypeAttr ? ` data-type="${typeEsc}"` : '';
    return `<strong${attr}>${titleFor([...g.products][0]!, artistName)}</strong>`;
  }
  return `<strong>${typeEsc}</strong>`;
}

// ── CSS ──────────────────────────────────────────────────────────────────────

export interface GoodsDocCssOptions {
  /** `.mono` rule - customs-ch's goods-list.ts and packing-list.ts. */
  mono?: boolean;
  /** `.sold-head`/`td.sold-first` rules - customs-ch's goods-list.ts only. */
  soldHead?: boolean;
  /** `.total-box` rules - both countries' packing-list.ts, not goods-list.ts. */
  totalBox?: boolean;
  /** `.notice` rule - customs-de's packing-list.ts only. */
  notice?: boolean;
}

/**
 * The CSS block shared by customs-ch's goods-list.ts/packing-list.ts and
 * customs-de's packing-list.ts - identical through the `.r`/`.c` rule in all
 * three, then each adds only the rules its own document actually uses. Each
 * existing caller's flags reproduce its own current exact CSS text.
 */
export function goodsDocCss(opts: GoodsDocCssOptions = {}): string {
  return `
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
  .r { text-align: right; } .c { text-align: center; }${opts.mono ? `
  .mono { font-family: 'Courier New', monospace; font-size: 6.5pt; }` : ''}${opts.soldHead ? `
  .sold-head { border-left: 2px solid #666 !important; }
  td.sold-first { border-left: 2px solid #888; }` : ''}${opts.totalBox ? `
  .total-box { border: 2px solid #000; display: inline-block; padding: 4mm 8mm; margin: 4mm 0; }
  .total-box .total-label { font-size: 8pt; text-transform: uppercase; color: #555; }
  .total-box .total-value { font-size: 14pt; font-weight: bold; }` : ''}${opts.notice ? `
  .notice { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; margin-top: 4mm; line-height: 1.6; }` : ''}
  .signature-section { margin-top: 8mm; }
  .signature-box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;
}

// ── Document header (doc-top + declarant info-table) ────────────────────────

export interface DocHeaderPairRow {
  label1: string;
  value1: string;
  label2: string;
  value2: string;
}

export interface DocHeaderSpanRow {
  label: string;
  value: string;
  colspan: number;
}

export type DocHeaderRow = DocHeaderPairRow | DocHeaderSpanRow;

export interface DocHeaderConfig {
  /** Already-escaped document title. */
  docTitleHtml: string;
  /** Already-built (and escaped) subtitle - typically event dates + location. */
  subtitleHtml: string;
  /** Already-escaped event name. */
  eventNameHtml: string;
  /** Pre-built corner lines (e.g. "LRP: X", "EORI: X") - each wrapped in its own `.lrp` div. */
  cornerLinesHtml: string[];
  /** Declarant info-table rows, values already escaped. */
  infoRows: DocHeaderRow[];
}

/**
 * The `doc-top` + `info-table` declarant block - byte-identical shape across
 * customs-ch's goods-list.ts/packing-list.ts and customs-de's packing-list.ts,
 * differing only in which corner lines and info-table rows each supplies
 * (e.g. customs-de's extra Precheck Office field, or its variable-length
 * EORI/LRN/MRN corner lines vs. customs-ch's single LRP line).
 */
export function buildDocHeaderHtml(cfg: DocHeaderConfig): string {
  const cornerHtml = cfg.cornerLinesHtml.map((l) => `<div class="lrp">${l}</div>`).join('\n    ');
  const rowsHtml = cfg.infoRows
    .map((r) =>
      'colspan' in r
        ? `<tr><td class="lbl">${r.label}</td><td colspan="${r.colspan}">${r.value}</td></tr>`
        : `<tr><td class="lbl">${r.label1}</td><td>${r.value1}</td>\n      <td class="lbl">${r.label2}</td><td>${r.value2}</td></tr>`,
    )
    .join('\n  ');
  return `<div class="doc-top">
  <div class="doc-top-left">
    <div class="doc-title">${cfg.docTitleHtml}</div>
    <div class="doc-subtitle">${cfg.subtitleHtml}</div>
  </div>
  <div class="doc-top-right">
    <div class="event-name">${cfg.eventNameHtml}</div>
    ${cornerHtml}
  </div>
</div>
<table class="info-table">
  ${rowsHtml}
</table>`;
}

// ── Table skeleton ───────────────────────────────────────────────────────────

export interface GoodsTableConfig {
  /** Already-built section-title text (including any "(Detailed)"/"(By Type)" suffix). */
  sectionTitle: string;
  /** Inner `<tr>...</tr>` content for `<thead>` - the header `<th>` cells, built by the caller. */
  theadRowHtml: string;
  /** Joined `<tr>` strings for `<tbody>`, built by the caller - '' when there are no rows. */
  bodyRowsHtml: string;
  emptyColspan: number;
  emptyMessage: string;
  /** Inner `<tr>...</tr>` content for `<tfoot>` - the totals cells, built by the caller. */
  tfootRowHtml: string;
}

/**
 * The `<div class="section-title">` + `<table class="goods">` wrapper,
 * including the empty-state row. Column sets, aggregation, and rounding stay
 * with the caller (thead/tbody/tfoot content) - that's the part that
 * genuinely differs per document and per country, and where duplicated logic
 * has actually drifted into bugs before.
 */
export function buildGoodsTableHtml(cfg: GoodsTableConfig): string {
  const body = cfg.bodyRowsHtml || `<tr><td colspan="${cfg.emptyColspan}" style="text-align:center;color:#888;padding:8px">${cfg.emptyMessage}</td></tr>`;
  return `<div class="section-title">${cfg.sectionTitle}</div>
<table class="goods"><thead><tr>
${cfg.theadRowHtml}
</tr></thead><tbody>${body}</tbody><tfoot><tr>
${cfg.tfootRowHtml}
</tr></tfoot></table>`;
}

// ── Outer document wrapper ───────────────────────────────────────────────────

export interface PrintableDocumentConfig {
  titleHtml: string;
  css: string;
  /** The full assembled body content (header + table + any extra blocks + signature section), no leading/trailing newline. */
  bodyHtml: string;
}

export function buildPrintableDocumentHtml(cfg: PrintableDocumentConfig): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${cfg.titleHtml}</title>
<style>${cfg.css}</style></head><body>
${cfg.bodyHtml}
</body></html>`;
}

export function buildSignatureSectionHtml(label: string = 'Date and Signature'): string {
  return `<div class="signature-section"><strong>${label}</strong><div class="signature-box"></div></div>`;
}
