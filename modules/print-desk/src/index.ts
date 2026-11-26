import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Print Desk - the desktop app at the printer (apps/print-desk), seen and steered from any
 * device: which desks are on and what they are printing, the targets, hidden items and order
 * every desk shares, and requests to set a desk's print counts or to print. Printing on request
 * only happens on a desk that allows it.
 */
export default defineModule({
  id: 'print-desk',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Print Desk',
  description: 'See your Print Desk at the printer from any device: what it is printing, the copies left, the paper it needs. Set targets that every desk shares, and send it counts to print.',
  requires: ['catalog'],
  // Anyone may watch; changing settings and sending requests is for owners and admins (the server checks).
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Print Desk', component: () => import('./views/PrintDeskView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'stock', label: 'Print Desk', icon: 'printer', order: 160 });
  },

  teardown() {
    clearSdk();
  },
});
