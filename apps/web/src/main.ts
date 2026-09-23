import { createApp } from 'vue';
import {
  applyStoredTheme,
  installDiagnostics,
  checkForUpdate,
  checkAndQueueShellUpdate,
  configureApiBase,
  createShellUi,
  downloadUpdate,
  notifyShellUpdateReady,
  updateDownload,
  getServerUrl,
  isNative,
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

// The Android shell runs from local assets and talks to the server the user
// named at first launch; on the web the API is same-origin.
configureApiBase(isNative() && getServerUrl() ? `${getServerUrl()}/api` : (import.meta.env.VITE_API_BASE ?? '/api'));

/**
 * Boot order matters: restore the session first, because which modules load
 * depends on the account, and a module's routes must exist before the router
 * resolves the first navigation.
 *
 * The shell mounts straight away and shows a splash; the first navigation
 * waits on this so a module route typed into the address bar still resolves.
 */
/**
 * Android back gesture / button. The WebView's own history is not enough
 * once the router has replaced entries, so it is driven explicitly: step back
 * while there is somewhere to go, otherwise let Android close the app.
 */
async function wireBackButton(): Promise<void> {
  if (!isNative()) return;
  const { App: CapApp } = await import('@capacitor/app');
  await CapApp.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && window.history.length > 1) router.back();
    else void CapApp.exitApp();
  });
}

async function start(): Promise<void> {
  connectRouter(router);
  void wireBackButton();
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
  // Confirms this boot to the shell-content updater before anything else -
  // it must hear this once per successful start or it assumes the active
  // bundle crashed and rolls back to the previous one.
  void notifyShellUpdateReady();
  void autoUpdateCheck();
  void shellUpdateCheck();
}

/**
 * Same background-convenience shape as autoUpdateCheck() above, for the
 * content-only path: queued with next(), so - unlike the APK toast - there's
 * nothing to tap, just a heads-up that it'll be there next time the app opens.
 */
async function shellUpdateCheck(): Promise<void> {
  const queuedVersion = await checkAndQueueShellUpdate();
  if (queuedVersion) createShellUi('shell').toast(`Update ${queuedVersion} downloaded - it'll be ready next time the app opens.`, { timeoutMs: 8000 });
}

/**
 * The Android app fetches a newer build in the background and says so once
 * it is ready; installing stays a tap under Settings → This device, because
 * the system's install dialog taking over mid-sale would be worse than an
 * old build for one more shift. Carbon terminals never update from here -
 * they still get most fixes through checkAndQueueShellUpdate() below, which
 * needs no install dialog at all; this path only matters for changes that
 * need a new APK (a native plugin, a permission).
 */
async function autoUpdateCheck(): Promise<void> {
  try {
    const check = await checkForUpdate();
    if (!check?.available) return;
    await downloadUpdate(check);
    if (updateDownload.ready) createShellUi('shell').toast(`Update ${check.versionName} is ready - install it under Settings → This device.`, { timeoutMs: 8000 });
  } catch {
    /* background convenience, never an error the user has to see */
  }
}

void start();
