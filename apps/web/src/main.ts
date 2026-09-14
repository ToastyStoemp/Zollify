import { createApp } from 'vue';
import {
  applyStoredTheme,
  installDiagnostics,
  configureApiBase,
  getAccount,
  loadCatalog,
  loadInventory,
  loadSalesEvents,
  loadDiscounts,
  loadTransactions,
  refreshAccessToken,
  refreshPendingCount,
  startAutoSync,
  startRealtime,
} from '@zollify/platform';
import '@zollify/ui/tokens.css';
import './styles.css';
import App from './App.vue';
import { router } from './router';
import { connectRouter, loadEnabledModules, markBooted } from './boot';

// Before anything renders, so the first frame is already the right theme.
applyStoredTheme();
installDiagnostics();

configureApiBase(import.meta.env.VITE_API_BASE ?? '/api');

/**
 * Boot order matters: restore the session first, because which modules load
 * depends on the account, and a module's routes must exist before the router
 * resolves the first navigation.
 *
 * The shell mounts straight away and shows a splash; the first navigation
 * waits on this so a module route typed into the address bar still resolves.
 */
async function start(): Promise<void> {
  connectRouter(router);
  const ready = boot();
  createApp(App).use(router).mount('#app');
  await ready;
}

async function boot(): Promise<void> {
  await refreshAccessToken().catch(() => false);

  // Core data before modules: POS and Customs read the catalogue and events
  // through the SDK during setup, so it has to be there when they mount.
  if (getAccount()) {
    await Promise.all([
      loadCatalog().catch((err) => console.error('[zollify] catalog load failed', err)),
      loadSalesEvents().catch((err) => console.error('[zollify] events load failed', err)),
      loadTransactions().catch((err) => console.error('[zollify] history load failed', err)),
      loadDiscounts().catch((err) => console.error('[zollify] discounts load failed', err)),
      loadInventory().catch((err) => console.error('[zollify] inventory load failed', err)),
      refreshPendingCount().catch(() => {}),
    ]);
  }

  await loadEnabledModules(router).catch((err) => {
    console.error('[zollify] module boot failed', err);
    return [];
  });

  // Started after modules mount so the first pull's reload reaches a shell that
  // can actually render what arrives.
  if (getAccount()) {
    startAutoSync();
    startRealtime();
  }
  markBooted();
}

void start();
