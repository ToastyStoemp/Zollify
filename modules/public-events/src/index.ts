import { defineModule, type Sdk } from '@zollify/sdk';
import type { EventOverlay } from '@zollify/shared';
import { migrateBoothToEvents } from './migrate';
import { clearSdk, setSdk } from './runtime';

/**
 * Public events - the client half.
 *
 * One screen: where the booth's events are published (a page, a widget for
 * the shop, a calendar feed, an Instagram bio), plus the per-event publishing
 * choices - Instagram handle, hidden from the page. Hall, booth number, link
 * and note belong to the event itself (Events → Edit → Booth). Everything
 * visitors see is rendered by the server half from the same events the booth
 * already keeps. A second screen, Find events, searches a pool other booths quick-add
 * from; accounts that agree (Settings, Event sharing) contribute their events to it.
 */
export default defineModule({
  id: 'public-events',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Public events',
  description: 'A "where to find us" page, a shop widget, a calendar feed and an Instagram bio from your events.',
  requires: ['events'],
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({
      path: '',
      name: 'index',
      title: 'Public events',
      component: () => import('./views/PublicEventsView.vue'),
    });
    sdk.nav.add({ routeName: 'index', group: 'events', label: 'Public page', icon: 'globe', order: 115 });
    // Booth facts moved onto the event record; copy any the old overlay still holds.
    void migrateBoothToEvents({
      overlays: async () => (await sdk.http.get<{ overlays: Record<string, EventOverlay> }>('config')).overlays,
      events: () => sdk.data.events.list(),
      upsert: (event) => sdk.data.events.upsert(event),
    });
    sdk.routes.add({
      path: 'find',
      name: 'find',
      title: 'Find events',
      component: () => import('./views/FindEventsView.vue'),
    });
    sdk.nav.add({ routeName: 'find', group: 'events', label: 'Find events', icon: 'calendar', order: 116 });
    sdk.settings.panel({
      id: 'event-sharing',
      label: 'Event sharing',
      component: () => import('./views/SharingPanel.vue'),
      minRole: 'admin',
      order: 115,
    });
    sdk.log.info('public-events module ready');
  },

  teardown() {
    clearSdk();
  },
});
