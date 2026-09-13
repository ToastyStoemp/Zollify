import { maybeSdk } from '../runtime';

/**
 * Terminal diagnostics. Routed through the SDK logger so output is attributed
 * to the module, and deliberately never includes amounts tied to card data —
 * the provider name, currency and outcome are enough to debug a pairing.
 */
export function logDiagnostic(message: string): void {
  maybeSdk()?.log.info(message) ?? console.info('[zollify:pos]', message);
}
