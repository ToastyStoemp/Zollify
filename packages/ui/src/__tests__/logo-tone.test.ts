import { describe, expect, it } from 'vitest';
import { isDarkInk } from '../logo-tone';

/** n pixels of one RGBA colour. */
const px = (n: number, rgba: [number, number, number, number]): number[] => Array.from({ length: n }, () => rgba).flat();

describe('dark-ink logos', () => {
  it('spots black on transparent', () => {
    expect(isDarkInk([...px(30, [0, 0, 0, 255]), ...px(70, [0, 0, 0, 0])])).toBe(true);
  });
  it('leaves a logo on its own white background alone', () => {
    expect(isDarkInk([...px(30, [0, 0, 0, 255]), ...px(70, [255, 255, 255, 255])])).toBe(false);
  });
  it('leaves a coloured logo alone', () => {
    expect(isDarkInk([...px(30, [180, 20, 20, 255]), ...px(70, [0, 0, 0, 0])])).toBe(false);
  });
  it('leaves a white logo on transparent alone', () => {
    expect(isDarkInk([...px(30, [255, 255, 255, 255]), ...px(70, [0, 0, 0, 0])])).toBe(false);
  });
});
