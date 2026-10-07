import type { EventOverlay, PoolListing, PoolShare, PublicEvent, PublicEventsConfig } from '@zollify/shared';
import { sdk } from './runtime';

/** Typed wrapper over this module's server half at `/api/m/public-events/…`. */

export interface Preview {
  published: boolean;
  /** Public base URL, or null until a slug is chosen. */
  base: string | null;
  upcoming: PublicEvent[];
  past: PublicEvent[];
  bio: string;
}

export const api = {
  config: () => sdk().http.get<{ config: PublicEventsConfig; overlays: Record<string, EventOverlay> }>('config'),
  saveConfig: (config: PublicEventsConfig) => sdk().http.put<{ config: PublicEventsConfig }>('config', config),
  saveOverlay: (eventId: string, overlay: EventOverlay) =>
    sdk().http.put<{ overlay: EventOverlay }>(`overlay/${eventId}`, overlay),
  preview: () => sdk().http.get<Preview>('preview'),
  pool: {
    search: (params: Record<string, string>) =>
      sdk().http.get<{ listings: PoolListing[]; more: boolean }>(`pool/listings?${new URLSearchParams(params).toString()}`),
    mine: () => sdk().http.get<{ shared: { eventId: string; displayName: string; listing: PoolListing }[] }>('pool/mine'),
    share: (share: Partial<PoolShare> & { eventId: string }) => sdk().http.put<{ listing: PoolListing }>('pool/share', share),
    withdraw: (eventId: string) => sdk().http.del<{ ok: true }>(`pool/share/${encodeURIComponent(eventId)}`),
    adopt: (listingId: string, eventId: string) =>
      sdk().http.post<{ ok: true }>(`pool/listings/${encodeURIComponent(listingId)}/adopt`, { eventId }),
    report: (listingId: string, reason: string, note: string) =>
      sdk().http.post<{ ok: true }>(`pool/listings/${encodeURIComponent(listingId)}/report`, { reason, note }),
  },
};
