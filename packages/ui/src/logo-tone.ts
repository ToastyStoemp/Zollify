/**
 * Whether a logo is dark ink on a transparent background - a black logo, say.
 * On a dark theme such a logo vanishes into the background, so screens invert
 * it to white there (see AfterSalePanel's `.ink`). A coloured logo, or one on
 * its own opaque background, is left as it is: inverting would change its colours.
 */

/** The decision, on raw RGBA pixels: enough transparency, and the visible part dark and colourless. */
export function isDarkInk(data: ArrayLike<number>): boolean {
  let transparent = 0;
  let opaque = 0;
  let lum = 0;
  let chroma = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a < 32) {
      transparent++;
      continue;
    }
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    opaque++;
    lum += 0.299 * r + 0.587 * g + 0.114 * b;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const total = transparent + opaque;
  if (!total || !opaque || transparent / total < 0.05) return false;
  return lum / opaque < 90 && chroma / opaque < 40;
}

const cache = new Map<string, Promise<boolean>>();

/** Reads the image once per source; false when it cannot be read. */
export function logoIsDarkInk(src: string): Promise<boolean> {
  let found = cache.get(src);
  if (!found) {
    found = new Promise<boolean>((resolve) => {
      if (typeof Image === 'undefined' || typeof document === 'undefined') return resolve(false);
      const img = new Image();
      img.onload = () => {
        try {
          // A small sample is plenty to judge the tone.
          const scale = Math.min(1, 96 / Math.max(img.naturalWidth, img.naturalHeight, 1));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(false);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(isDarkInk(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
        } catch {
          resolve(false);
        }
      };
      img.onerror = () => resolve(false);
      img.src = src;
    });
    cache.set(src, found);
  }
  return found;
}
