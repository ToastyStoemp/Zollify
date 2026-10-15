import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * e-conomic: each closed day of till sales goes into the store's e-conomic
 * journal as one voucher - revenue by VAT code, takings by cash and card, and
 * renters' shares owed to them - for the accountant to post. e-conomic then
 * does the VAT return.
 */
export default defineModule({
  id: 'economic',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'e-conomic bookkeeping',
  description: 'Book each day of till sales into your e-conomic journal, VAT codes included.',
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'e-conomic', component: () => import('./views/DaysView.vue'), minRole: 'admin' });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'e-conomic', icon: 'book', order: 230, minRole: 'admin' });
    sdk.settings.panel({ id: 'economic', label: 'e-conomic', component: () => import('./views/EconomicSettings.vue'), minRole: 'admin', order: 130 });
  },

  teardown() {
    clearSdk();
  },
});
