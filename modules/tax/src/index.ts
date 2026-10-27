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
  // Money and bookkeeping are the account holder's business. Staff get one
  // thing: adding what they spent at an event (quick expense); every other
  // screen below is for admins, as the server half enforces too.
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.addAll([
      { path: '', name: 'index', title: 'Card statements', minRole: 'admin', component: () => import('./views/PaymentsView.vue') },
      { path: 'ledger', name: 'ledger', title: 'Event profit', minRole: 'admin', component: () => import('./views/LedgerView.vue') },
      { path: 'ranking', name: 'ranking', title: 'Event ranking', minRole: 'admin', component: () => import('./views/RankingView.vue') },
      { path: 'year', name: 'year', title: 'Year in review', minRole: 'admin', component: () => import('./views/YearView.vue') },
      { path: 'cards', name: 'cards', title: 'Card payments', minRole: 'admin', component: () => import('./views/CardsView.vue') },
      // Something bought at the event, in a few taps - Home's card and the Android "Add expense" shortcut.
      { path: 'quick-expense', name: 'quick-expense', title: 'Add an expense', component: () => import('./views/QuickExpenseView.vue') },
    ]);
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Card statements', icon: 'credit-card', order: 200, minRole: 'admin' });
    sdk.nav.add({ routeName: 'ledger', group: 'books', label: 'Event profit', icon: 'book', order: 210, minRole: 'admin' });
    sdk.nav.add({ routeName: 'ranking', group: 'books', label: 'Event ranking', icon: 'bar-chart', order: 215, minRole: 'admin' });
    sdk.nav.add({ routeName: 'year', group: 'books', label: 'Year in review', icon: 'calendar', order: 216, minRole: 'admin' });
    sdk.nav.add({ routeName: 'cards', group: 'books', label: 'Card payments', icon: 'credit-card', order: 217, minRole: 'admin' });
    // Home: the last event against its earlier editions.
    sdk.home.card({ id: 'last-event', order: 60, minRole: 'admin', component: () => import('./views/LastEventCard.vue') });
    sdk.home.card({ id: 'quick-expense', order: 15, minRole: 'member', component: () => import('./views/QuickExpenseCard.vue') });
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
