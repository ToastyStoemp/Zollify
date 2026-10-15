import { describe, expect, it } from 'vitest';
import { eventsPageLegal, imprintLines, receiptLegal } from '../legal';

const artist = { companyName: 'Harbour Prints', fullName: 'Ada Lovelace', street: 'Kade 1', postCodeCity: '2000 Antwerpen', countryOfOrigin: 'Belgium', vatId: 'BE 0123.456.789' };

describe('legal block', () => {
  it('names the business, its address and VAT number - never a phone or email', () => {
    expect(imprintLines({ artist, accountName: 'acct' })).toEqual(['Harbour Prints', 'Ada Lovelace', 'Kade 1', '2000 Antwerpen', 'Belgium', 'VAT no. BE 0123.456.789']);
    expect(imprintLines({ artist: { ...artist, companyName: '', fullName: '', vatId: '' }, accountName: 'The Booth' })).toEqual(['The Booth', 'Kade 1', '2000 Antwerpen', 'Belgium']);
  });

  it('links the seller’s own pages when set, and says how long a receipt link lives', () => {
    const plain = receiptLegal({ artist, accountName: '', links: null }, 400);
    expect(plain.imprintUrl).toBeUndefined();
    expect(plain.operator).toBeUndefined();
    expect(plain.privacy.join(' ')).toContain('about 13 months');
    expect(plain.privacy.join(' ')).toContain('Harbour Prints');
    const linked = receiptLegal({ artist, accountName: '', links: { imprintUrl: 'https://x.example/imprint', privacyUrl: '' }, operator: ' Host GmbH, Berlin ' }, 30);
    expect(linked).toMatchObject({ imprintUrl: 'https://x.example/imprint', operator: 'Host GmbH, Berlin' });
    expect(linked.privacyUrl).toBeUndefined();
    expect(eventsPageLegal({ artist, accountName: '' }).privacy.join(' ')).toContain('calendar');
  });
});
