import type { Sdk } from '@zollify/sdk';

let current: Sdk | null = null;

export function setSdk(sdk: Sdk): void { current = sdk; }
export function clearSdk(): void { current = null; }
export function sdk(): Sdk {
  if (!current) throw new Error('Shopify sync used its SDK before setup() ran.');
  return current;
}
