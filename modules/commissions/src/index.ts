import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Commissions - custom work for a customer, from request to pickup.
 *
 * Records and customer details live on the server half; the customer follows
 * progress on a public page reached by a QR code. Deposits and balances are
 * rung up at the till as ordinary sale lines (a "Commission" button over the
 * till), so payment providers, receipts, VAT and cash-up work as usual, and
 * what is paid is derived from those sales.
 */
export default defineModule({
  id: 'commissions',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Commissions',
  description: 'Take commissions with a deposit at the till and let the customer follow progress with a QR code.',
  requires: ['catalog'],
  // Staff create and update commissions and take payments; settings and
  // replacing a link are admin-only on the server.
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Commissions', component: () => import('./views/CommissionsView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'selling', label: 'Commissions', icon: 'sparkles', order: 130 });
    // Taking a deposit or the final balance, right at the till.
    sdk.till.action({ id: 'commission', label: 'Commission', icon: 'sparkles', component: () => import('./views/TillCommission.vue') });
    sdk.log.info('commissions module ready');
  },

  teardown() {
    clearSdk();
  },
});
