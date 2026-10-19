import { describe, expect, it } from 'vitest';
import { orientFor, paperName, paperParam, settingsFor, sizeFromName } from './shared.js';

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
  it('keeps the target paper and drops the driver settings for another size', () => {
    expect(settingsFor(a3, 'a3', 'a2')).toEqual({ printer: 'Canon PRO-1000 series', paper: [1190.55, 1683.78], orientation: 'portrait', center: true });
    expect(settingsFor(a3, null, 'a4')).toEqual({ printer: 'Canon PRO-1000 series', paper: 'a4', orientation: 'portrait', center: true });
  });
});
