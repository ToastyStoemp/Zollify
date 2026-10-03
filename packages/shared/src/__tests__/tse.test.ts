import { describe, expect, it } from 'vitest';
import type { Transaction, TxItem } from '../types';
import { TseDataError, kassenbelegData, tseQrPayload, type TseSignature } from '../tse';

/** Expected strings are the worked examples from the DSFinV-K 2.4 itself. */

const item = (lineTotal: number): TxItem => ({ pid: 'p', vid: null, title: 't', qty: 1, unitPrice: lineTotal, lineTotal });
type Sale = Parameters<typeof kassenbelegData>[0];
const sale = (extra: Partial<Transaction>): Sale => ({
  items: [item(100)],
  total: 100,
  currency: 'EUR',
  discounts: [],
  payments: [{ kind: 'cash', amount: 100 }],
  tax: { country: 'DE', exempt: false, rates: [19] },
  ...extra,
});

describe('kassenbelegData (processData, Kassenbeleg-V1)', () => {
  it('100 € at 19 %, paid cash', () => {
    expect(kassenbelegData(sale({}))).toBe('Beleg^100.00_0.00_0.00_0.00_0.00^100.00:Bar');
  });

  it('50 € at 19 % and 50 € at 7 %, paid by card', () => {
    const data = kassenbelegData(sale({ items: [item(50), item(50)], tax: { country: 'DE', exempt: false, rates: [19, 7] }, payments: [{ kind: 'card', amount: 100 }] }));
    expect(data).toBe('Beleg^50.00_50.00_0.00_0.00_0.00^100.00:Unbar');
  });

  it('accumulates split payments, cash first', () => {
    const data = kassenbelegData(sale({ payments: [{ kind: 'card', amount: 60 }, { kind: 'cash', amount: 40 }] }));
    expect(data).toBe('Beleg^100.00_0.00_0.00_0.00_0.00^40.00:Bar_60.00:Unbar');
  });

  it('puts a VAT-exempt (small business) sale in the 0 % slot', () => {
    const data = kassenbelegData(sale({ tax: { country: 'DE', exempt: true, rates: [null], note: '§ 19' } }));
    expect(data).toBe('Beleg^0.00_0.00_0.00_0.00_100.00^100.00:Bar');
  });

  it('signs what each line cost after discounts - the figures on the receipt', () => {
    const data = kassenbelegData(sale({
      items: [item(18), item(18)],
      total: 36,
      tax: { country: 'DE', exempt: false, rates: [19, 7] },
      asCharged: { listTotals: [20, 20], discounts: [{ name: 'Bundle', amount: 4 }] },
      payments: [{ kind: 'cash', amount: 36 }],
    }));
    expect(data).toBe('Beleg^18.00_18.00_0.00_0.00_0.00^36.00:Bar');
  });

  it('negates everything for the cancelling receipt of a reverted sale', () => {
    expect(kassenbelegData(sale({}), 'Beleg', -1)).toBe('Beleg^-100.00_0.00_0.00_0.00_0.00^-100.00:Bar');
  });

  it('closes an abandoned cart as AVBelegabbruch with nothing in it', () => {
    expect(kassenbelegData(sale({}), 'AVBelegabbruch')).toBe('AVBelegabbruch^0.00_0.00_0.00_0.00_0.00^');
  });

  it('refuses what a German TSE cannot describe, rather than signing something false', () => {
    expect(() => kassenbelegData(sale({ tax: { country: 'IT', exempt: false, rates: [22] } }))).toThrow(TseDataError);
    expect(() => kassenbelegData(sale({ tax: undefined }))).toThrow(TseDataError);
    expect(() => kassenbelegData(sale({ currency: 'CHF' }))).toThrow(TseDataError);
  });
});

describe('tseQrPayload (receipt QR, V0)', () => {
  it('matches the DSFinV-K example field for field', () => {
    const sig: TseSignature = {
      clientId: 'AMA-2642',
      serial: 'x',
      transactionNumber: 13,
      signatureCounter: 44131,
      start: '2019-11-22T11:29:48.000Z',
      finish: '2019-11-22T11:29:49.000Z',
      algorithm: 'ecdsa-plain-SHA384',
      timeFormat: 'unixTime',
      signature: 'K8zsZ6Nj',
      publicKey: 'BBXNYQEr',
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^4.05_3.00_0.00_0.00_0.00^7.05:Bar',
    };
    expect(tseQrPayload(sig)).toBe(
      'V0;AMA-2642;Kassenbeleg-V1;Beleg^4.05_3.00_0.00_0.00_0.00^7.05:Bar;13;44131;2019-11-22T11:29:48.000Z;2019-11-22T11:29:49.000Z;ecdsa-plain-SHA384;unixTime;K8zsZ6Nj;BBXNYQEr',
    );
  });
});
