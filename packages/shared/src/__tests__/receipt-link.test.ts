import { describe, expect, it } from 'vitest';
import { isReceiptToken, newReceiptToken, receiptLink } from '../receipt-link';

describe('receipt links', () => {
  it('mints 22-character url-safe tokens that never repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = newReceiptToken();
      expect(isReceiptToken(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(500);
  });

  it('keeps the token in the fragment, so it never reaches a server log', () => {
    const url = new URL(receiptLink('https://booth.example/', 'abcdefghijklmnopqrstuv'));
    expect(url.pathname).toBe('/p/pos/r');
    expect(url.hash).toBe('#abcdefghijklmnopqrstuv');
    expect(url.search).toBe('');
  });

  it('rejects anything that is not exactly a token', () => {
    for (const bad of ['', 'short', 'abcdefghijklmnopqrstuv=', 'abcdefghijklmnopqrstu/', 'x'.repeat(23), 42, null]) {
      expect(isReceiptToken(bad)).toBe(false);
    }
  });
});
