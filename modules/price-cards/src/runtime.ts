import type { Sdk } from '@boothly/sdk';

let current: Sdk | null = null;

export function setSdk(sdk: Sdk): void { current = sdk; }
export function clearSdk(): void { current = null; }
export function sdk(): Sdk {
  if (!current) throw new Error('Module used its SDK before setup() ran.');
  return current;
}
