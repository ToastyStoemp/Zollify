import { defineModule, type Sdk } from '@zollify/sdk';
import { isStore } from '@zollify/shared';
import { clearSdk, setSdk } from './runtime';

/**
 * Consignment - selling artists' work in your stores, and following your own
 * work in other people's.
 *
 * Two sides of one module. A store owner keeps artists, tags their items,
 * and settles what each one is owed per store. An artist links their own
 * account - the same one they sell at conventions with - to see their items,
 * sales and payouts at every store that carries them. Artists, codes and
 * payouts live server-side; the items are ordinary catalogue products, so
 * the till sells them like anything else.
 */
export default defineModule({
  id: 'consignment',
  version: '0.8.0',
  sdk: '^0.1.0',
  title: 'Consignment',
  description: 'Sell work by consignment artists across your stores and settle what each is owed - or follow your own work in other stores.',
  requires: ['catalog'],
  // Staff load it for the till (workshop places, artists' labels); the
  // screens are admin-only, and so is everything else on the server.
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Consignment', minRole: 'admin', component: () => import('./views/ConsignmentView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Consignment', icon: 'users', order: 140, minRole: 'admin' });
    // An artist's label scanned at a store: share the item there if the artist has not yet.
    sdk.till.onLookup(async (code) => {
      const store = sdk.data.events.active();
      if (!store || !isStore(store)) return null;
      let found: { productId: string; variantId: string | null; consignorName: string; autoShared: boolean; priced: boolean };
      try {
        found = await sdk.http.post('scan', { code });
      } catch {
        return null;
      }
      if (!found.priced) {
        sdk.ui.toast(`That is ${found.consignorName}'s item, now shared here - give it a price in your currency first (Consignment → Items → Prices).`, { kind: 'warning', timeoutMs: 8000 });
        return null;
      }
      return {
        productId: found.productId,
        variantId: found.variantId,
        message: found.autoShared ? `Shared from ${found.consignorName}'s catalogue and added - they have been told.` : `Added ${found.consignorName}'s item`,
      };
    });
    // Taking payment for a workshop place, right at the till.
    sdk.till.action({ id: 'workshops', label: 'Workshop', icon: 'calendar', component: () => import('./views/TillWorkshops.vue') });
    sdk.log.info('consignment module ready');
  },

  teardown() {
    clearSdk();
  },
});
