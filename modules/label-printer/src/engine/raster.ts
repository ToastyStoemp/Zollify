/**
 * Canvas -> 1-bit thermal-printer raster.
 *
 * Plain threshold, not Floyd-Steinberg dithering (which this used to do).
 * Dithering only pays off on photographic content; on text and a barcode -
 * the only things a label ever has - it instead takes the antialiased grey
 * fringe around every glyph and bar edge and spreads it as speckle noise
 * into neighbouring pixels, which is exactly what read as "low-resolution"
 * output. A flat threshold turns each edge pixel into a clean local
 * black/white decision instead - matches pippo-label-studio's own
 * `pack()`, which does the same plain threshold with no dithering.
 */

/** One byte per 8 dots, MSB first, bit = 1 means "print ink here". */
export function rasterizeCanvas(canvas: HTMLCanvasElement): Uint8Array[] {
  const width = canvas.width;
  const height = canvas.height;
  if (width % 8 !== 0) throw new Error(`Canvas width (${width}) must be a multiple of 8 to pack into whole bytes.`);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas has no 2D context.');
  const { data } = ctx.getImageData(0, 0, width, height);

  const bytesPerRow = width / 8;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(bytesPerRow);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!, a = data[i + 3]!;
      // Transparent counts as white (unprinted) - blend toward 255 by alpha.
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255) + 255 * (1 - a / 255);
      if (lum < 128) row[x >> 3] = (row[x >> 3] ?? 0) | (0x80 >> (x & 7));
    }
    rows.push(row);
  }
  return rows;
}
