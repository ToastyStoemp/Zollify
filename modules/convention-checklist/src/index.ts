import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Convention packing checklist - one shared template of booth supplies and
 * product categories, checked off fresh against each sales event. See
 * engine/checklist.ts for the data model.
 */
export default defineModule({
  id: 'convention-checklist',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Convention Checklist',
  description: 'Packing checklist for booth supplies and products, tracked per convention.',
  requires: ['catalog'],
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Packing checklist', component: () => import('./views/PackingChecklistView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'events', label: 'Packing checklist', icon: 'clipboard-check', order: 125 });
    sdk.log.info('convention-checklist module ready');
  },

  teardown() {
    clearSdk();
  },
});
