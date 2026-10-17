import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Odoo sync - the client face. The API key lives only on the server half;
 * this module sends the local catalogue for matching, shows what came back
 * for a person to confirm, and offers a "sync now" and the recent log.
 */
export default defineModule({
  id: 'odoo-sync',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Odoo sync',
  description: 'Keep stock level with an Odoo warehouse and invoice till sales there.',
  requires: ['catalog'],
  minRole: 'owner',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Odoo sync', component: () => import('./views/OdooView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'stock', label: 'Odoo', icon: 'database', order: 160 });
    sdk.settings.panel({ id: 'connection', label: 'Odoo connection', component: () => import('./views/ConnectionSettings.vue'), minRole: 'owner', order: 160 });
    sdk.log.info('odoo-sync module ready');
  },

  teardown() {
    clearSdk();
  },
});
