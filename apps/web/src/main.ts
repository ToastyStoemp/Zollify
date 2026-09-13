import { createApp } from 'vue';
import {
  configureApiBase,
  getAccount,
  loadCatalog,
  loadSalesEvents,
  loadTransactions,
  refreshAccessToken,
  refreshPendingCount,
  startAutoSync,
} from '@boothly/platform';
import '@boothly/ui/tokens.css';
import './styles.css';
import App from './App.vue';
import { router } from './router';
import { connectRouter, loadEnabledModules } from './boot';

configureApiBase(import.meta.env.VITE_API_BASE ?? '/api');

/**
 * Boot order matters: restore the session first, because which modules load
 * depends on the account, and a module's routes must exist before the router
 * resolves the first navigation.
 */
async function start(): Promise<void> {
  connectRouter(router);

  await refreshAccessToken().catch(() => false);

  // Core data before modules: POS and Customs read the catalogue and events
  // through the SDK during setup, so it has to be there when they mount.
  if (getAccount()) {
    await Promise.all([
      loadCatalog().catch((err) => console.error('[boothly] catalog load failed', err)),
      loadSalesEvents().catch((err) => console.error('[boothly] events load failed', err)),
      loadTransactions().catch((err) => console.error('[boothly] history load failed', err)),
      refreshPendingCount().catch(() => {}),
    ]);
  }

  await loadEnabledModules(router).catch((err) => {
    console.error('[boothly] module boot failed', err);
    return [];
  });

  // Started after modules mount so the first pull's reload reaches a shell that
  // can actually render what arrives.
  if (getAccount()) startAutoSync();

  createApp(App).use(router).mount('#app');
}

void start();
