import { describe, expect, it } from 'vitest';
import { RECEIPT_LINKS_MAX, isReceiptLineLink, isReceiptToken, newReceiptToken, receiptLink, receiptLinksOf } from '../receipt-link';

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

describe('links a sale line puts on the receipt', () => {
  const ok = { label: 'Follow your commission', path: '/p/commissions/abcdefghijklmnopqrstuvwx' };

  it('takes a public page of this server', () => {
    expect(isReceiptLineLink(ok)).toBe(true);
  });

  it('refuses anything that could send the customer elsewhere', () => {
    for (const path of ['https://evil.example/p/x', '//evil.example/p/x', '/api/admin', '/p/', '/p/../api/admin', '/p/x/./y', '/p/x?y=1', '/p/x#y', 'p/x', `/p/${'a'.repeat(200)}`]) {
      expect(isReceiptLineLink({ label: 'Go', path })).toBe(false);
    }
  });

  it('refuses an empty, overlong or control-character label', () => {
    for (const label of ['', '   ', 'x'.repeat(61), 'Line\nbreak']) expect(isReceiptLineLink({ label, path: ok.path })).toBe(false);
    expect(isReceiptLineLink(null)).toBe(false);
    expect(isReceiptLineLink('/p/x')).toBe(false);
  });

  it('keeps each page once, the valid ones only, and only a few', () => {
    const items = [{ link: ok }, { link: ok }, {}, { link: { label: 'x', path: 'https://evil.example' } }, ...[1, 2, 3, 4].map((n) => ({ link: { label: ` Page ${n} `, path: `/p/x/${n}` } }))];
    const out = receiptLinksOf(items);
    expect(out).toHaveLength(RECEIPT_LINKS_MAX);
    expect(out[0]).toEqual(ok);
    expect(out[1]).toEqual({ label: 'Page 1', path: '/p/x/1' });
  });
});
