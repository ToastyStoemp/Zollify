/**
 * Renders one product label (name + Code128 SKU barcode) onto a canvas sized
 * exactly to the label stock, ready for `rasterizeCanvas()`.
 */
import JsBarcode from 'jsbarcode';
import { PRINTER_DOTS_WIDE } from './phomemo';

/** 203 DPI - the M110's fixed print resolution (8 dots/mm). */
export const DOTS_PER_MM = 8;

export interface LabelSize {
  widthMm: number;
  heightMm: number;
}

export const DEFAULT_LABEL_SIZE: LabelSize = { widthMm: 40, heightMm: 30 };

/** Label width must land on a whole byte (8 dots) and can't exceed the print head. */
export function labelDots(size: LabelSize): { widthDots: number; heightDots: number } {
  const rawWidth = Math.round(size.widthMm * DOTS_PER_MM);
  const widthDots = Math.min(PRINTER_DOTS_WIDE, Math.max(8, Math.round(rawWidth / 8) * 8));
  const heightDots = Math.max(8, Math.round(size.heightMm * DOTS_PER_MM));
  return { widthDots, heightDots };
}

/** Wraps text to fit `maxWidth`, returning at most `maxLines` lines (the last one ellipsised if there's more). */
export function wrapText(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
      i++;
    } else if (lines.length === maxLines - 1) {
      // On the last allowed line: stop wrapping word-by-word - whatever's
      // left (this word plus anything after it) joins the line as-is and
      // gets ellipsised below, rather than being silently dropped.
      break;
    } else {
      lines.push(line);
      line = '';
    }
  }
  const rest = words.slice(i).join(' ');
  line = line && rest ? `${line} ${rest}` : line || rest;
  if (line) lines.push(line);

  const last = lines[lines.length - 1];
  if (last && ctx.measureText(last).width > maxWidth) {
    let truncated = last;
    while (truncated.length > 1 && ctx.measureText(truncated + '…').width > maxWidth) truncated = truncated.slice(0, -1);
    lines[lines.length - 1] = truncated + '…';
  }
  return lines;
}

/**
 * Draws the label onto `canvas`, resizing it to the label's dot dimensions.
 * `sku` must be non-empty and barcode-safe (Code128 covers full ASCII, so any
 * real SKU works); products without one should be filtered out before this
 * is called, since a barcode with nothing to encode is not a useful label.
 */
/** Below this, text stops shrinking and truncates instead - smaller is not legible on a real label. */
const MIN_TITLE_FONT_PX = 12;

/** Baseline fraction of the title area a 100%-scale title font starts at, before the fit-to-2-lines shrink loop. */
const TITLE_FONT_FRACTION = 0.3;

export interface RenderLabelOptions {
  /** 0.5-1.5 - multiplies the title's auto-fit starting size; a knob for tuning by eye, not a guarantee (the fit loop can still shrink further). */
  titleScale?: number;
}

/**
 * Renders the barcode at the largest integer module width (in dots) that
 * fits `maxWidth` outright - jsbarcode always renders bars at whole-pixel
 * widths, but the previous approach rendered once at a fixed width then
 * scaled the whole image down by whatever fractional ratio was needed to
 * fit. That scaling rounds each bar's edges independently, so bars meant to
 * be identical widths land at slightly different pixel counts after
 * scaling - inconsistent module widths are a classic cause of a Code128
 * decoder failing intermittently on a barcode that looks fine to the eye.
 * Trying integer widths first means the common case never scales at all:
 * every bar is an exact whole number of print dots, matching the printer's
 * fixed resolution 1:1. Only when even the narrowest module (1 dot) still
 * doesn't fit - a long SKU on a small label - does this fall back to
 * scaling, which is unavoidable at that point.
 */
function fitBarcodeCanvas(sku: string, maxWidth: number, height: number): { canvas: HTMLCanvasElement; scaled: boolean } {
  let last: HTMLCanvasElement | null = null;
  for (let width = 3; width >= 1; width--) {
    const canvas = document.createElement('canvas');
    JsBarcode(canvas, sku, { format: 'CODE128', displayValue: false, margin: 8, width, height });
    if (canvas.width <= maxWidth) return { canvas, scaled: false };
    last = canvas;
  }
  return { canvas: last!, scaled: true };
}

export function renderLabel(canvas: HTMLCanvasElement, size: LabelSize, sku: string, title: string, options: RenderLabelOptions = {}): void {
  const { widthDots, heightDots } = labelDots(size);
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas has no 2D context.');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  const margin = Math.max(4, Math.round(widthDots * 0.05));
  const titleAreaHeight = Math.round(heightDots * 0.42);
  const barcodeAreaHeight = heightDots - titleAreaHeight;

  // Product name, as large as fits in the title area on up to two lines -
  // stops at a legible floor and truncates rather than shrinking further.
  const titleScale = Math.min(1.5, Math.max(0.5, options.titleScale ?? 1));
  let fontSize = Math.round(titleAreaHeight * TITLE_FONT_FRACTION * titleScale);
  let lines: string[] = [];
  for (;;) {
    ctx.font = `600 ${fontSize}px Arial, Helvetica, sans-serif`;
    lines = wrapText(ctx, title || '(untitled)', widthDots - margin * 2, 2);
    const totalHeight = lines.length * fontSize * 1.15;
    if (totalHeight <= titleAreaHeight - 4 || fontSize <= MIN_TITLE_FONT_PX) break;
    fontSize -= 1;
  }
  const lineHeight = fontSize * 1.15;
  const textBlockHeight = lines.length * lineHeight;
  let y = (titleAreaHeight - textBlockHeight) / 2;
  for (const line of lines) {
    ctx.textAlign = 'center';
    ctx.fillText(line, widthDots / 2, y, widthDots - margin * 2);
    y += lineHeight;
  }

  // A thin rule separates name from barcode - reads as a deliberately
  // designed label rather than two things stacked on top of each other.
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin, titleAreaHeight);
  ctx.lineTo(widthDots - margin, titleAreaHeight);
  ctx.stroke();

  const skuFontSize = Math.max(14, Math.round(barcodeAreaHeight * 0.18));
  const skuLineHeight = skuFontSize * 1.2;
  const barsHeight = Math.max(8, barcodeAreaHeight - skuLineHeight - 6);
  const barcodeTop = titleAreaHeight + 4;

  // The human-readable SKU is drawn separately below, in our own font size -
  // NOT via jsbarcode's `displayValue`, which would get shrunk along with
  // the bars by the width-fit scale a few lines down and end up illegibly
  // small whenever the barcode itself is wider than the label.
  const { canvas: barcodeCanvas, scaled } = fitBarcodeCanvas(sku, widthDots - margin * 2, barsHeight);

  // Smoothing off in the (now rare) scaled case: the default bilinear
  // resample turns crisp bar edges into a grey fringe, which
  // rasterizeCanvas's threshold then has to guess about - nearest-neighbour
  // at least keeps every edge a clean black/white step, even if module
  // widths still land unevenly.
  ctx.imageSmoothingEnabled = false;
  const scale = scaled ? Math.min(1, (widthDots - margin * 2) / barcodeCanvas.width) : 1;
  const drawWidth = barcodeCanvas.width * scale;
  const drawHeight = barcodeCanvas.height * scale;
  ctx.drawImage(barcodeCanvas, (widthDots - drawWidth) / 2, barcodeTop, drawWidth, drawHeight);

  ctx.font = `700 ${skuFontSize}px ui-monospace, "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(sku, widthDots / 2, barcodeTop + drawHeight + 4, widthDots - margin * 2);
}
