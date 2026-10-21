import {
  GIFT_CARD_LOAD_REF_KIND,
  GIFT_CARD_MODULE_ID,
  GIFT_CARD_REDEEM_REF_KIND,
  round2,
  type GiftCard,
  type GiftCardCreateInput,
  type GiftCardMovement,
  type GiftCardPeriodRow,
  type GiftCardSettings,
  type GiftCardState,
  type GiftCardTotals,
} from '@zollify/shared';
import { sdk } from './runtime';

/**
 * Typed wrapper over this module's server half. Requests reach
 * `/api/m/gift-cards/…`; the host roots them there, so nothing here can
 * address another module or another account.
 */

/** A card as the screens get it: the record, what is on it, and its state. The code is masked for staff in lists. */
export interface GiftCardView extends GiftCard, GiftCardTotals {
  state: GiftCardState;
}

export const api = {
  list: (q = '') => sdk().http.get<{ cards: GiftCardView[]; settings: GiftCardSettings }>(`cards?q=${encodeURIComponent(q)}`),
  lookup: (code: string) => sdk().http.get<GiftCardView>(`cards/lookup?code=${encodeURIComponent(code)}`),
  get: (id: string) => sdk().http.get<GiftCardView>(`cards/${id}`),
  create: (input: GiftCardCreateInput) => sdk().http.post<GiftCardView>('cards', input),
  grant: (input: GiftCardCreateInput) => sdk().http.post<GiftCardView>('cards/grant', input),
  saveNote: (id: string, note: string) => sdk().http.put<GiftCardView>(`cards/${id}`, { note }),
  void: (id: string) => sdk().http.post<GiftCardView>(`cards/${id}/void`),
  report: (from: number, to: number) => sdk().http.get<{ rows: GiftCardPeriodRow[] }>(`report?from=${from}&to=${to}`),
  settings: () => sdk().http.get<GiftCardSettings>('settings'),
  saveSettings: (s: GiftCardSettings) => sdk().http.put<GiftCardSettings>('settings', s),
};

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } } | null)?.body;
  if (body?.message) return body.message;
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * What this device has rung up for a card that the server has not yet seen
 * (an offline sale, say): loads add, redemptions take off. Sales the server
 * already counted are skipped by id, so nothing is counted twice.
 */
export function pendingOn(cardId: string, counted: GiftCardMovement[]): number {
  const known = new Set(counted.map((m) => m.saleId));
  let sum = 0;
  for (const tx of sdk().data.transactions.recent()) {
    if (tx.revertedAt || known.has(tx.id)) continue;
    for (const item of tx.items) {
      const ref = item.ref;
      if (!ref || ref.moduleId !== GIFT_CARD_MODULE_ID || ref.id !== cardId) continue;
      if (ref.kind !== GIFT_CARD_LOAD_REF_KIND && ref.kind !== GIFT_CARD_REDEEM_REF_KIND) continue;
      sum += item.baseLineTotal ?? item.lineTotal;
    }
  }
  return round2(sum);
}

/** The card's balance as this device knows it: the server's figure plus what it sold or took itself since. */
export const balanceHere = (c: GiftCardView): number => round2(Math.max(0, c.balance + pendingOn(c.id, c.movements)));
