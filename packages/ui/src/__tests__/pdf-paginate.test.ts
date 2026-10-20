import { describe, expect, it } from 'vitest';
import { paginate, type Layout } from '../pdf';

// 1 CSS px per mm keeps the numbers readable: a 297-tall page, 15 margin.
const PAGE = 297;
const rows = (from: number, n: number, h: number) =>
  Array.from({ length: n }, (_, i) => ({ top: from + i * h, bottom: from + (i + 1) * h }));

describe('paginate', () => {
  it('keeps one-page content on one page', () => {
    const layout: Layout = { height: 297, contentEnd: 282, margin: 15, atoms: rows(15, 10, 20), tables: [] };
    expect(paginate(layout, PAGE, 1)).toEqual([{ from: 0, to: 297, head: undefined }]);
  });

  it('breaks between rows, not through them, and repeats the table header', () => {
    const body = rows(40, 30, 10); // rows 40..340
    const layout: Layout = {
      height: 355,
      contentEnd: 340,
      margin: 15,
      atoms: body,
      tables: [{ head: { top: 30, bottom: 40 }, body: { top: 40, bottom: 340 } }],
    };
    const pages = paginate(layout, PAGE, 1);
    expect(pages).toHaveLength(2);
    // First page room ends at 282 - mid-row 280..290 is pushed to the next page.
    expect(pages[0]).toEqual({ from: 0, to: 280, head: undefined });
    expect(pages[1]!.from).toBe(280);
    expect(pages[1]!.head).toEqual({ top: 30, bottom: 40 });
    for (const p of pages) for (const r of body) expect(r.top >= p.to || r.bottom <= p.to).toBe(true);
  });

  it('cuts at the limit when nothing breakable fits', () => {
    const layout: Layout = { height: 700, contentEnd: 700, margin: 0, atoms: [{ top: 10, bottom: 690 }], tables: [] };
    const pages = paginate(layout, PAGE, 1);
    expect(pages.map((p) => p.from)).toEqual([0, 297, 594]);
  });
});
