import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Migration — a single-use importer for one ZollTool backup.
 *
 * Deliberately a module rather than a core feature, so no legacy compatibility
 * leaks into the platform permanently. Install it, run the import once, switch
 * it off.
 */
export default defineModule({
  id: 'migration',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Migration',
  description: 'Import a ZollTool backup into this account. Run once, then switch off.',
  requires: ['catalog'],
  // Rewriting the catalogue wholesale is an owner's decision.
  minRole: 'owner',

  setup(sdk: Sdk) {
    setSdk(sdk);

    sdk.routes.add({
      path: '',
      name: 'index',
      title: 'Import from ZollTool',
      component: () => import('./views/ImportView.vue'),
    });
    sdk.nav.add({ routeName: 'index', group: 'account', label: 'Import', icon: 'upload', order: 800 });
    sdk.log.info('migration module ready — remember to switch it off once the import is done');
  },

  teardown() {
    clearSdk();
  },
});
