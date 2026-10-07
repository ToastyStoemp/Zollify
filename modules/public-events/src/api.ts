import type { EventOverlay, StoredEventOverlay, PoolListing, PublicEvent, PublicEventsConfig } from '@zollify/shared';
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
  config: () => sdk().http.get<{ config: PublicEventsConfig; overlays: Record<string, StoredEventOverlay> }>('config'),
  saveConfig: (config: PublicEventsConfig) => sdk().http.put<{ config: PublicEventsConfig }>('config', config),
  saveOverlay: (eventId: string, overlay: EventOverlay) =>
    // Only the publishing fields; the server ignores the legacy booth keys a stored row may carry.
    sdk().http.put<{ overlay: EventOverlay }>(`overlay/${eventId}`, { igHandle: overlay.igHandle, hidden: overlay.hidden }),
  preview: () => sdk().http.get<Preview>('preview'),
  pool: {
    search: (params: Record<string, string>) =>
      sdk().http.get<{ listings: PoolListing[]; more: boolean }>(`pool/listings?${new URLSearchParams(params).toString()}`),
    settings: () => sdk().http.get<{ share: boolean }>('pool/settings'),
    setSharing: (share: boolean) => sdk().http.put<{ share: boolean }>('pool/settings', { share }),
    adopt: (listingId: string, eventId: string) =>
      sdk().http.post<{ ok: true }>(`pool/listings/${encodeURIComponent(listingId)}/adopt`, { eventId }),
    report: (listingId: string, reason: string, note: string) =>
      sdk().http.post<{ ok: true }>(`pool/listings/${encodeURIComponent(listingId)}/report`, { reason, note }),
  },
};
