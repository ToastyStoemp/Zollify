import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Price Cards — printable price tags for the table.
 *
 * Reads the catalogue through the SDK and owns nothing of its own beyond
 * layout preferences, so prices on the table can never disagree with prices at
 * the till.
 */
export default defineModule({
  id: 'price-cards',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Price Cards',
  description: 'Printable price cards for the booth, straight from the catalogue.',
  requires: ['catalog'],
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({
      path: '',
      name: 'index',
      title: 'Price cards',
      component: () => import('./views/PriceCardsView.vue'),
    });
    sdk.nav.add({ routeName: 'index', label: 'Price cards', icon: 'tag', order: 140 });
    sdk.log.info('price-cards module ready');
  },

  teardown() {
    clearSdk();
  },
});
