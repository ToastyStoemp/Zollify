import type { EventOverlay, PublicEvent, PublicEventsConfig } from '@zollify/shared';
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
};
