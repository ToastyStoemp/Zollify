import type { Sdk } from '@zollify/sdk';

/**
 * The module's SDK handle, captured during setup() so views can reach core
 * data and config without each being handed the sdk as a prop.
 */
let current: Sdk | null = null;

export function setSdk(sdk: Sdk): void {
  current = sdk;
}

export function clearSdk(): void {
  current = null;
}

export function sdk(): Sdk {
  if (!current) throw new Error('Customs module used its SDK before setup() ran.');
  return current;
}

export function maybeSdk(): Sdk | null {
  return current;
}
