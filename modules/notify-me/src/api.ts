import type { NewsInput, NotifyKind, NotifySettings, Subscriber } from '@zollify/shared';
import { sdk } from './runtime';

/** Typed wrapper over this module's server half at `/api/m/notify-me/…`. */

export interface Overview {
  settings: NotifySettings;
  mailEnabled: boolean;
  /** The public page, once the settings give it an address. */
  publicUrl: string | null;
  counts: { live: number; unconfirmed: number; byKind: Record<NotifyKind, number> };
}

export interface SubscriberView extends Subscriber {
  /** Titles of the items they asked about. */
  products: string[];
}

export interface NewsItem extends NewsInput {
  id: string;
  recipients: number;
  sent: number;
  createdAt: number;
}

export const api = {
  overview: () => sdk().http.get<Overview>('settings'),
  saveSettings: (s: NotifySettings) => sdk().http.put<Overview>('settings', s),
  subscribers: (q = '') => sdk().http.get<{ subscribers: SubscriberView[] }>(`subscribers?q=${encodeURIComponent(q)}`),
  remove: (id: string) => sdk().http.del<{ ok: true }>(`subscribers/${id}`),
  news: () => sdk().http.get<{ news: NewsItem[] }>('news'),
  send: (n: NewsInput) => sdk().http.post<{ news: NewsItem }>('news', n),
};

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } } | null)?.body;
  if (body?.message) return body.message;
  return err instanceof Error && err.message ? err.message : fallback;
}
