import { z } from 'zod';

/**
 * Webhooks: Zollify posting what happens to a chat (Discord, Slack) or any
 * other service. An account picks the events each webhook hears; store
 * owners and artists alike - an artist's account hears about their own work
 * in stores.
 *
 * Most events are the in-app notifications by category, so anything that
 * rings the bell can reach a chat too; sales and the summaries are their own.
 */
export const WEBHOOK_EVENTS = [
  { id: 'sale', label: 'Each sale', hint: 'Every sale rung up on your tills, as it syncs.' },
  { id: 'report.daily', label: 'Daily summary', hint: "Yesterday's sales, sent shortly after midnight." },
  { id: 'report.weekly', label: 'Weekly summary', hint: "Last week's sales, sent on Monday morning." },
  { id: 'consigned-sale', label: 'Your work sold in a store', hint: 'For artists: each sale of your items in a store you consign with.' },
  { id: 'planner', label: 'Rentals and setups', hint: 'Space rented or upgraded; setup moments scheduled, moved, cancelled, confirmed or declined.' },
  { id: 'stock', label: 'Restocks and packages', hint: 'An artist restocking, a package sent or received.' },
  { id: 'programme', label: 'Store events and workshops', hint: 'Artist of the month, workshops, sign-ups.' },
  { id: 'sharing', label: 'Shared items', hint: 'Items shared with a store, or shared by scanning a label.' },
  { id: 'discounts', label: 'Artist discounts', hint: 'An artist setting or ending a discount on their work, or a store ending one.' },
  { id: 'fees', label: 'Fees', hint: 'Fees charged, objected to or waived.' },
  { id: 'reports', label: 'Consignment reports', hint: 'A store report period closing.' },
  { id: 'other', label: 'Everything else from the bell', hint: 'Any other notification.' },
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]['id'];
const EVENT_IDS = WEBHOOK_EVENTS.map((e) => e.id) as [WebhookEvent, ...WebhookEvent[]];

export const WEBHOOK_FORMATS = ['discord', 'slack', 'json'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const WebhookInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().url().max(2000),
  format: z.enum(WEBHOOK_FORMATS),
  events: z.array(z.enum(EVENT_IDS)).min(1).max(EVENT_IDS.length),
  /** Where the summaries' days start and end. */
  timeZone: z.string().min(1).max(64).default('UTC'),
  enabled: z.boolean().default(true),
});
export type WebhookInput = z.infer<typeof WebhookInputSchema>;

export interface Webhook extends WebhookInput {
  id: string;
  /** For the JSON format: deliveries are signed with it (X-Zollify-Signature). */
  secret: string;
  createdAt: number;
  lastAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  /** Failed deliveries in a row; the webhook switches itself off after many. */
  failures: number;
}

/** What a delivery says, before it is shaped for Discord, Slack or JSON. */
export interface WebhookMessage {
  title: string;
  body?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  /** An accent: green for money in, amber for attention. */
  tone?: 'good' | 'warn' | 'info';
}

/** The format a URL most likely wants: Discord's and Slack's own webhook addresses are recognisable. */
export function guessWebhookFormat(url: string): WebhookFormat {
  if (/^https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(url)) return 'discord';
  if (/^https:\/\/hooks\.slack\.com\//i.test(url)) return 'slack';
  return 'json';
}
