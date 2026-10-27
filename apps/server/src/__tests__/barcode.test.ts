import { describe, expect, it } from 'vitest';
import { code128Modules, code128Svg } from '../modules/barcode';

/** A Code 128 for a handheld scanner: start and stop patterns in place, bars drawn, a quiet zone either side. */
describe('Code 128', () => {
  it('encodes a card code with the standard start and stop patterns', () => {
    const bars = code128Modules('LY-DEM0CARD0000001A');
    expect(bars).toMatch(/^[01]+$/);
    // Start B (letters and digits) or C (digit pairs), and the stop pattern every Code 128 ends with.
    expect(bars.startsWith('11010010000') || bars.startsWith('11010011100')).toBe(true);
    expect(bars.endsWith('1100011101011')).toBe(true);
  });

  it('draws the bars as rectangles, with ten modules of quiet zone', () => {
    const svg = code128Svg('LY-DEM0CARD0000001A', { height: 50, label: 'Card LY-DEM0CARD0000001A' });
    const bars = code128Modules('LY-DEM0CARD0000001A');
    expect(svg).toContain(`viewBox="0 0 ${bars.length + 20} 50"`);
    expect(svg).toContain('aria-label="Card LY-DEM0CARD0000001A"');
    // The first bar starts after the quiet zone; a Code 128 always starts with a bar.
    expect(svg).toContain('<rect x="10" y="0"');
    expect((svg.match(/<rect x=/g) ?? []).length).toBeGreaterThan(20);
  });

  it('refuses what Code 128 cannot hold', () => {
    expect(() => code128Modules('ünïcode')).toThrow();
  });
});
