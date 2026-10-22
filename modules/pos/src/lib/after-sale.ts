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

/** Where a receipt's print job stands, for the print button's label. */
export type PrintState = 'idle' | 'printing' | 'printed' | 'failed';

export const AfterSalePanel = (ui as Record<string, unknown>).AfterSalePanel as Component | undefined;
export const QrCode = (ui as Record<string, unknown>).QrCode as Component | undefined;

/**
 * The VAT snapshot for a sale at `eventId`: the event's country and settings,
 * the booth's exemptions and each line's product tax class. None on a shell
 * whose @zollify/shared predates VAT, or with no event to say where the sale
 * happened.
 */
export function saleTaxFor(eventId: string | null, productIds: string[]): shared.SaleTax | undefined {
  const resolve = (shared as Record<string, unknown>).resolveEventVat as typeof shared.resolveEventVat | undefined;
  const snapshot = (shared as Record<string, unknown>).saleTaxFor as typeof shared.saleTaxFor | undefined;
  const event = eventId ? sdk().data.events.get(eventId) : undefined;
  if (!resolve || !snapshot || !event) return undefined;
  const resolved = resolve(event, sdk().account()?.profile);
  // Charging with no rate known (a country missing from the table, and none
  // set on the event) records nothing rather than a made-up 0%.
  if (!resolved.exempt && resolved.standard == null) return undefined;
  return snapshot(resolved, productIds.map((id) => sdk().data.products.get(id)?.taxClass));
}

/** A fresh receipt token, or none on a shell that predates online receipts. */
export function mintReceiptToken(): string | undefined {
  const mint = (shared as Record<string, unknown>).newReceiptToken as (() => string) | undefined;
  return mint?.();
}

/** The receipt link as a printable QR (base64 PNG, paper width), or none. */
export async function receiptQrPng(token: string | undefined): Promise<string | undefined> {
  const url = receiptUrl(token);
  const raster = (ui as Record<string, unknown>).qrPngBase64 as ((value: string) => Promise<string>) | undefined;
  if (!url || !raster) return undefined;
  return raster(url).catch(() => undefined);
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

/** A sale line's link (`/p/...`) as a full address, or none on a shell that cannot say where its server is. */
export function lineLinkUrl(path: string): string | undefined {
  const d = display();
  return d.publicUrl ? d.publicUrl(path) : undefined;
}

/**
 * The pages a sale's lines point the customer to - a commission to follow,
 * say - with the full address for each, for the receipt to print or show.
 * None on a cancelled sale, or a shell that predates them.
 */
export function saleLineLinks(tx: Pick<shared.Transaction, 'items' | 'revertedAt'>): { label: string; url: string }[] {
  const of = (shared as Record<string, unknown>).receiptLinksOf as typeof shared.receiptLinksOf | undefined;
  if (!of || tx.revertedAt) return [];
  return of(tx.items).flatMap((l) => {
    const url = lineLinkUrl(l.path);
    return url ? [{ label: l.label, url }] : [];
  });
}

/** The same links as printable QR codes (base64 PNG); a code that fails to render is left out. */
export async function lineLinkQrs(links: { label: string; url: string }[]): Promise<{ label: string; qrB64: string }[]> {
  const raster = (ui as Record<string, unknown>).qrPngBase64 as ((value: string) => Promise<string>) | undefined;
  if (!raster) return [];
  const made = await Promise.all(links.map((l) => raster(l.url).then((qrB64) => ({ label: l.label, qrB64 }), () => null)));
  return made.filter((m): m is { label: string; qrB64: string } => m !== null);
}
