import type { Sdk } from '@zollify/sdk';

/**
 * The module's SDK handle, captured during setup().
 *
 * The ported payment providers are plain module-scope singletons that were
 * written against app-wide imports. Rather than thread an sdk argument through
 * all seven, setup() parks it here. Anything reading it before setup has run is
 * a genuine ordering bug and says so.
 */
let current: Sdk | null = null;

export function setSdk(sdk: Sdk): void {
  current = sdk;
}

export function clearSdk(): void {
  current = null;
}

export function sdk(): Sdk {
  if (!current) throw new Error('POS module used its SDK before setup() ran.');
  return current;
}

export function maybeSdk(): Sdk | null {
  return current;
}
