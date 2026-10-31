import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Print stories - points of interest on a print's picture and a few lines on
 * the print, for story cards at the booth.
 *
 * Points use the Shopify theme's hotspot format (see engine/story.ts), so a
 * story copies into the product's `custom.hotspots` metafield and back.
 * Each product's story is its own synced setting, written by admins.
 */
export default defineModule({
  id: 'print-stories',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Print Stories',
  description: 'Points of interest on your prints and story cards for the booth, in the Shopify hotspot format.',
  requires: ['catalog'],
  // Synced settings only travel from admins; a helper's edits would stay on their phone.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Print stories', component: () => import('./views/StoriesView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'stock', label: 'Print stories', icon: 'message-square', order: 145 });
    sdk.log.info('print-stories module ready');
  },

  teardown() {
    clearSdk();
  },
});
