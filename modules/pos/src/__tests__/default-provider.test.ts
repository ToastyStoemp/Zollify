import { describe, expect, it, vi } from 'vitest';

/** A Carbon starts on its own card reader; every other device on manual entry. */

let carbon = false;
vi.mock('../native/plugins', () => ({ hasNativePlugin: (name: string) => carbon && name === 'CarbonPayment' }));

const { defaultProviderId } = await import('../payments/registry');

describe('default card terminal', () => {
  it('is the on-device reader on a myPOS Carbon', () => {
    carbon = true;
    expect(defaultProviderId()).toBe('mypos-carbon');
  });
  it('is manual entry everywhere else', () => {
    carbon = false;
    expect(defaultProviderId()).toBe('manual');
  });
});
