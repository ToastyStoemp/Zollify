import { describe, expect, it } from 'vitest';
import type { ConsignmentLine, Consignor } from '@zollify/shared';
import { statementHtml } from '../statement-print';

const lotte: Consignor = {
  id: 'lotte',
  name: 'Lotte <Art>',
  email: '',
  commissionPct: 30,
  storeCommission: {},
  storeIds: ['zuid'],
  note: '',
  archived: false,
  iban: '',
  bic: '',
  vatId: 'BE0999.999.999',
  vatRegistered: true,
  selfBillingAgreedOn: null,
  linkedAccountName: null,
  linked: false,
  linkPending: false,
  createdAt: 0,
  updatedAt: 0,
};
const line = (at: number, gross: number, taxRate: number | null): ConsignmentLine => ({
  txId: `t${at}`,
  at,
  consignorId: 'lotte',
  storeId: 'zuid',
  productId: 'riso',
  variantId: null,
  title: 'Riso print',
  qty: 1,
  currency: 'EUR',
  gross,
  commissionPct: 30,
  commission: Math.round(gross * 30) / 100,
  artistShare: gross - Math.round(gross * 30) / 100,
  taxRate,
});
const base = {
  store: { name: 'Atelier Zuid', address: ['Kortrijksesteenweg 1', '9000 Gent', 'Belgium'], vatId: 'BE0123.456.789' },
  period: { from: '2026-10-01', to: '2026-10-31' },
  payouts: [],
  storeName: () => 'Atelier Zuid',
};
const oct = Date.UTC(2026, 9, 5, 12);

describe('printable statement', () => {
  it('says it is provisional, shows the split incl. VAT and the net/VAT lines for a registered artist', () => {
    const html = statementHtml({
      ...base,
      artist: lotte,
      lines: [line(oct, 35, 6), line(oct + 1, 35, 6)],
      totals: [{ currency: 'EUR', units: 2, gross: 70, commission: 21, artistShare: 49, paid: 10, rent: 0, fees: 0, cardFees: 0, balance: 39 }],
    });
    expect(html).toContain('Provisional statement - not an invoice');
    // Names are escaped, never trusted.
    expect(html).toContain('Lotte &lt;Art&gt;');
    expect(html).toContain('Commission 30%');
    expect(html).toContain('EUR 49.00');
    // 49.00 at 6%: net 46.23, VAT 2.77.
    expect(html).toContain('<td>6%</td><td class="n">EUR 46.23</td><td class="n">EUR 2.77</td>');
    expect(html).toContain('Owed to you today');
    expect(html).toContain('EUR 39.00');
    expect(html).toContain('EUR 10.00 already paid');
  });

  it('leaves the VAT table out for an artist who is not registered, and copes with nothing sold', () => {
    const plain = statementHtml({ ...base, artist: { ...lotte, vatRegistered: false, vatId: '' }, lines: [line(oct, 35, 6)], totals: [] });
    expect(plain).not.toContain('VAT in your share');
    expect(plain).toContain('incl. VAT');
    const empty = statementHtml({ ...base, artist: lotte, lines: [], totals: [] });
    expect(empty).toContain('Nothing sold or paid yet.');
  });
});
