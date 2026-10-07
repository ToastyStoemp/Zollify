import { describe, expect, it } from 'vitest';
import { legacyShortBarcode, matchesShortBarcode, shortBarcode } from '../short-barcode';

describe('shortBarcode', () => {
  it('is deterministic for the same inputs', () => {
    expect(shortBarcode('Enamel', 'p1', 'v1')).toBe(shortBarcode('Enamel', 'p1', 'v1'));
  });

  it('differs for different products or variants', () => {
    const base = shortBarcode('Enamel', 'p1', 'v1');
    expect(shortBarcode('Enamel', 'p2', 'v1')).not.toBe(base);
    expect(shortBarcode('Enamel', 'p1', 'v2')).not.toBe(base);
  });

  it('is much shorter than a typical SKU', () => {
    expect(shortBarcode('Enamel Pin', 'p1', 'v1').length).toBeLessThan('PN-2508-EP-COW-02'.length);
  });

  it('prefixes with the type\'s first letter, uppercased', () => {
    expect(shortBarcode('enamel', 'p1', 'v1').startsWith('E')).toBe(true);
  });

  it('falls back to "Other" when type is missing, matching every caller\'s own fallback', () => {
    expect(shortBarcode(undefined, 'p1', 'v1').startsWith('O')).toBe(true);
    expect(shortBarcode(undefined, 'p1', 'v1')).toBe(shortBarcode('Other', 'p1', 'v1'));
  });

  it('survives a type rename: only the cosmetic prefix changes', () => {
    expect(shortBarcode('Enamel', 'p1', 'v1').slice(1)).toBe(shortBarcode('Pins', 'p1', 'v1').slice(1));
    expect(matchesShortBarcode(shortBarcode('Enamel', 'p1', 'v1'), 'Pins', 'p1', 'v1')).toBe(true);
    expect(matchesShortBarcode(shortBarcode('Enamel', 'p1', 'v1').toLowerCase(), 'Enamel', 'p1', 'v1')).toBe(true);
    expect(matchesShortBarcode(shortBarcode('Enamel', 'p1', 'v1'), 'Enamel', 'p2', 'v1')).toBe(false);
  });

  it('still matches labels printed with the legacy type-hashed formula', () => {
    const legacy = legacyShortBarcode('Enamel', 'p1', 'v1');
    expect(legacy).not.toBe(shortBarcode('Enamel', 'p1', 'v1'));
    expect(matchesShortBarcode(legacy, 'Enamel', 'p1', 'v1')).toBe(true);
    expect(matchesShortBarcode(legacy, 'Enamel', 'p1', 'v2')).toBe(false);
  });
});
