import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * ATA Carnet - the paper for taking stock temporarily into a country
 * outside the EU (the UK, Norway, Switzerland and most others) for a show:
 * the General List built from what the event claims, and the return check
 * after it, so what sold abroad is declared and what came back is shown
 * against the list.
 */
export default defineModule({
  id: 'ata-carnet',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'ATA Carnet',
  description: 'The General List from an event\'s packed stock, and the return check after the show.',
  requires: ['catalog', 'events'],
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.addAll([
      { path: '', name: 'index', title: 'ATA Carnet', component: () => import('./views/CarnetView.vue') },
      { path: 'documents/:eventId', name: 'documents', title: 'ATA Carnet', component: () => import('./views/CarnetView.vue') },
    ]);
    // Reached through the Customs hub, like the country modules; its own nav entry only when the hub is not there.
    sdk.nav.add({ routeName: 'index', group: 'events', label: 'ATA Carnet', icon: 'file-text', order: 122 });
    sdk.log.info('ata-carnet module ready');
  },

  teardown() {
    clearSdk();
  },
});
