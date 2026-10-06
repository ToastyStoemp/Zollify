/**
 * Layout kit for the official BAZG forms (11.74, 11.87).
 *
 * The forms are drawn the way the printed originals are: a fixed grid of
 * boxes placed in millimetres, measured off the PDFs BAZG publishes
 * (formular_11_74.pdf, formular_11_87.pdf), rather than flowed tables that
 * only roughly resemble them. A customs officer used to the paper form
 * finds every field where they expect it.
 *
 * Coordinates are relative to the form's outer frame (its top-left corner),
 * in mm. The frame sits on an A4 sheet; the originals are a few mm larger
 * (about 211 x 300-310 mm), so the header above the frame is shortened to
 * keep the whole form on one A4 page.
 */

/**
 * The purpose of the temporary admission (11.74 box 13, 11.87 box 10):
 * goods taken to a show to be sold if they find a buyer.
 */
export const PURPOSE = 'ungewisser Verkauf · vente incertaine';

/** Frame position on the A4 sheet. */
export const FX = 20;
export const FY = 14;

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A box at (x, y), w x h mm: left and top rules; the frame closes the right and bottom. */
export function box(x: number, y: number, w: number, h: number, inner = '', cls = ''): string {
  return `<div class="b${cls ? ' ' + cls : ''}" style="left:${x}mm;top:${y}mm;width:${w}mm;height:${h}mm">${inner}</div>`;
}

/** A dotted fill-in line from x1 to x2 at y (frame mm). */
export function fill(x1: number, x2: number, y: number): string {
  return `<div class="fl" style="left:${x1}mm;top:${y}mm;width:${x2 - x1}mm"></div>`;
}

/** Field number plus its German / French / Italian label, stacked like the original. */
export function label(num: string, lines: string[], cls = ''): string {
  return `<div class="lbl${cls ? ' ' + cls : ''}">${num ? `<span class="n">${esc(num)}</span>` : ''}<span class="t">${lines.map(esc).join('<br>')}</span></div>`;
}

/** A pre-filled value (bold blue on screen). `pre` keeps line breaks. */
export function fv(v: string, pre = false): string {
  return v ? `<span class="fv${pre ? ' pre' : ''}">${esc(v)}</span>` : '';
}

/** A group value in the goods table. */
export function gv(v: string | number): string {
  return v !== '' && v != null ? `<span class="gfv">${esc(v)}</span>` : '';
}

export function checkbox(checked: boolean, lines: string[]): string {
  return `<span class="cbx"><span class="t">${lines.map(esc).join('<br>')}</span><span class="cb${checked ? ' on' : ''}"></span></span>`;
}

export interface SheetOptions {
  title: string;
  /** Short note for the screen-only bar above the sheet; never printed. */
  hint: string;
  /** The strip colour: pink for 11.74, green for 11.87. */
  color: string;
  formNumber: string;
  /** Header lines next to the Swiss cross: [federation lines, office lines]. */
  header: { federation: string[]; office: string[] };
  /** Vertical title in the left margin, one line per language. */
  sideTitle: string[];
  /** Vertical filling-in instructions at the bottom left, one line per language. */
  sideInstructions: string[];
  /** Where the coloured left strip starts (frame mm) - beside the goods rows. */
  stripFrom: number;
  /** Row-number column (frame mm, left of the frame) with the item numbers. */
  rowNumbers: { y: number; h: number; n: string }[];
  frameW: number;
  frameH: number;
  footerLeft: string;
  footerRight: string;
  /** The boxes, fill lines and anything else inside the frame. */
  body: string;
}

const FEDERAL_CROSS = `<svg viewBox="0 0 20 20" width="3.6mm" height="3.6mm" aria-hidden="true"><path d="M2 1h16v9c0 5-4 8-8 9-4-1-8-4-8-9z" fill="#000"/><path d="M8.5 4.5h3v3.2h3.2v3H11.5v3.3h-3v-3.3H5.3v-3h3.2z" fill="#fff"/></svg>`;

export function sheet(o: SheetOptions): string {
  const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #b0b0b0; }
.print-bar { background:#222; color:#fff; padding:7px 14px; font-size:10pt; display:flex; align-items:center; gap:12px; position:sticky; top:0; z-index:9; }
.print-bar button { background:#1a6ecc; color:#fff; border:none; padding:5px 16px; font-size:10pt; cursor:pointer; border-radius:3px; font-weight:bold; }
.print-bar .hint { font-size:7.5pt; color:#bbb; }
.sheet { position:relative; width:210mm; height:297mm; margin:8mm auto; background:#fff; overflow:hidden; box-shadow:0 0 0 1px #777; }
.strip { position:absolute; background:${o.color}; }
.big-a { position:absolute; font-size:30pt; font-weight:bold; line-height:1; transform:scaleX(.8); transform-origin:left top; }
/* Rotated, not writing-mode: the PDF renderer (html2canvas) can't lay out vertical text. */
.side { position:absolute; transform-origin:left top; transform:rotate(-90deg); white-space:nowrap; }
.side.title { font-size:9.5pt; line-height:1.25; }
.side.instr { font-size:5.2pt; line-height:1.3; }
.hdr { position:absolute; left:${FX}mm; top:3mm; right:10mm; height:${FY - 3}mm; display:flex; gap:4mm; font-size:4.2pt; line-height:1.25; }
.hdr .fed { display:flex; gap:1.2mm; }
.hdr .office { font-weight:bold; }
.hdr .copy { display:flex; align-items:flex-start; gap:1.5mm; font-size:5.5pt; line-height:1.2; }
.hdr .copy .arrow { margin-top:1.3mm; font-size:9pt; line-height:0.6; }
.hdr .copy .dots { border-bottom:0.25mm dotted #000; width:45mm; height:5.5mm; }
.frame { position:absolute; left:${FX}mm; top:${FY}mm; width:${o.frameW}mm; height:${o.frameH}mm; border-right:0.35mm solid #000; border-bottom:0.35mm solid #000; }
.b { position:absolute; border-left:0.2mm solid #000; border-top:0.2mm solid #000; padding:0.5mm 0.8mm; overflow:hidden; }
.b.thick-l { border-left-width:0.35mm; }
.b.thick-t { border-top-width:0.35mm; }
.b.nob-t { border-top:none; }
.b.nob-l { border-left:none; }
.fl { position:absolute; border-bottom:0.2mm dotted #000; height:0; }
.lbl { display:flex; gap:1mm; font-size:5.2pt; line-height:1.18; }
.lbl .n { font-size:6.4pt; line-height:1.1; min-width:2.6mm; }
.lbl.c { justify-content:center; text-align:center; }
.lbl.sm { font-size:4.3pt; }
.lbl.sm .n { font-size:5.4pt; }
.val { margin-top:0.6mm; font-size:7.6pt; line-height:1.3; }
.val.r { text-align:right; }
.val.beside { position:absolute; left:37mm; top:0.6mm; margin-top:0; font-size:7pt; line-height:1.2; }
.lv { display:flex; align-items:flex-start; gap:2mm; margin-bottom:0.9mm; }
.lv .lbl { width:21mm; flex-shrink:0; }
.lv .val { margin-top:0; }
.val.c { text-align:center; }
.fv { color:#0033aa; font-weight:bold; }
.fv.pre { white-space:pre-wrap; }
.gfv { color:#0033aa; font-weight:bold; font-size:7.6pt; white-space:pre-wrap; }
.cbx { display:inline-flex; align-items:center; gap:1.2mm; font-size:5.2pt; line-height:1.15; }
.cb { display:inline-block; width:3mm; height:3mm; border:0.2mm solid #000; background:#fff; flex-shrink:0; }
.cb.on { background:#000; }
.form-no { font-size:21pt; font-weight:bold; text-align:center; line-height:1; letter-spacing:0.3pt; }
.rownum { position:absolute; display:flex; align-items:center; justify-content:center; font-size:12pt; border-top:0.2mm solid #000; background:#fff; }
.foot { position:absolute; top:${FY + o.frameH + 0.8}mm; font-size:5pt; }
@media print {
  .print-bar { display:none; }
  body { background:#fff; }
  .sheet { margin:0; box-shadow:none; }
  @page { size: A4 portrait; margin: 0; }
}`;

  const rowNums = o.rowNumbers
    .map((r) => `<div class="rownum" style="left:${FX - 5}mm;top:${FY + r.y}mm;width:5mm;height:${r.h}mm">${esc(r.n)}</div>`)
    .join('');

  // data-pdf-media: the PDF export renders this the way it prints (see htmlToPdf).
  return `<!DOCTYPE html><html lang="de" data-pdf-media="print"><head><meta charset="UTF-8">
<title>${esc(o.title)}</title>
<style>${CSS}</style></head><body>
<div class="print-bar">
  <button onclick="window.print()">Print / Save PDF</button>
  <span class="hint">${o.hint}</span>
</div>
<div class="sheet">
  <div class="strip" style="left:0;top:${FY + o.stripFrom}mm;width:${FX - 5}mm;bottom:0"></div>
  <div class="strip" style="left:${FX + o.frameW}mm;top:${FY}mm;right:0;bottom:0"></div>
  <div class="big-a" style="left:5.5mm;top:${FY + 0.5}mm">A</div>
  <div class="big-a" style="left:${FX + o.frameW + 1.6}mm;top:${FY + 3}mm">A</div>
  <div class="side title" style="left:4.5mm;top:${FY + o.stripFrom - 3}mm;width:${o.stripFrom - 16}mm">${o.sideTitle.map(esc).join('<br>')}</div>
  <div class="side instr" style="left:3mm;top:292mm;width:90mm">${o.sideInstructions.map(esc).join('<br>')}</div>
  <div class="hdr">
    <div class="fed">${FEDERAL_CROSS}<div>${o.header.federation.map(esc).join('<br>')}</div></div>
    <div class="office">${o.header.office.map(esc).join('<br>')}</div>
    <div class="copy"><div>Kopie für<br>Copie pour<br>Copia per</div><span class="arrow">&#x2794;</span><div class="dots"></div></div>
  </div>
  <div class="frame">${o.body}</div>
  ${rowNums}
  <div class="foot" style="left:${FX}mm">${esc(o.footerLeft)}</div>
  <div class="foot" style="right:${210 - FX - o.frameW}mm">${esc(o.footerRight)}</div>
</div>
</body></html>`;
}
