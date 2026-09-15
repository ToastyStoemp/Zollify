import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Costs - what each item cost to make and bring in.
 *
 * A shipment or order is recorded as a batch: its total (production, import,
 * shipping) and how many of each item arrived. The total is spread across the
 * units and written onto the products as a per-unit cost, so margins can be
 * read anywhere the catalogue is. Batches stay on this device; the costs they
 * produce sync with the products.
 */
export default defineModule({
  id: 'costs',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Costs',
  description: 'Cost batches that spread a shipment across its items and set per-unit costs.',
  requires: ['catalog'],
  // Margins are not a helper's business.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Costs', component: () => import('./views/CostsView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Costs', icon: 'coins', order: 150 });
    sdk.log.info('costs module ready');
  },

  teardown() {
    clearSdk();
  },
});
