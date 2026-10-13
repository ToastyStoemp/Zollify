import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_DELAY_MS, testTerminalProvider as t } from '../payments/test-terminal';

describe('test terminal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('approves after a moment with a test reference', async () => {
    const p = t.startPayment({ amount: 12.5, currency: 'EUR', reference: 's1' });
    await vi.advanceTimersByTimeAsync(TEST_DELAY_MS);
    expect(await p).toMatchObject({ approved: true, provider: 'test', cardBrand: 'test', txRef: expect.stringMatching(/^TEST-/) });
  });

  it('declines amounts ending in .01, so the declined path can be tried', async () => {
    const p = t.startPayment({ amount: 10.01, currency: 'EUR', reference: 's2' });
    await vi.advanceTimersByTimeAsync(TEST_DELAY_MS);
    expect(await p).toMatchObject({ approved: false, error: expect.stringMatching(/Declined/) });
  });

  it('can be cancelled while reading the card', async () => {
    const p = t.startPayment({ amount: 5, currency: 'EUR', reference: 's3' });
    await t.cancel();
    await vi.advanceTimersByTimeAsync(TEST_DELAY_MS);
    expect(await p).toMatchObject({ approved: false, error: 'Cancelled.' });
  });
});
