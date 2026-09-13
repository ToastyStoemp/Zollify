import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Sourcing — the reorder cockpit.
 *
 * Suppliers and reorder drafts live server-side, because supplier contacts and
 * any future Alibaba credentials must not sit in a browser. The client half is
 * a face over that service; what it needs from core — which products exist —
 * it reads through the SDK.
 */
export default defineModule({
  id: 'sourcing',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Sourcing',
  description: 'Suppliers and reorder drafts for restocking the booth.',
  requires: ['catalog'],
  // Purchasing is not a helper's job.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);

    sdk.routes.add({
      path: '',
      name: 'index',
      title: 'Sourcing',
      component: () => import('./views/SourcingView.vue'),
    });

    sdk.nav.add({ routeName: 'index', label: 'Sourcing', icon: 'package', order: 130 });

    sdk.settings.panel({
      id: 'suppliers',
      label: 'Suppliers',
      component: () => import('./views/SuppliersView.vue'),
      minRole: 'admin',
      order: 130,
    });

    sdk.log.info('sourcing module ready');
  },

  teardown() {
    clearSdk();
  },
});
