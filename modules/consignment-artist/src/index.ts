import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * My stores - the artist's half of consignment. Stores that sell this
 * account's work invite it; once accepted, the artist shares items, restocks
 * or sends packages, answers setup times and follows their sales and payouts
 * there. The store owner's half is the separate "consignment" module.
 */
export default defineModule({
  id: 'consignment-artist',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'My stores',
  description: 'Consign your work in other people’s stores: accept their invites, share items, restock and follow your sales and payouts there.',
  requires: ['catalog'],
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'My stores', minRole: 'admin', component: () => import('./views/MyStoresView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'stores', label: 'My stores', icon: 'store', order: 300, minRole: 'admin' });
    sdk.log.info('consignment-artist module ready');
  },

  teardown() {
    clearSdk();
  },
});
