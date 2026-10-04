import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Customs hub - one entry point in front of customs-ch and customs-de.
 *
 * Those two modules keep their own routes, storage, and declarant settings
 * (deliberately separate - different legal forms, different data). This
 * module contributes nothing but a single "Customs" nav entry and a picker
 * view that routes into whichever of the two is actually installed, so a
 * user isn't hunting between two near-identical sidebar entries to find
 * either country's paperwork.
 */
export default defineModule({
  id: 'customs-hub',
  version: '0.1.1',
  sdk: '^0.1.0',
  title: 'Customs',
  description: 'One place to pick Swiss or German customs paperwork and jump to declarant settings.',
  requires: ['catalog'],
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({
      path: '',
      name: 'index',
      title: 'Customs',
      component: () => import('./views/HubView.vue'),
    });

    sdk.nav.add({ routeName: 'index', group: 'events', label: 'Customs', icon: 'file-text', order: 120 });

    sdk.log.info('customs-hub module ready');
  },

  teardown() {
    clearSdk();
  },
});
