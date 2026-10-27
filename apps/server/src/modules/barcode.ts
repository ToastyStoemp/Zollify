import barcodesModule from 'jsbarcode/bin/barcodes/index.js';

/**
 * A Code 128 barcode as inline SVG, for pages the server renders (a loyalty
 * card for a handheld scanner, say). jsbarcode's encoder gives the bars as a
 * string of 1s and 0s; it needs no canvas, so it runs here. Code 128 takes
 * the whole printable ASCII range, so a card code (`LY-…`) encodes as is.
 */

export class BarcodeError extends Error {}

// jsbarcode ships CommonJS built from ES modules: under Node's own loader the
// default import is the exports object with the encoders under `default`,
// under a bundler or vitest it is the encoders themselves. Take either.
const barcodes = ((barcodesModule as unknown as { default?: typeof barcodesModule }).default ?? barcodesModule) as typeof barcodesModule;

/** The bars of `text`: one character per module, '1' dark, '0' light. */
export function code128Modules(text: string): string {
  const encoder = new barcodes.CODE128(text, {});
  if (!encoder.valid()) throw new BarcodeError('That text cannot be a Code 128 barcode.');
  return encoder.encode().data;
}

/**
 * The barcode drawn, with a quiet zone of ten modules either side (what a
 * scanner needs to find the edges), as wide as its modules and `height` tall.
 */
export function code128Svg(text: string, opts: { height?: number; className?: string; label?: string } = {}): string {
  const data = code128Modules(text);
  const quiet = 10;
  const height = opts.height ?? 60;
  const width = data.length + quiet * 2;
  const rects: string[] = [];
  for (let i = 0; i < data.length; ) {
    if (data[i] !== '1') {
      i++;
      continue;
    }
    let j = i;
    while (j < data.length && data[j] === '1') j++;
    rects.push(`<rect x="${quiet + i}" y="0" width="${j - i}" height="${height}"/>`);
    i = j;
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${esc(opts.label ?? `Barcode ${text}`)}"${opts.className ? ` class="${esc(opts.className)}"` : ''}><rect width="${width}" height="${height}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`;
}
