import type { Component } from 'vue';
import * as shared from '@zollify/shared';
import * as ui from '@zollify/ui';
import type { Sdk } from '@zollify/sdk';
import { sdk } from '../runtime';

/**
 * Online receipts and the post-sale screen, reached defensively.
 *
 * This bundle can be served to an app shell older than the feature: one whose
 * SDK has no `display.afterSale` and whose @zollify/ui has no QR components.
 * A named import of a missing export would stop the whole POS from loading
 * there, so they are looked up at runtime instead and the feature simply
 * stays off until the shell updates.
 */

type Display = Partial<Sdk['display']>;
const display = (): Display => sdk().display as Display;

export const AfterSalePanel = (ui as Record<string, unknown>).AfterSalePanel as Component | undefined;
export const QrCode = (ui as Record<string, unknown>).QrCode as Component | undefined;

/** A fresh receipt token, or none on a shell that predates online receipts. */
export function mintReceiptToken(): string | undefined {
  const mint = (shared as Record<string, unknown>).newReceiptToken as (() => string) | undefined;
  return mint?.();
}

export async function afterSalePrefs(): Promise<{ thankYou: boolean; receiptQr: boolean }> {
  const d = display();
  if (!d.afterSale || !AfterSalePanel) return { thankYou: false, receiptQr: false };
  return d.afterSale().catch(() => ({ thankYou: false, receiptQr: false }));
}

export function receiptUrl(token: string | undefined): string | undefined {
  const d = display();
  return token && d.receiptUrl ? d.receiptUrl(token) : undefined;
}
