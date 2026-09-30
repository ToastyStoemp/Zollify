/**
 * Shared scaffolding for the proforma-invoice document family - CSS, the
 * watermark/parties/meta-row/goods-table/total-box/declaration/sig-block
 * skeleton, and the outer printable-document wrapper. customs-ch's
 * proforma.ts, proforma-eu.ts, and customs-de's proforma.ts are ~90%
 * identical (same CSS family, same row/table shape, same declaration/
 * sig-block); the fields that do differ (VAT ID, EORI, Incoterms, invoice
 * number, country-code display) are EU invoicing-standard (EN 16931)
 * fields, not something unique to either country, so they're modeled as
 * plain config here rather than kept as three independent copies.
 *
 * customs-ch's plain proforma.ts is golden-tested byte-for-byte against the
 * legacy tool - every function here is a straight relocation of that file's
 * own exact current text, so its config reproduces its own current output
 * unchanged (the golden test only checks the final string, never where the
 * code that built it lives).
 */

export interface ProformaCssOptions {
  /** `.meta-row { ...flex-wrap: wrap; }` - customs-ch's proforma-eu.ts and customs-de's proforma.ts; plain customs-ch proforma.ts omits it. */
  metaRowWrap?: boolean;
  /** `.vat-note` rule - customs-ch's proforma-eu.ts and customs-de's proforma.ts; plain customs-ch proforma.ts has no VAT note at all. */
  vatNote?: boolean;
}

export function proformaDocCss(opts: ProformaCssOptions = {}): string {
  return `
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
  .meta-row { display: flex; gap: 8mm; margin-bottom: 6mm; font-size: 8pt;${opts.metaRowWrap ? ' flex-wrap: wrap;' : ''} }
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
  .total-box .total-value { font-size: 14pt; font-weight: bold; }${opts.vatNote ? `
  .vat-note { font-size: 8pt; color: #333; margin-bottom: 6mm; }` : ''}
  .declaration { font-size: 7.5pt; color: #333; border-top: 1px solid #ccc; padding-top: 4mm; margin-bottom: 6mm; line-height: 1.6; }
  .sig-block { display: inline-block; width: 100mm; }
  .sig-label { font-size: 7.5pt; color: #555; margin-bottom: 1mm; }
  .sig-line { border-top: 1px solid #000; padding-top: 2mm; font-size: 7.5pt; color: #777; margin-top: 10mm; }
  @media print { body { padding: 0; } @page { size: A4 portrait; margin: 15mm; } }`;
}

export interface ProformaConfig {
  titleHtml: string;
  css: string;
  sellerLabel: string;
  sellerName: string;
  sellerDetailHtml: string;
  buyerLabel: string;
  buyerName: string;
  buyerDetailHtml: string;
  /** Full inner content of the `.meta-row` div - one `.meta-item` per line, caller-built since the set/order of items differs per document. */
  metaRowHtml: string;
  /** The `<th>` lines for the goods table header, caller-built. */
  theadRowsHtml: string;
  bodyRowsHtml: string;
  emptyColspan: number;
  emptyMessage: string;
  /** The `<td>` lines for the goods table footer, caller-built. */
  tfootRowHtml: string;
  /** Pre-formatted (currency + locale) total value text, e.g. "CHF 1.234". */
  totalValueText: string;
  totalWeightHtml: string;
  /** Omit for no VAT-note div at all (plain customs-ch proforma.ts). */
  vatNoteHtml?: string;
  /** Full inner content of the `.declaration` div, caller-built (own wording per country). */
  declarationHtml: string;
  signatoryName: string;
}

/**
 * The proforma invoice's body (watermark through sig-block), wrapped via
 * buildPrintableDocumentHtml from ./goods-doc. Row/column content, party
 * labels, and declaration wording stay with the caller - the genuinely
 * per-document parts; this only removes the surrounding scaffolding that was
 * duplicated byte-for-byte (or near-identical, modulo the CSS flags above)
 * across all three files.
 */
export function buildProformaHtml(cfg: ProformaConfig): string {
  const bodyHtml = `<div class="watermark">For Customs Clearance Purposes Only &mdash; Not for Commercial Use</div>
<div class="doc-title">Proforma Invoice</div>
<div class="doc-subtitle">This document is issued solely for customs clearance and does not constitute a commercial transaction.</div>

<div class="parties">
  <div class="party">
    <div class="party-label">${cfg.sellerLabel}</div>
    <div class="party-name">${cfg.sellerName}</div>
    <div class="party-detail">${cfg.sellerDetailHtml}</div>
  </div>
  <div class="party">
    <div class="party-label">${cfg.buyerLabel}</div>
    <div class="party-name">${cfg.buyerName}</div>
    <div class="party-detail">${cfg.buyerDetailHtml}</div>
  </div>
</div>

<div class="meta-row">
${cfg.metaRowHtml}
</div>

<table class="goods">
  <thead><tr>
${cfg.theadRowsHtml}
  </tr></thead>
  <tbody>${cfg.bodyRowsHtml || `<tr><td colspan="${cfg.emptyColspan}" style="text-align:center;padding:8px;color:#888">${cfg.emptyMessage}</td></tr>`}</tbody>
  <tfoot><tr>
${cfg.tfootRowHtml}
  </tr></tfoot>
</table>

<div class="total-box">
  <div class="total-label">Total Declared Value</div>
  <div class="total-value">${cfg.totalValueText}</div>
  <div class="total-label" style="margin-top:3mm">Total Gross Weight</div>
  <div class="total-value">${cfg.totalWeightHtml}</div>
</div>
${cfg.vatNoteHtml ? `\n<div class="vat-note">${cfg.vatNoteHtml}</div>\n` : ''}
<div class="declaration">
  ${cfg.declarationHtml}
</div>

<div class="sig-block">
  <div class="sig-label">Signature &amp; Date</div>
  <div class="sig-line">${cfg.signatoryName} &nbsp;&nbsp;·&nbsp;&nbsp; Date: _______________</div>
</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${cfg.titleHtml}</title>
<style>${cfg.css}</style></head><body>
${bodyHtml}
</body></html>`;
}
