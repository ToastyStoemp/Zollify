import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';
import { resetState } from './state';

/**
 * Tax - the books (the ZollTax port).
 *
 * Three screens: Payments, where a month's card and online takings are
 * clustered per convention, matched to events, verified against myPOS and
 * booked into Lexware; Ledger, the per-event profit and loss with the
 * costs of doing each event; and Ranking, the events against each other and
 * against their earlier editions. Credentials live under Settings → Integrations.
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
      { path: '', name: 'index', title: 'Card statements', component: () => import('./views/PaymentsView.vue') },
      { path: 'ledger', name: 'ledger', title: 'Event profit', component: () => import('./views/LedgerView.vue') },
      { path: 'ranking', name: 'ranking', title: 'Event ranking', component: () => import('./views/RankingView.vue') },
    ]);
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Card statements', icon: 'credit-card', order: 200 });
    sdk.nav.add({ routeName: 'ledger', group: 'books', label: 'Event profit', icon: 'book', order: 210 });
    sdk.nav.add({ routeName: 'ranking', group: 'books', label: 'Event ranking', icon: 'bar-chart', order: 215 });
    // Home: the last event against its earlier editions.
    sdk.home.card({ id: 'last-event', order: 60, component: () => import('./views/LastEventCard.vue') });
    sdk.settings.panel({
      id: 'integrations',
      label: 'Bookkeeping connections',
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
