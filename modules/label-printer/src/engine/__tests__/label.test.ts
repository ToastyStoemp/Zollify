import { describe, expect, it } from 'vitest';
import { labelDots, wrapText } from '../label';
import { PRINTER_DOTS_WIDE } from '../phomemo';

/** Deterministic stand-in for canvas measureText: width = character count. */
const fakeCtx = { measureText: (s: string) => ({ width: s.length }) as TextMetrics };

describe('labelDots', () => {
  it('converts mm to dots at 8 dots/mm', () => {
    expect(labelDots({ widthMm: 40, heightMm: 30 })).toEqual({ widthDots: 320, heightDots: 240 });
  });

  it('rounds width to a whole byte (8 dots) so raster rows pack cleanly', () => {
    // 43mm * 8 = 344 already exact; 41mm * 8 = 328, also exact - pick a size that isn't.
    expect(labelDots({ widthMm: 41.3, heightMm: 30 }).widthDots % 8).toBe(0);
  });

  it('clamps width to the print head - it physically cannot print wider', () => {
    expect(labelDots({ widthMm: 100, heightMm: 30 }).widthDots).toBe(PRINTER_DOTS_WIDE);
  });

  it('never returns zero for a very small size', () => {
    const { widthDots, heightDots } = labelDots({ widthMm: 0, heightMm: 0 });
    expect(widthDots).toBeGreaterThan(0);
    expect(heightDots).toBeGreaterThan(0);
  });
});

describe('wrapText', () => {
  it('fits everything on one line when short enough', () => {
    expect(wrapText(fakeCtx, 'Bear Bag', 20, 2)).toEqual(['Bear Bag']);
  });

  it('wraps onto a second line rather than dropping the overflow word', () => {
    // Regression: the second line used to keep only the single word that first
    // overflowed and silently drop everything after it ("Sticker Sheet - Bear
    // Theme" rendered as "Sticker Sheet -" / "Bear", losing "Theme").
    const lines = wrapText(fakeCtx, 'Sticker Sheet - Bear Theme', 15, 2);
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toContain('Theme');
  });

  it('ellipsises the last line instead of overflowing maxWidth', () => {
    const lines = wrapText(fakeCtx, 'A very long product title that will not fit', 10, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/…$/);
  });
});
