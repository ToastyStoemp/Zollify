import JsBarcode from 'jsbarcode';

/**
 * Staff badges as an image, drawn at thermal-printer resolution (8 dots per
 * mm, 203 dpi) so the same picture prints on a card through the browser, on
 * a label printer installed as a system printer, or saved for a label app.
 *
 * The barcode's bars are always a whole number of dots wide: scaling bars
 * by a fraction makes some one dot wider than others, which is what makes a
 * Code 128 scan fail on a label that looks fine.
 */

export interface BadgeSize {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
}

/** Common label rolls, smallest last; the card fits a lanyard sleeve. */
export const BADGE_SIZES: BadgeSize[] = [
  { id: 'card', label: 'Card - 85.6 × 54 mm', widthMm: 85.6, heightMm: 54 },
  { id: '62x29', label: 'Label 62 × 29 mm (Brother DK-11209)', widthMm: 62, heightMm: 29 },
  { id: '57x32', label: 'Label 57 × 32 mm (Dymo 11354)', widthMm: 57, heightMm: 32 },
  { id: '50x30', label: 'Label 50 × 30 mm', widthMm: 50, heightMm: 30 },
  { id: '40x30', label: 'Label 40 × 30 mm (Phomemo M110)', widthMm: 40, heightMm: 30 },
];

export const DOTS_PER_MM = 8;

export interface BadgeContent {
  name: string;
  shop: string;
  code: string;
}

/** Code 128 wants ten bar widths of white either side to scan reliably. */
const QUIET_MODULES = 10;

function bars(code: string, moduleDots: number, heightDots: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  JsBarcode(c, code, { format: 'CODE128', displayValue: false, margin: 0, width: moduleDots, height: heightDots, background: '#ffffff', lineColor: '#000000' });
  return c;
}

/** The largest text size from `startPx` down that fits `maxWidth` on one line. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: string, startPx: number, maxWidth: number): number {
  let px = startPx;
  for (; px > 8; px--) {
    ctx.font = `${weight} ${px}px system-ui, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  return px;
}

/** Draws the badge onto `canvas`, resizing it to the badge's dots. */
export function renderBadge(canvas: HTMLCanvasElement, size: BadgeSize, content: BadgeContent): void {
  const w = Math.round(size.widthMm * DOTS_PER_MM);
  const h = Math.round(size.heightMm * DOTS_PER_MM);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  const small = size.heightMm < 40;
  const pad = Math.round((small ? 1.5 : 4) * DOTS_PER_MM);
  const innerW = w - pad * 2;
  let y = pad;

  // Shop, then the person's name - the name as large as fits.
  const shopPx = small ? 2.4 * DOTS_PER_MM : 3 * DOTS_PER_MM;
  if (content.shop) {
    ctx.font = `600 ${fit(ctx, content.shop.toUpperCase(), '600', shopPx, innerW)}px system-ui, sans-serif`;
    ctx.fillText(content.shop.toUpperCase(), pad, y);
    y += shopPx * 1.25;
  }
  const namePx = fit(ctx, content.name, '700', Math.round((small ? 5 : 6.5) * DOTS_PER_MM), innerW);
  ctx.font = `700 ${namePx}px system-ui, sans-serif`;
  ctx.fillText(content.name, pad, y);
  y += namePx * 1.2;

  // The caption under the bars, on anything but the smallest labels.
  const captionPx = small ? 2 * DOTS_PER_MM : 2.6 * DOTS_PER_MM;
  const caption = 'Staff badge - scan to unlock';
  const showCaption = h - y - pad > 12 * DOTS_PER_MM;
  const barsH = Math.max(6 * DOTS_PER_MM, h - pad - y - (showCaption ? captionPx * 1.4 : 0) - DOTS_PER_MM);

  // Widest whole-dot bars that fit with their quiet zones; scaled only as a last resort.
  let img: HTMLCanvasElement | null = null;
  for (let m = 4; m >= 1; m--) {
    const c = bars(content.code, m, barsH);
    if (c.width + QUIET_MODULES * 2 * m <= w) {
      img = c;
      break;
    }
    img = c;
  }
  const bw = Math.min(img!.width, w - 2 * QUIET_MODULES);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img!, Math.round((w - bw) / 2), Math.round(y + DOTS_PER_MM / 2), bw, barsH);

  if (showCaption) {
    ctx.font = `400 ${captionPx}px system-ui, sans-serif`;
    ctx.fillText(caption, pad, h - pad - captionPx);
  }
}
