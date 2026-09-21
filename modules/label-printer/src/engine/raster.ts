/**
 * Canvas -> 1-bit thermal-printer raster.
 *
 * Floyd-Steinberg dithering (the same technique the community Phomemo web
 * tools use) rather than a flat threshold, so a label with any greyscale
 * (e.g. a logo) doesn't just turn to solid black/white blobs. Text and a
 * barcode - the actual use case here - are already pure black/white, so
 * dithering is a no-op for them and only matters if a future label design
 * adds a photo.
 */

/** One byte per 8 dots, MSB first, bit = 1 means "print ink here". */
export function rasterizeCanvas(canvas: HTMLCanvasElement): Uint8Array[] {
  const width = canvas.width;
  const height = canvas.height;
  if (width % 8 !== 0) throw new Error(`Canvas width (${width}) must be a multiple of 8 to pack into whole bytes.`);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas has no 2D context.');
  const { data } = ctx.getImageData(0, 0, width, height);

  // Greyscale, as a plain float grid so the dithering error can go negative/over 255.
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
    // Transparent counts as white (unprinted) - blend toward 255 by alpha.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = lum * (a / 255) + 255 * (1 - a / 255);
  }

  const bytesPerRow = width / 8;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(bytesPerRow);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = gray[i]!;
      const black = old < 128;
      const newVal = black ? 0 : 255;
      const err = old - newVal;
      if (black) row[x >> 3] = (row[x >> 3] ?? 0) | (0x80 >> (x & 7));

      // Floyd-Steinberg error diffusion to the four neighbouring not-yet-visited pixels.
      if (x + 1 < width) gray[i + 1]! += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) gray[i + width - 1]! += (err * 3) / 16;
        gray[i + width]! += (err * 5) / 16;
        if (x + 1 < width) gray[i + width + 1]! += (err * 1) / 16;
      }
    }
    rows.push(row);
  }
  return rows;
}
