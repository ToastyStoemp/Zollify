import { describe, expect, it } from 'vitest';
import { parseWalletText, toAmount, walletId } from '../wallet';

/**
 * The notification wording is a guess until real examples are in: each case below is one shape
 * a bank or Google Wallet might print. Add the real ones as they turn up, with what they should read as.
 */
describe('reading a payment out of a Wallet notification', () => {
  it.each([
    ['You paid €12.50 at Bäckerei Stern with your card ending in 4242', { amount: 12.5, currency: 'EUR', merchant: 'Bäckerei Stern', last4: '4242' }],
    ['Zahlung von 12,50 € bei Bäckerei Stern mit Karte •••• 4242', { amount: 12.5, currency: 'EUR', merchant: 'Bäckerei Stern', last4: '4242' }],
    ['EUR 1.234,50 at Ink Supplies GmbH · ending 0001', { amount: 1234.5, currency: 'EUR', merchant: 'Ink Supplies GmbH', last4: '0001' }],
    ['CHF 40.00 at Lidl. Card ending in 9999', { amount: 40, currency: 'CHF', merchant: 'Lidl', last4: '9999' }],
    ['Payment of 100 SEK at Stockholm Pins', { amount: 100, currency: 'SEK', merchant: 'Stockholm Pins', last4: '' }],
    ['$5 at Coffee Shop', { amount: 5, currency: 'USD', merchant: 'Coffee Shop', last4: '' }],
  ])('%s', (text, expected) => {
    expect(parseWalletText(text)).toEqual(expected);
  });

  it('is not a payment when there is no amount', () => {
    expect(parseWalletText('Your card was added to Google Wallet')).toBeNull();
    expect(parseWalletText('Wallet is updating')).toBeNull();
  });

  it('is not a payment for a zero amount', () => {
    expect(parseWalletText('€0.00 at Free Stall')).toBeNull();
  });
});

describe('amounts', () => {
  it('reads both decimal and thousands marks', () => {
    expect(toAmount('12.50')).toBe(12.5);
    expect(toAmount('12,50')).toBe(12.5);
    expect(toAmount('1.234,50')).toBe(1234.5);
    expect(toAmount('1,234.50')).toBe(1234.5);
    expect(toAmount('1.234')).toBe(1234);
    expect(toAmount('100')).toBe(100);
  });
});

describe('an id for a notice', () => {
  it('is the same for the same notice, and safe for the server', () => {
    const n = { key: '0|com.google.android.apps.walletnfcrel|123|null|10123', at: 1793092203000, text: 'x' };
    expect(walletId(n)).toBe(walletId({ ...n, text: 'changed text' }));
    expect(walletId(n)).toMatch(/^wallet-[A-Za-z0-9-]{8,80}$/);
  });
});
