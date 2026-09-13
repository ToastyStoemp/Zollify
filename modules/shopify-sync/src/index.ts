import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Shopify sync — the client face.
 *
 * The Admin API token lives only on the server half; this module never sees it
 * and never talks to Shopify directly. It sends the local catalogue for
 * matching and shows what came back for a person to confirm.
 */
export default defineModule({
  id: 'shopify-sync',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Shopify sync',
  description: 'Match the booth catalogue against a Shopify storefront.',
  requires: ['catalog'],
  // Connecting a storefront and rewriting its prices is an owner's decision.
  minRole: 'owner',

  setup(sdk: Sdk) {
    setSdk(sdk);

    sdk.routes.add({
      path: '',
      name: 'index',
      title: 'Shopify sync',
      component: () => import('./views/ShopifyView.vue'),
    });

    sdk.nav.add({ routeName: 'index', label: 'Shopify', icon: 'shopping-bag', order: 150 });

    sdk.settings.panel({
      id: 'connection',
      label: 'Shopify connection',
      component: () => import('./views/ConnectionSettings.vue'),
      minRole: 'owner',
      order: 150,
    });

    sdk.log.info('shopify-sync module ready');
  },

  teardown() {
    clearSdk();
  },
});
