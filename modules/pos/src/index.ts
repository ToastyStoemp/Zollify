import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';
import { listenForRemotePayments } from './payments/satellite';
import { onActiveProviderChanged } from './payments/registry';

/**
 * POS - taking money at the booth.
 *
 * Zollify never touches the sale itself: myPOS and SumUp terminals take the
 * card and settle to the vendor's bank. This module orchestrates the checkout,
 * records the result and prints the receipt, which is what keeps PCI scope out
 * of the platform entirely.
 *
 * Payment providers are a nested plugin layer inside this module - adding a new
 * terminal means adding a provider here, and the platform never learns it
 * exists.
 */
export default defineModule({
  id: 'pos',
  version: '0.1.6',
  sdk: '^0.1.0',
  title: 'POS',
  description: 'Cart, checkout and receipts, with pluggable payment terminals.',
  requires: ['catalog'],
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);

    sdk.routes.addAll([
      { path: '', name: 'index', title: 'Sell', component: () => import('./views/PosView.vue') },
      {
        path: 'receipt/:saleId',
        name: 'receipt',
        title: 'Receipt',
        component: () => import('./views/ReceiptView.vue'),
      },
    ]);

    sdk.nav.add({ routeName: 'index', group: 'selling', label: 'Sell', icon: 'shopping-cart', order: 100 });

    sdk.settings.panel({
      id: 'receipts',
      label: 'Receipts',
      component: () => import('./views/ReceiptSettings.vue'),
      minRole: 'admin',
      order: 101,
    });

    sdk.settings.panel({
      id: 'payments',
      label: 'Payments',
      component: () => import('./views/PaymentSettings.vue'),
      // Which terminal the till talks to is an account-level decision, not
      // something a helper working one event should be changing mid-shift.
      minRole: 'admin',
      order: 100,
    });

    // A Carbon answers remote payment triggers from any screen; the subscription is released with the module.
    listenForRemotePayments();

    void sdk.config.get<string>('activeProvider').then((id) => {
      if (id) onActiveProviderChanged(id as never);
    });

    sdk.log.info('pos module ready');
  },

  teardown() {
    clearSdk();
  },
});
