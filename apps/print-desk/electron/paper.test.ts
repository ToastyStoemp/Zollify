import { describe, expect, it } from 'vitest';
import { effectiveParams, orientFor, paperMm, paperName, paperParam, settingsFor, sizeFromName } from './shared.js';

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
