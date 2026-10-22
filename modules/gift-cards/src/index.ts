import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Gift cards - a balance a customer pays for now and spends later, at any
 * till of the account.
 *
 * Cards live on the server half; what is on one is never stored but summed
 * from the till's own sales: selling a card is an ordinary VAT-free sale
 * line pointing at it, spending it is a settling line pointing at it, so
 * receipts, cash-up, the books and a refund all work as for any sale.
 */
export default defineModule({
  id: 'gift-cards',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Gift cards',
  description: 'Sell gift cards at the till and take them as payment at any of your tills, with the balance kept on the server.',
  requires: ['pos'],
  // Staff sell and redeem cards at the till; voiding, granting value and the
  // settings are admin-only on the server.
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Gift cards', component: () => import('./views/GiftCardsView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'selling', label: 'Gift cards', icon: 'credit-card', order: 135 });
    sdk.settings.panel({ id: 'gift-cards', label: 'Gift cards', component: () => import('./views/GiftCardSettings.vue'), minRole: 'admin', order: 125 });
    // Selling a card and taking one as payment, right at the till.
    sdk.till.action({ id: 'gift-card', label: 'Gift card', icon: 'credit-card', component: () => import('./views/TillGiftCard.vue') });
    sdk.log.info('gift-cards module ready');
  },

  teardown() {
    clearSdk();
  },
});
