import { describe, expect, it } from 'vitest';
import { cleanReceiptSocials, printableLink, receiptFooterLinks } from '../receipt-socials';

describe('receipt socials', () => {
  it('trims, canonicalises handles and defaults the toggles off', () => {
    const s = cleanReceiptSocials({ webstore: '  https://shop.example.com  ', instagram: '@booth', tiktok: 'booth.art' });
    expect(s.webstore).toBe('https://shop.example.com/');
    expect(s.instagram).toBe('https://www.instagram.com/booth');
    expect(s.tiktok).toBe('https://www.tiktok.com/@booth.art');
    expect(s.showOnPrint).toBe(false);
    expect(s.showEvents).toBe(false);
  });

  it('rejects other schemes, logins, spaces and long values', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,AAAA', 'http://a.example.com', 'https://u:p@a.example.com', 'https://a.example.com/a b', 'https://' + 'a'.repeat(200) + '.com']) {
      expect(() => cleanReceiptSocials({ facebook: bad }), bad).toThrow();
    }
    // A bare handle is only understood where it is canonical.
    expect(() => cleanReceiptSocials({ youtube: '@booth' })).toThrow();
  });

  it('gives the other link a label, and drops the label without a link', () => {
    expect(cleanReceiptSocials({ otherUrl: 'https://n.example.com' }).otherLabel).toBe('More');
    expect(cleanReceiptSocials({ otherLabel: 'Lonely' }).otherLabel).toBe('');
  });

  it('lists only what is set, in order, and shortens links for paper', () => {
    const links = receiptFooterLinks(cleanReceiptSocials({ instagram: 'booth', webstore: 'https://shop.example.com' }));
    expect(links.map((l) => l.label)).toEqual(['Webstore', 'Instagram']);
    expect(printableLink(links[0]!.url)).toBe('shop.example.com');
  });
});
