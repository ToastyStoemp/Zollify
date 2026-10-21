import { z } from 'zod';

/**
 * Notify me: a customer at the booth or in the store scans a code and asks
 * to hear from the business - when an item is back in stock, when the
 * webstore has news, when the business is next at an event near them. Pure
 * rules here, shared by the public page's server half and the owner's
 * screens.
 *
 * It is consent-based mail to people who are not customers of record, so
 * every address is confirmed before anything is sent, every mail carries
 * its own leave link, and addresses are erased when they stop being
 * useful (see the server's sweep).
 */

export const NOTIFY_KINDS = ['restock', 'events', 'news'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = {
  restock: 'An item is back in stock',
  events: 'Next event near you',
  news: 'Webstore news',
};

/** The public address part: `/p/notify-me/<slug>`. Lower case, like the events page. */
export const NOTIFY_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
export const NOTIFY_PUBLIC_PATH = '/p/notify-me/';
/** 24 random bytes, base64url: the confirm and leave links. */
export const NOTIFY_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export const NotifySettingsSchema = z.object({
  /** The public address; empty = the page is off. */
  slug: z.union([z.literal(''), z.string().regex(NOTIFY_SLUG_RE, 'Lower-case letters, digits and dashes, 3 to 40 characters.')]).default(''),
  /** What the page offers. */
  kinds: z.array(z.enum(NOTIFY_KINDS)).default([...NOTIFY_KINDS]),
  /** A line the page shows under the business name. */
  intro: z.string().trim().max(300).default(''),
  /** The webstore link offered on the page and in news mails. */
  storeUrl: z.union([z.literal(''), z.string().trim().url().max(300)]).default(''),
  /** Days before the same item is announced to the same person again. */
  restockCooldownDays: z.number().int().min(1).max(365).default(30),
  /** Months after which a subscriber who heard nothing is erased; 0 = keep. */
  eraseAfterMonths: z.number().int().min(0).max(120).default(24),
});
export type NotifySettings = z.infer<typeof NotifySettingsSchema>;

export const SubscribeInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  kinds: z.array(z.enum(NOTIFY_KINDS)).min(1, 'Tick at least one.').max(3),
  /** For a restock: the item scanned, if any. */
  productId: z.string().max(80).default(''),
  /** For events: a country code, or empty for anywhere. */
  country: z.string().trim().toUpperCase().max(2).default(''),
  /** Honeypot: a bot fills it, a person never sees it. */
  website: z.string().max(200).default(''),
});
export type SubscribeInput = z.infer<typeof SubscribeInputSchema>;

export const NewsInputSchema = z.object({
  subject: z.string().trim().min(1, 'Give it a subject.').max(120),
  text: z.string().trim().min(1, 'Write something.').max(4000),
});
export type NewsInput = z.infer<typeof NewsInputSchema>;

export interface Subscriber {
  id: string;
  email: string;
  kinds: NotifyKind[];
  /** Items they want to hear about again; empty with `restock` means any item that comes back. */
  productIds: string[];
  /** Country code for event news; '' = anywhere. */
  country: string;
  /** Where they signed up: the generic page, a product's code, an event's. */
  source: string;
  createdAt: number;
  confirmedAt: number | null;
  unsubscribedAt: number | null;
  /** The last mail that went out to them. */
  lastSentAt: number | null;
}

/** "m···a@example.com": enough to recognise, not an address to copy. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const name = email.slice(0, at);
  return `${name[0]}${name.length > 2 ? '···' : ''}${name.length > 1 ? name[name.length - 1] : ''}@${email.slice(at + 1)}`;
}

/** Can be written to: confirmed and not gone. */
export const isLive = (s: Pick<Subscriber, 'confirmedAt' | 'unsubscribedAt'>): boolean => s.confirmedAt != null && s.unsubscribedAt == null;

/** Who hears that `productId` is back: restock subscribers who asked for it, or for anything, not told within the cooldown. */
export function restockRecipients(subscribers: Subscriber[], productId: string, told: (subscriberId: string) => number | null, cooldownDays: number, now = Date.now()): Subscriber[] {
  const limit = now - cooldownDays * 86_400_000;
  return subscribers.filter((s) => {
    if (!isLive(s) || !s.kinds.includes('restock')) return false;
    if (s.productIds.length && !s.productIds.includes(productId)) return false;
    const last = told(s.id);
    return last == null || last < limit;
  });
}

/** Who hears about an event in `country`: event subscribers for that country or for anywhere. */
export function eventRecipients(subscribers: Subscriber[], country: string): Subscriber[] {
  const code = country.trim().toUpperCase();
  return subscribers.filter((s) => isLive(s) && s.kinds.includes('events') && (!s.country || !code || s.country === code));
}

export const newsRecipients = (subscribers: Subscriber[]): Subscriber[] => subscribers.filter((s) => isLive(s) && s.kinds.includes('news'));

export type EraseReason = 'unconfirmed' | 'left' | 'silent';

/** Unconfirmed after a week, gone a month after leaving, or silent for the set months. */
export function eraseReason(s: Subscriber, eraseAfterMonths: number, now = Date.now()): EraseReason | null {
  const WEEK = 7 * 86_400_000;
  const MONTH = 30 * 86_400_000;
  if (s.confirmedAt == null) return now - s.createdAt > WEEK ? 'unconfirmed' : null;
  if (s.unsubscribedAt != null) return now - s.unsubscribedAt > MONTH ? 'left' : null;
  if (eraseAfterMonths > 0) {
    const since = Math.max(s.confirmedAt, s.lastSentAt ?? 0);
    if (now - since > eraseAfterMonths * MONTH) return 'silent';
  }
  return null;
}
