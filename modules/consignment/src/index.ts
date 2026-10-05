import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Consignment - selling artists' work in your stores, and following your own
 * work in other people's.
 *
 * Two sides of one module. A store owner keeps artists, tags their items,
 * and settles what each one is owed per store. An artist links their own
 * account - the same one they sell at conventions with - to see their items,
 * sales and payouts at every store that carries them. Artists, codes and
 * payouts live server-side; the items are ordinary catalogue products, so
 * the till sells them like anything else.
 */
export default defineModule({
  id: 'consignment',
  version: '0.3.0',
  sdk: '^0.1.0',
  title: 'Consignment',
  description: 'Sell work by consignment artists across your stores and settle what each is owed - or follow your own work in other stores.',
  requires: ['catalog'],
  // Commissions and payouts are not a helper's business.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Consignment', component: () => import('./views/ConsignmentView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Consignment', icon: 'users', order: 140 });
    sdk.log.info('consignment module ready');
  },

  teardown() {
    clearSdk();
  },
});
