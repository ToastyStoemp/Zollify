import { describe, expect, it } from 'vitest';
import type { ReceiptLine } from '../receipt';
import { PAPER_DOTS, layoutReceipt, rasterizeReceipt, type RasterCanvas } from '../lib/receipt-raster';

const m = { rowDots: 25, ruleDots: 12, gapDots: 10 };
const t = (text: string, extra: Partial<ReceiptLine> = {}): ReceiptLine => ({ kind: 'text', text, ...extra });
const img: ReceiptLine = { kind: 'image', imageB64: 'QR' };
const space: ReceiptLine = { kind: 'space' };

describe('compact receipt layout', () => {
  it('turns runs of text into blocks, keeps images, and draws dividers as rules', () => {
    const items = layoutReceipt([img, t('Shop', { align: 'center', doubleHeight: true }), t('-'.repeat(32)), t('Total'), space, img, space, space], m);
    expect(items.map((i) => (i.kind === 'line' ? i.line.kind : 'block'))).toEqual(['image', 'block', 'space', 'image', 'space', 'space']);
    const block = items[1]!;
    expect(block.kind === 'block' && block.rows).toEqual([
      { kind: 'text', text: 'Shop', align: 'center', double: true },
      { kind: 'rule' },
      { kind: 'text', text: 'Total', align: 'left', double: false },
    ]);
  });

  it('keeps a blank line between text rows as a small gap inside the block', () => {
    const [block] = layoutReceipt([t('A'), space, t('B')], m);
    expect(block!.kind === 'block' && block!.rows.map((r) => r.kind)).toEqual(['text', 'gap', 'text']);
  });

  it('splits a long receipt so no picture grows past the limit', () => {
    const lines = Array.from({ length: 40 }, (_, i) => t(`Row ${i}`));
    const blocks = layoutReceipt(lines, m, 250);
    expect(blocks).toHaveLength(4);
    for (const b of blocks) expect(b.kind === 'block' && b.rows.length).toBeLessThanOrEqual(10);
  });
});

/** Enough of a canvas to record what was drawn. */
function fakeCanvas(log: string[]): () => RasterCanvas {
  return () => {
    const c = {
      width: 0,
      height: 0,
      getContext: () =>
        ({
          font: '',
          measureText: (s: string) => ({ width: s.length * 60 }),
          fillRect: () => {},
          fillText: (s: string) => log.push(s),
          save: () => {},
          restore: () => {},
          translate: () => {},
          scale: () => log.push('scale'),
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => log.push('rule'),
          setLineDash: () => {},
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          putImageData: () => {},
        }) as unknown as CanvasRenderingContext2D,
      toDataURL: () => `data:image/png;base64,PNG${c.width}x${c.height}`,
    };
    return c;
  };
}

describe('compact receipt drawing', () => {
  it('draws each block on paper-width images and passes images through', () => {
    const log: string[] = [];
    const out = rasterizeReceipt([t('Phuong Ninjin', { align: 'center', doubleHeight: true }), t('-'.repeat(32)), t('Subtotal  CHF 45.00'), img], fakeCanvas(log));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'image' });
    expect(out[0]!.imageB64).toMatch(new RegExp(`^PNG${PAPER_DOTS}x\\d+$`));
    expect(out[1]).toBe(img);
    expect(log).toEqual(['scale', 'Phuong Ninjin', 'rule', 'Subtotal  CHF 45.00']);
    // Three rows (one double) at a normal line height: far shorter than a blank line per row.
    const height = Number(out[0]!.imageB64!.split('x')[1]);
    expect(height).toBeLessThan(4 * 40);
  });

  it('prints the lines as they are when there is no canvas', () => {
    const lines = [t('A'), img];
    expect(rasterizeReceipt(lines, () => null)).toBe(lines);
  });
});
