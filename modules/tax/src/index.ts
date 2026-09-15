import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';
import { resetState } from './state';

/**
 * Tax - the books (the ZollTax port).
 *
 * Two screens: Payments, where a month's card and online takings are
 * clustered per convention, matched to events, verified against myPOS and
 * booked into Lexware; and Ledger, the per-event profit and loss with the
 * costs of doing each event. Credentials live under Settings → Integrations.
 */
export default defineModule({
  id: 'tax',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Tax & books',
  description: 'Payment clustering, myPOS verification, Lexware booking and a per-event ledger.',
  requires: ['events'],
  // Money and bookkeeping are the account holder's business, not a helper's.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.addAll([
      { path: '', name: 'index', title: 'Payments', component: () => import('./views/PaymentsView.vue') },
      { path: 'ledger', name: 'ledger', title: 'Ledger', component: () => import('./views/LedgerView.vue') },
    ]);
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Payments', icon: 'credit-card', order: 200 });
    sdk.nav.add({ routeName: 'ledger', group: 'books', label: 'Ledger', icon: 'book', order: 210 });
    sdk.settings.panel({
      id: 'integrations',
      label: 'Integrations',
      component: () => import('./views/IntegrationsSettings.vue'),
      minRole: 'admin',
      order: 200,
    });
    sdk.log.info('tax module ready');
  },

  teardown() {
    resetState();
    clearSdk();
  },
});
