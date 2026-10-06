import { describe, expect, it } from 'vitest';
import { restockForecast } from '../restock';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 6);
const sale = (productId: string, qty: number, daysAgo: number, variantId: string | null = null) => ({ productId, variantId, qty, at: now - daysAgo * DAY });

describe('restockForecast', () => {
  it('suggests enough for the weeks asked, less what is there and on its way', () => {
    // 16 sold over the 8-week window: 2 a week. 6 weeks needs 12; 3 left and 2 coming.
    const sales = Array.from({ length: 8 }, (_, w) => sale('print', 2, 3 + w * 7));
    const [row] = restockForecast([{ productId: 'print', variantId: '', remaining: 3 }], [...sales, sale('print', 50, 90)], { weeks: 6, now, inTransit: { 'print:': 2 } });
    expect(row).toMatchObject({ sold: 16, perWeek: 2, left: 3, inTransit: 2, weeksLeft: 2.5, suggest: 7 });
  });

  it('judges a new item over the days it has sold, but never fewer than two weeks', () => {
    // 6 sold in the last 3 days: over 14 days that is 3 a week, not 14.
    const [row] = restockForecast([{ productId: 'tote', variantId: 'blk', remaining: 0 }], [sale('tote', 6, 3, 'blk')], { weeks: 4, now });
    expect(row).toMatchObject({ perWeek: 3, suggest: 12 });
  });

  it('suggests nothing for what is not selling, and keeps variants apart', () => {
    const rows = restockForecast(
      [
        { productId: 'tote', variantId: 'nat', remaining: 5 },
        { productId: 'tote', variantId: 'blk', remaining: null },
      ],
      [sale('tote', 4, 10, 'blk')],
      { weeks: 4, now },
    );
    expect(rows[0]).toMatchObject({ sold: 0, perWeek: 0, weeksLeft: null, suggest: 0 });
    expect(rows[1]).toMatchObject({ sold: 4, left: null, perWeek: 2, suggest: 8 });
  });
});
