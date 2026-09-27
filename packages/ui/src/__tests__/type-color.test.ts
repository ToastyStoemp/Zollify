import { describe, expect, it } from 'vitest';
import { typeColor } from '../type-color';

describe('typeColor', () => {
  it('is stable for the same type', () => {
    expect(typeColor('Art Print')).toBe(typeColor('Art Print'));
  });

  it('lightens for dark mode so it still reads against a dark surface', () => {
    const light = typeColor('Art Print', false);
    const dark = typeColor('Art Print', true);

    expect(light).toContain('48%');
    expect(dark).toContain('72%');
    // Same type, same hue - only the tone changes with theme.
    expect(light.match(/hsl\((\d+)/)?.[1]).toBe(dark.match(/hsl\((\d+)/)?.[1]);
  });
});
