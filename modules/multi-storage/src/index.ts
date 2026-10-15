import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';
import { loadStorage, loaded, resetStorage } from './state';

/**
 * Storage locations - splits the one inventory by where it physically is, lets
 * each device pick the place it sells from, and plans what to fetch from where
 * for an event. Staff move and count stock; admins manage the locations. See
 * engine/storage.ts.
 */
export default defineModule({
  id: 'multi-storage',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Storage locations',
  description: 'Keep stock at more than one place - a storage unit, the studio - sell from the one each device is at, and know what to fetch from where for each event.',
  requires: ['catalog'],
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Storage', component: () => import('./views/StorageView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'stock', label: 'Storage', icon: 'truck', order: 26 });
    // Another device may have moved stock; pick its moves up after each sync.
    sdk.events.on('sync:completed', () => {
      if (!loaded.value) return;
      loadStorage().catch((e: unknown) => sdk.log.warn('multi-storage reload failed', e));
    });
    sdk.log.info('multi-storage module ready');
  },

  teardown() {
    resetStorage();
    clearSdk();
  },
});
