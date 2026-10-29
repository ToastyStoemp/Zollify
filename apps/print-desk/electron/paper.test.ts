import { describe, expect, it } from 'vitest';
import { effectiveParams, orientFor, paperMm, paperName, paperParam, printSizeMm, scaleForMm, settingsFor, sizeFromName, targetFor, fitToStock, paperNeeds, poissonTail, smartFit } from './shared.js';

describe('orientFor', () => {
  const portrait = { paper: 'a3', orientation: 'portrait', printerSettings: 'hex' };
  it('turns to landscape for a wide image and keeps the driver settings for PhotoCraft to turn', () => {
    expect(orientFor(portrait, 3000, 2000)).toEqual({ params: { paper: 'a3', orientation: 'landscape', printerSettings: 'hex' }, turned: true, orientation: 'landscape' });
  });
  it('leaves matching or square images alone, driver settings included', () => {
    expect(orientFor(portrait, 2000, 3000)).toEqual({ params: portrait, turned: false, orientation: 'portrait' });
    expect(orientFor(portrait, 2000, 2000).turned).toBe(false);
    expect(orientFor({ paper: 'a4' }, 2000, 3000).turned).toBe(false);
  });
});

describe('sizeFromName', () => {
  it('reads A0-A6 as a whole word, variant before title', () => {
    expect(sizeFromName('A3')).toBe('a3');
    expect(sizeFromName('a4 matte')).toBe('a4');
    expect(sizeFromName('Poster (A2)')).toBe('a2');
    expect(sizeFromName('', 'Kyoto A5')).toBe('a5');
    expect(sizeFromName('A4', 'Kyoto A3 series')).toBe('a4');
  });
  it('ignores what only looks like a size', () => {
    expect(sizeFromName('A3+')).toBeNull();
    expect(sizeFromName('A7')).toBeNull();
    expect(sizeFromName('A30')).toBeNull();
    expect(sizeFromName('Kafka3')).toBeNull();
    expect(sizeFromName('Large', 'Sunset')).toBeNull();
  });
});

describe('paper sizes', () => {
  it('names A3-A5 as PhotoCraft does and gives other A sizes in points', () => {
    expect(paperParam('A4')).toBe('a4');
    expect(paperParam('a2')).toEqual([1190.55, 1683.78]);
    expect(paperParam('a6')).toEqual([297.64, 419.53]);
  });
  it('recognises a size from its points either way round, and leaves custom sizes alone', () => {
    expect(paperName([1190.55, 1683.78])).toBe('a2');
    expect(paperName([1683.78, 1190.55])).toBe('a2');
    expect(paperName('A3')).toBe('a3');
    expect(paperName([500, 700])).toBeNull();
    expect(paperName(undefined)).toBeNull();
  });
});

describe('settingsFor', () => {
  const a3 = { printer: 'Canon PRO-1000 series', paper: 'a3', orientation: 'portrait', printerSettings: 'abcd', center: true };
  it('copies everything to the same size and to items without a size', () => {
    expect(settingsFor(a3, 'a3', 'a3')).toEqual(a3);
    expect(settingsFor(a3, 'a3', null)).toEqual(a3);
  });
  it('keeps the target paper, driver settings included, for another size', () => {
    expect(settingsFor(a3, 'a3', 'a2')).toEqual({ ...a3, paper: [1190.55, 1683.78] });
    expect(settingsFor(a3, null, 'a4')).toEqual({ ...a3, paper: 'a4' });
  });
});

describe('paperMm', () => {
  it('reads names and points', () => {
    expect(paperMm('a4')).toEqual([210, 297]);
    expect(paperMm('A3')).toEqual([297, 420]);
    expect(paperMm('letter')).toEqual([215.9, 279.4]);
    expect(paperMm(paperParam('a2'))).toEqual([420, 594]);
    expect(paperMm([842.29, 1191.14])).toEqual([297.1, 420.2]);
  });
  it('is null for anything else', () => {
    expect(paperMm('b5')).toBeNull();
    expect(paperMm([0, 10])).toBeNull();
    expect(paperMm(undefined)).toBeNull();
  });
});

describe('effectiveParams', () => {
  const global = { printer: 'Canon PRO-1000 series', paper: 'a3', orientation: 'portrait', printerSettings: 'abcd', scaleToFit: true };
  const link = { file: 'x.png', params: { printer: 'Other', paper: 'a5', orientation: 'landscape' } };
  it('uses the global settings with the size from the name and the item orientation', () => {
    expect(effectiveParams(link, global, 'a4')).toEqual({ ...global, paper: 'a4', orientation: 'landscape' });
  });
  it('falls back to the item paper, then the global paper and orientation', () => {
    expect(effectiveParams(link, global, null)).toEqual({ ...global, paper: 'a5', orientation: 'landscape' });
    expect(effectiveParams(undefined, global, null)).toEqual(global);
  });
  it('keeps an item with its own settings, and every item without global settings', () => {
    expect(effectiveParams({ ...link, own: true }, global, 'a4')).toBe(link.params);
    expect(effectiveParams(link, null, 'a4')).toBe(link.params);
    expect(effectiveParams(undefined, null, 'a4')).toBeNull();
  });
});

describe('targetFor', () => {
  it("uses the item's own target, else its size's, else the main one", () => {
    expect(targetFor(7, 'a2', 5, { a2: 2 })).toBe(7);
    expect(targetFor(0, 'a2', 5, { a2: 2 })).toBe(0); // 0 is a target, not "unset"
    expect(targetFor(undefined, 'a2', 5, { a2: 2, a4: 0 })).toBe(2);
    expect(targetFor(undefined, 'a4', 5, { a2: 2, a4: 0 })).toBe(0);
    expect(targetFor(undefined, 'a3', 5, { a2: 2 })).toBe(5);
    expect(targetFor(undefined, null, 5, { a2: 2 })).toBe(5);
    expect(targetFor(undefined, 'a2', 5, undefined)).toBe(5);
  });
});

describe('printSizeMm and scaleForMm', () => {
  // An A3 page at 300 ppi: 3508 x 4961 px.
  const a3 = { width: 3508, height: 4961, resolution: 300 };
  it('prints pixels / resolution inches, times the scale', () => {
    expect(printSizeMm(a3, 100).map(Math.round)).toEqual([297, 420]);
    expect(printSizeMm(a3, 50).map(Math.round)).toEqual([149, 210]);
    expect(printSizeMm({ width: 720, height: 360, resolution: 72 }, 100)).toEqual([254, 127]);
  });
  it('gives the scale for a size, and back', () => {
    expect(scaleForMm(3508, 300, 297)).toBeCloseTo(99.99, 1);
    const s = scaleForMm(3508, 300, 200);
    expect(printSizeMm(a3, s)[0]).toBeCloseTo(200, 6);
  });
});

describe('effectiveParams with overrides', () => {
  const global = { printer: 'P', paper: 'a3', orientation: 'portrait', scaleToFit: true, center: true };
  const link = { file: 'x.png', params: { orientation: 'landscape' }, overrides: { paper: 'a4', scaleToFit: false, scale: 80 } };
  it('puts the item overrides over the name paper and image orientation', () => {
    expect(effectiveParams(link, global, 'a2')).toEqual({ ...global, paper: 'a4', orientation: 'landscape', scaleToFit: false, scale: 80 });
    expect(effectiveParams({ ...link, overrides: { orientation: 'portrait' } }, global, 'a2')).toMatchObject({ paper: [1190.55, 1683.78], orientation: 'portrait' });
  });
  it('leaves the overrides out on request, and for items with their own settings', () => {
    expect(effectiveParams(link, global, 'a2', false)).toMatchObject({ paper: [1190.55, 1683.78], scaleToFit: true });
    expect(effectiveParams({ ...link, own: true }, global, 'a2')).toBe(link.params);
  });
});

describe('paperNeeds', () => {
  it('counts one sheet per copy, per size', () => {
    expect(paperNeeds([{ key: 'a', size: 'a3', copies: 3 }, { key: 'b', size: 'a3', copies: 2 }, { key: 'c', size: 'a4', copies: 1 }, { key: 'd', size: 'a2', copies: 0 }])).toEqual({ a3: 5, a4: 1 });
  });
});

describe('fitToStock', () => {
  const items = [
    { key: 'kyoto', size: 'a3', copies: 6 },
    { key: 'sunset', size: 'a3', copies: 3 },
    { key: 'wave', size: 'a3', copies: 1 },
    { key: 'small', size: 'a4', copies: 4 },
  ];
  it('shares the sheets in proportion to what each item wanted', () => {
    // 10 wanted, 5 sheets: 3, 1.5, 0.5 -> 3, then the halves: the bigger order first.
    expect(fitToStock(items, { a3: 5 })).toEqual({ kyoto: 3, sunset: 2, wave: 0, small: 4 });
    expect(fitToStock(items, { a3: 7 })).toEqual({ kyoto: 4, sunset: 2, wave: 1, small: 4 });
  });
  it('never uses more sheets than there are', () => {
    for (let sheets = 0; sheets <= 10; sheets++) {
      const fit = fitToStock(items, { a3: sheets });
      expect(fit.kyoto! + fit.sunset! + fit.wave!).toBe(sheets);
    }
  });
  it('leaves sizes with enough paper, or without a stock figure, as they are', () => {
    expect(fitToStock(items, { a3: 10, a4: 99 })).toEqual({ kyoto: 6, sunset: 3, wave: 1, small: 4 });
    expect(fitToStock(items, {})).toEqual({ kyoto: 6, sunset: 3, wave: 1, small: 4 });
    expect(fitToStock(items, { a4: -2 })).toMatchObject({ small: 0 });
  });
});

describe('poissonTail', () => {
  it('is the chance demand reaches n', () => {
    expect(poissonTail(2, 0)).toBe(1);
    expect(poissonTail(2, 1)).toBeCloseTo(1 - Math.exp(-2), 10);
    expect(poissonTail(2, 2)).toBeCloseTo(1 - 3 * Math.exp(-2), 10);
    expect(poissonTail(0, 1)).toBe(0);
    expect(poissonTail(400, 380)).toBeGreaterThan(0.8); // no underflow with a large mean
  });
});

describe('smartFit', () => {
  const item = (key: string, copies: number, onHand: number, mean: number | null, price = 30) => ({ key, size: 'a3', copies, onHand, mean, price });
  it('gives the sheets to the copies most likely to sell', () => {
    // Kyoto sells ~6 and has none; Sunset sells ~1 and has 2 already. 4 sheets: all Kyoto.
    const { counts } = smartFit([item('kyoto', 6, 0, 6), item('sunset', 3, 2, 1)], { a3: 4 });
    expect(counts).toEqual({ kyoto: 4, sunset: 0 });
  });
  it('weighs the price: a dearer print wins a sheet at the same chance', () => {
    const { counts } = smartFit([item('cheap', 2, 0, 3, 20), item('dear', 2, 0, 3, 60)], { a3: 2 });
    expect(counts).toEqual({ cheap: 0, dear: 2 });
  });
  it('never gives more than an item asked for, nor more sheets than there are', () => {
    const items = [item('a', 2, 0, 50), item('b', 5, 0, 1), item('c', 4, 3, null)];
    for (let sheets = 0; sheets <= 11; sheets++) {
      const { counts } = smartFit(items, { a3: sheets });
      expect(counts.a!).toBeLessThanOrEqual(2);
      expect(counts.a! + counts.b! + counts.c!).toBe(Math.min(sheets, 11));
    }
  });
  it('leaves sizes with enough paper alone and says what the fit should sell', () => {
    expect(smartFit([item('a', 2, 0, 3)], { a3: 5 }).counts).toEqual({ a: 2 });
    const { gain } = smartFit([item('a', 3, 0, 1), item('b', 3, 0, 1)], { a3: 2 });
    expect(gain.a3!.units).toBeCloseTo(2 * (1 - Math.exp(-1)), 6);
    expect(gain.a3!.value).toBeCloseTo(60 * (1 - Math.exp(-1)), 6);
  });
});
