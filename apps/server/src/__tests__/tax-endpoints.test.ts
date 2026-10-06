import { describe, expect, it } from 'vitest';
import { effectiveValues, endpointProblem } from '../modules/tax/config';

/**
 * The integration addresses are typed by the account and fetched by the
 * server with the account's keys: only the providers' own hosts, or the
 * server could be pointed at its own network.
 */
describe('integration addresses', () => {
  it('accept the providers', () => {
    for (const [k, v] of [
      ['LEXWARE_API_URL', 'https://api.lexoffice.io/v1'],
      ['MYPOS_GATEWAY_URL', 'https://demo-api-gateway.mypos.com'],
      ['SUMUP_API_URL', 'https://api.sumup.com'],
      ['SHOPIFY_SHOP', 'my-store.myshopify.com'],
      ['SHOPIFY_API_VERSION', '2024-10'],
    ] as const)
      expect(endpointProblem(k, v), v).toBeNull();
  });

  it('refuse anything else', () => {
    for (const [k, v] of [
      ['LEXWARE_API_URL', 'http://169.254.169.254/latest/meta-data'],
      ['LEXWARE_API_URL', 'https://api.lexoffice.io.evil.com/v1'],
      ['LEXWARE_API_URL', 'https://user@api.lexoffice.io/v1'],
      ['SUMUP_API_URL', 'http://api.sumup.com'],
      ['MYPOS_GATEWAY_URL', 'https://localhost:8080'],
      ['SHOPIFY_SHOP', 'localhost:3000/admin#.myshopify.com'],
      ['SHOPIFY_SHOP', '10.0.0.1'],
      ['SHOPIFY_API_VERSION', '../../x'],
    ] as const)
      expect(endpointProblem(k, v), v).not.toBeNull();
  });

  it('ignore a bad address saved before the check existed', () => {
    const values = effectiveValues({ values: { SUMUP_API_URL: 'http://127.0.0.1:9000', SUMUP_API_KEY: 'k' }, enabled: {} });
    expect(values.SUMUP_API_URL).toBeUndefined();
    expect(values.SUMUP_API_KEY).toBe('k');
  });
});
