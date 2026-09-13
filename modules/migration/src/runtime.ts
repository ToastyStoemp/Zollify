import type { Sdk } from '@boothly/sdk';

/** The module's SDK handle, captured during setup(). */
let current: Sdk | null = null;

export function setSdk(sdk: Sdk): void {
  current = sdk;
}

export function clearSdk(): void {
  current = null;
}

export function sdk(): Sdk {
  if (!current) throw new Error('Migration module used its SDK before setup() ran.');
  return current;
}
