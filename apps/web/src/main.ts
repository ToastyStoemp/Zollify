import { createApp } from 'vue';
import {
  applyStoredTheme,
  installDiagnostics,
  checkForUpdate,
  announceShellUpdate,
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
  loadSellLockSettings,
  loadRefusedSales,
  loadSalesEvents,
  loadDiscounts,
  loadTransactions,
  refreshAccessToken,
  refreshPendingCount,
  resumeOffline,
  guardUnsyncedOnClose,
  startAutoSync,
  startAutoEvents,
  startRealtime,
  startTillLock,
} from '@zollify/platform';
import '@zollify/ui/tokens.css';
import './styles.css';
import App from './App.vue';
import { router } from './router';
import { connectRouter, followTillPerson, loadEnabledModules, markBooted } from './boot';
import { wireShortcuts } from './shortcuts';

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
  followTillPerson(router);
  void wireBackButton();
  const ready = boot();
  void wireShortcuts(router, ready);
  createApp(App).use(router).mount('#app');
  // Tells the content updater this bundle started. It has to come now, not
  // after boot: the plugin rolls a new bundle back unless it hears this
  // within 10 seconds, and boot waits on the network (sign-in, data,
  // modules), which on a phone at a venue takes longer - so every update was
  // downloaded, started, rolled back to the old one, and fetched again.
  void notifyShellUpdateReady();
  await ready;
}

async function boot(): Promise<void> {
  // No server (no signal at the venue, the gateway restarting): resume as whoever
  // signed this device in, from what is already on it. A refusal clears that first.
  if (!(await refreshAccessToken().catch(() => false)) && !getAccount()) resumeOffline();

  // Core data before modules: POS and Customs read the catalogue and events
  // through the SDK during setup, so it has to be there when they mount.
  if (getAccount()) {
    await Promise.all([
      loadCatalog().catch((err) => console.error('[zollify] catalog load failed', err)),
      loadSalesEvents().catch((err) => console.error('[zollify] events load failed', err)),
      loadTransactions().catch((err) => console.error('[zollify] history load failed', err)),
      loadDiscounts().catch((err) => console.error('[zollify] discounts load failed', err)),
      loadInventory().catch((err) => console.error('[zollify] inventory load failed', err)),
      loadSellLockSettings().catch(() => undefined),
      loadRefusedSales().catch(() => undefined),
      refreshPendingCount().catch(() => {}),
    ]);
  }

  await loadEnabledModules(router).catch((err) => {
    console.error('[zollify] module boot failed', err);
    return [];
  });

  // Closing the tab with changes not yet on the server asks first. Installed whether
  // or not anyone is signed in yet: a sign-in on this page starts the outbox too.
  guardUnsyncedOnClose();
  // Started after modules mount so the first pull's reload reaches a shell that
  // can actually render what arrives.
  if (getAccount()) {
    startAutoSync();
    startRealtime();
    startAutoEvents();
    // A shared till opens locked: whoever is there says who they are first.
    startTillLock();
  }
  markBooted();
  void autoUpdateCheck();
  // Also re-run on the WS shell.update doorbell (see realtime.ts) - a
  // terminal left running all shift might not see another cold start for
  // days, so a server redeploy nudges it the moment it (re)connects instead.
  void announceShellUpdate();
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
