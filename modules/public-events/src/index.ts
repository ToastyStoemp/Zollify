import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Public events — the client half.
 *
 * One screen: where the booth's events are published (a page, a widget for
 * the shop, a calendar feed, an Instagram bio), plus the per-event extras
 * the event record itself does not carry — hall, booth number, a link.
 * Everything visitors see is rendered by the server half from the same
 * events the booth already keeps.
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
    sdk.log.info('public-events module ready');
  },

  teardown() {
    clearSdk();
  },
});
