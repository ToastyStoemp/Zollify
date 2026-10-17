import type { ReceiptLine } from '../receipt';

/**
 * Compact printing: the receipt's text drawn into images before it goes to
 * the printer, so Zollify sets the line spacing instead of the printer.
 *
 * The Carbon's printer gives every text row a full blank line's worth of
 * space, which made a short sale a long strip of paper. Its image printing has
 * no such gap, so runs of text rows become one picture each: monospace rows at
 * a normal line height, dividers as a thin dashed rule. Logos and QR codes
 * pass through untouched. Ships as content, no new app build needed.
 */

/** 58mm thermal paper: 384 printable dots, as the Carbon and the QR raster assume. */
export const PAPER_DOTS = 384;
/** Characters per row, as the receipt layout is built (see receipt.ts WIDTH). */
const COLUMNS = 32;
/** Keep each picture small: the print request travels in one Android message. */
const MAX_BLOCK_DOTS = 480;
const DIVIDER = /^-{8,}$/;

export type RasterRow = { kind: 'text'; text: string; align: 'left' | 'center' | 'right'; double: boolean } | { kind: 'rule' } | { kind: 'gap' };

/** What a run of rows becomes: a block to draw, or a line passed through as it is. */
export type RasterItem = { kind: 'block'; rows: RasterRow[] } | { kind: 'line'; line: ReceiptLine };

export interface RasterMetrics {
  rowDots: number;
  ruleDots: number;
  gapDots: number;
}

export const rowHeight = (row: RasterRow, m: RasterMetrics): number => (row.kind === 'rule' ? m.ruleDots : row.kind === 'gap' ? m.gapDots : row.double ? m.rowDots * 2 : m.rowDots);

/**
 * Groups the receipt into blocks of text rows, split before a block would
 * pass `maxDots`, with images kept as they are. A blank line between text
 * rows becomes a small gap inside the block; blank lines next to an image
 * stay printer feeds, which is what tears off cleanly at the end.
 */
export function layoutReceipt(lines: ReceiptLine[], m: RasterMetrics, maxDots = MAX_BLOCK_DOTS): RasterItem[] {
  const out: RasterItem[] = [];
  let rows: RasterRow[] = [];
  let height = 0;
  const flush = (): void => {
    // A block never starts or ends on a gap: those belong between rows.
    while (rows.length && rows[rows.length - 1]!.kind === 'gap') rows.pop();
    if (rows.length) out.push({ kind: 'block', rows });
    rows = [];
    height = 0;
  };
  const add = (row: RasterRow): void => {
    const h = rowHeight(row, m);
    if (height + h > maxDots && rows.length) flush();
    if (row.kind === 'gap' && !rows.length) return;
    rows.push(row);
    height += h;
  };
  lines.forEach((line, i) => {
    if (line.kind === 'image') {
      flush();
      out.push({ kind: 'line', line });
    } else if (line.kind === 'space') {
      // Between two text rows: a gap in the block. Elsewhere: a real feed.
      const next = lines.slice(i + 1).find((l) => l.kind !== 'space');
      if (rows.length && next?.kind === 'text') add({ kind: 'gap' });
      else {
        flush();
        out.push({ kind: 'line', line });
      }
    } else {
      const text = line.text ?? '';
      add(DIVIDER.test(text.trim()) ? { kind: 'rule' } : { kind: 'text', text, align: line.align ?? 'left', double: !!line.doubleHeight });
    }
  });
  flush();
  return out;
}

/** The bits of a canvas this needs - so tests can stand in for the browser's. */
export interface RasterCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): CanvasRenderingContext2D | null;
  toDataURL(type: string): string;
}

const defaultCanvas = (): RasterCanvas | null => (typeof document === 'undefined' ? null : document.createElement('canvas'));

/** Font size at which COLUMNS monospace characters fill the paper, leaving a small margin. */
function fitFont(ctx: CanvasRenderingContext2D): number {
  ctx.font = '100px monospace';
  const per100 = ctx.measureText('M'.repeat(COLUMNS)).width || COLUMNS * 60;
  return Math.max(12, Math.floor(((PAPER_DOTS - 8) * 100) / per100));
}

function drawBlock(rows: RasterRow[], m: RasterMetrics, font: number, makeCanvas: () => RasterCanvas | null): string | null {
  const canvas = makeCanvas();
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return null;
  canvas.width = PAPER_DOTS;
  canvas.height = rows.reduce((h, r) => h + rowHeight(r, m), 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${font}px monospace`;
  let y = 0;
  for (const r of rows) {
    const h = rowHeight(r, m);
    if (r.kind === 'rule') {
      ctx.setLineDash?.([6, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(4, y + h / 2);
      ctx.lineTo(PAPER_DOTS - 4, y + h / 2);
      ctx.stroke();
    } else if (r.kind === 'text') {
      ctx.textAlign = r.align;
      const x = r.align === 'center' ? PAPER_DOTS / 2 : r.align === 'right' ? PAPER_DOTS - 4 : 4;
      if (r.double) {
        ctx.save();
        ctx.translate(0, y + h / 2);
        ctx.scale(1, 2);
        ctx.fillText(r.text, x, 0);
        ctx.restore();
      } else ctx.fillText(r.text, x, y + h / 2);
    }
    y += h;
  }
  // Thermal paper is black or white: grey edges from smoothing would print as noise.
  try {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11 < 150 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  } catch {
    /* a canvas that will not give its pixels prints as drawn */
  }
  const url = canvas.toDataURL('image/png');
  const b64 = url.slice(url.indexOf(',') + 1);
  return b64 || null;
}

/**
 * The receipt with its text as images. Returns the lines unchanged when this
 * device cannot draw (no canvas) - printing as before beats not printing.
 */
export function rasterizeReceipt(lines: ReceiptLine[], makeCanvas: () => RasterCanvas | null = defaultCanvas): ReceiptLine[] {
  const probe = makeCanvas()?.getContext('2d');
  if (!probe) return lines;
  const font = fitFont(probe);
  const m: RasterMetrics = { rowDots: Math.round(font * 1.25), ruleDots: Math.round(font * 0.6), gapDots: Math.round(font * 0.5) };
  const out: ReceiptLine[] = [];
  for (const item of layoutReceipt(lines, m)) {
    if (item.kind === 'line') {
      out.push(item.line);
      continue;
    }
    const b64 = drawBlock(item.rows, m, font, makeCanvas);
    if (!b64) return lines;
    out.push({ kind: 'image', imageB64: b64 });
  }
  return out;
}
