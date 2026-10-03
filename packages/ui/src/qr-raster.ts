/**
 * A QR code as a black-and-white PNG for a thermal printer.
 *
 * Drawn module by module at a whole number of dots each, so every module
 * prints as a crisp square - a scaled bitmap would smear edges that the
 * printer's 1-bit threshold then turns into a code phones can't read. The
 * image is the full paper width with the code centred inside it, so it lands
 * in the middle whether or not a printer centres images itself.
 */
export async function qrPngBase64(value: string, opts: { paperDots?: number; codeDots?: number } = {}): Promise<string> {
  const paper = opts.paperDots ?? 384;
  const target = opts.codeDots ?? 264;
  const { create } = await import('qrcode');
  const qr = create(value, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const dot = Math.max(1, Math.floor(target / (n + quiet * 2)));
  const side = (n + quiet * 2) * dot;

  const canvas = document.createElement('canvas');
  canvas.width = paper;
  canvas.height = side;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, paper, side);
  ctx.fillStyle = '#000000';
  const left = Math.floor((paper - side) / 2) + quiet * dot;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.get(y, x)) ctx.fillRect(left + x * dot, (y + quiet) * dot, dot, dot);
    }
  }
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}
