import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';
import { loadOrders } from './api';

/**
 * Wholesale - selling to shops outright, the reverse of consignment: what
 * each product is to the trade (tiers, minimums, lead time), the trade
 * customers, orders from draft to paid, and a catalogue to hand out.
 *
 * Records live on the server half. Stock and revenue stay core's: an open
 * order claims its units on the account's "Wholesale" store the way an
 * event claim does, and shipping records the order as a sale there, so
 * the inventory, the books and the reports follow with nothing to re-enter.
 */
export default defineModule({
  id: 'wholesale',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Wholesale',
  description: 'Trade prices and tiers, a catalogue to hand out, trade customers and their orders - reserving stock while open and selling it when shipped.',
  requires: ['catalog', 'events'],
  // Prices to the trade, customers and orders are the account holder's business.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Wholesale', component: () => import('./views/WholesaleView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Wholesale', icon: 'package', order: 240 });
    // Orders due to ship, on the home calendar.
    sdk.calendar.source(async ({ from, to }) => {
      const { orders, customers } = await loadOrders();
      const names = new Map(customers.map((c) => [c.id, c.company]));
      return orders
        .filter((o) => (o.status === 'confirmed' || o.status === 'packed') && o.expectedShipDate >= from && o.expectedShipDate <= to)
        .map((o) => ({ id: `wholesale:${o.id}`, date: o.expectedShipDate, title: `Ship #${o.number} to ${names.get(o.customerId) ?? 'customer'}`, tone: o.status === 'packed' ? ('normal' as const) : ('attention' as const), icon: 'package', link: '/m/wholesale' }));
    });
    sdk.log.info('wholesale module ready');
  },

  teardown() {
    clearSdk();
  },
});
