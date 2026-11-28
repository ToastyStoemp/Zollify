import { ref } from 'vue';
import type { Router } from 'vue-router';
import { ROLE_RANK, roleAtLeast, type Role } from '@zollify/sdk';
import {
  ContributionRegistry,
  ModuleLoader,
  PlatformEventBus,
  RemoteResolver,
  StaticResolver,
  authFetch,
  createShellUi,
  getAccount,
  getCached,
  getDeviceAccount,
  getServerUrl,
  guardUnsyncedOnClose,
  isNative,
  leaveOnPurpose,
  loadCatalog,
  loadDiscounts,
  loadInventory,
  loadRefusedSales,
  loadSalesEvents,
  loadSellLockSettings,
  loadTransactions,
  noteSale,
  pendingCount,
  putCached,
  refreshAccessToken,
  refreshPendingCount,
  resumeOffline,
  shellConfirm,
  syncNow,
  syncState,
  onAccountChange,
  recordSale,
  signOut,
  startAutoEvents,
  startAutoSync,
  startRealtime,
  startTillLock,
  stopAutoSync, stopAutoEvents,
  stopRealtime,
  verifyCached,
  withTimeout,
  type LoadOutcome,
  type ModuleDescriptor,
  type ModuleResolver,
} from '@zollify/platform';

/**
 * Modules compiled into this build.
 *
 * First-party modules ship with the shell during development so the loader path
 * can be exercised without a registry. The remote resolver uses the identical
 * code path, which is what makes switching them on at runtime a configuration
 * change rather than an architectural one.
 */
const BUNDLED_MODULES: Record<string, () => Promise<unknown>> = {
  pos: () => import('@zollify/pos'),
  'customs-ch': () => import('@zollify/customs-ch'),
  'customs-de': () => import('@zollify/customs-de'),
  'customs-hub': () => import('@zollify/customs-hub'),
  'price-cards': () => import('@zollify/price-cards'),
  'label-printer': () => import('@zollify/label-printer'),
  'convention-checklist': () => import('@zollify/convention-checklist'),
  'multi-storage': () => import('@zollify/multi-storage'),
  sourcing: () => import('@zollify/sourcing'),
  migration: () => import('@zollify/migration'),
  'shopify-sync': () => import('@zollify/shopify-sync'),
  'public-events': () => import('@zollify/public-events'),
  tax: () => import('@zollify/tax'),
  costs: () => import('@zollify/costs'),
  consignment: () => import('@zollify/consignment'),
  'consignment-artist': () => import('@zollify/consignment-artist'),
  commissions: () => import('@zollify/commissions'),
  'peppol-be': () => import('@zollify/peppol-be'),
  economic: () => import('@zollify/economic'),
  'tax-deadlines': () => import('@zollify/tax-deadlines'),
  'sme-scheme': () => import('@zollify/sme-scheme'),
  wholesale: () => import('@zollify/wholesale'),
  loyalty: () => import('@zollify/loyalty'),
  'print-stories': () => import('@zollify/print-stories'),
  'print-desk': () => import('@zollify/module-print-desk'),
};

/** False until the session, core data and modules are in; the shell shows a splash meanwhile. */
export const booted = ref(false);
let resolveBoot: () => void = () => {};
/** Settles when boot is done - the router's first navigation waits on it. */
export const whenBooted = new Promise<void>((resolve) => (resolveBoot = resolve));
export function markBooted(): void {
  booted.value = true;
  resolveBoot();
}

export const contributions = new ContributionRegistry();
export const events = new PlatformEventBus();

/**
 * Core records every announced sale.
 *
 * Subscribing here rather than inside POS means a sale is stored even if POS is
 * later replaced or switched off mid-session, and any future module that sells
 * something gets the same treatment for free.
 */
events.on('sale', (sale) => {
  noteSale();
  void recordSale(sale).catch((err) => {
    // Never rethrow into the emitter: the payment already happened, and the
    // till must not appear to fail after the customer has paid.
    console.error('[zollify] could not record a sale', err);
  });
});

/**
 * Routes reach the router the instant a module contributes them, rather than in
 * a pass afterwards - the nav is reactive and would otherwise render a link to
 * a route the router does not yet know.
 */
export function connectRouter(router: Router): void {
  contributions.setRouteSink({
    add(route) {
      if (router.hasRoute(route.name)) return;
      router.addRoute({
        path: route.fullPath,
        name: route.name,
        component: route.component as never,
        // Route params arrive as props, so a module component declares what it
        // needs instead of reaching for useRoute() and coercing strings.
        props: true,
        meta: { moduleId: route.moduleId, minRole: route.minRole, title: route.title },
      });
    },
    remove(routeName) {
      if (router.hasRoute(routeName)) router.removeRoute(routeName);
    },
  });
}

/**
 * How long one module bundle may take to download. Without a limit a single
 * stalled download held every other module - and the splash - for as long as
 * the connection stayed open, which at a venue can be minutes.
 */
export const BUNDLE_TIMEOUT_MS = 20_000;

/** Downloads one module bundle's source, or fails once the limit is up. */
export async function downloadBundle(url: string, timeoutMs = BUNDLE_TIMEOUT_MS): Promise<string> {
  // Bundle paths are server-relative; the Android shell must reach across to the server.
  const abs = isNative() && getServerUrl() && url.startsWith('/') ? `${getServerUrl()}${url}` : url;
  return withTimeout(timeoutMs, null, async (signal) => {
    const res = await fetch(abs, { credentials: 'same-origin', signal });
    if (!res.ok) throw new Error(`Could not download module bundle (${res.status}).`);
    return res.text();
  });
}

/**
 * True while modules are started from what is on the device: a bundle that is
 * not there is then not waited for - it is fetched in the background instead
 * (see updateModulesForNextStart) and runs from the next start.
 */
let bundlesFromDeviceOnly = false;

function resolverFor(mode: 'bundled' | 'remote'): ModuleResolver {
  if (mode === 'bundled') return new StaticResolver(BUNDLED_MODULES);
  return new RemoteResolver(async (url) => {
    if (bundlesFromDeviceOnly) throw new Error('Not on this device yet - it downloads in the background and runs from the next start.');
    return downloadBundle(url);
  });
}

const mode: 'bundled' | 'remote' =
  import.meta.env.VITE_MODULE_SOURCE === 'remote' ? 'remote' : 'bundled';

export const loader = new ModuleLoader({
  contributions,
  events,
  resolver: resolverFor(mode),
  // The shell's own UI services; each module gets its own attributed instance
  // via createModuleHost, so this one is only a fallback for host-level calls.
  ui: createShellUi('shell'),
});

/**
 * Leaves the current account cleanly and lands back on the login screen -
 * the one path both "sign out" and "switch account" take, since a user
 * belongs to exactly one account and there is nothing to switch to without
 * signing out of this one first.
 */
/**
 * Signs this device out - but not past work that has not reached the server
 * without saying so. Changes made here wait in this device's outbox: they
 * survive the sign-out and go up the next time anyone signs in on this
 * browser, yet until then no other phone or laptop sees them. A tester
 * signed in elsewhere straight after adding a product and took it for lost.
 * So: try a sync first, and if anything is still waiting, ask.
 * Resolves false when the person chose to stay signed in.
 */
export async function signOutAndReload(): Promise<boolean> {
  if (pendingCount.value > 0) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) await syncNow().catch(() => undefined);
    const left = pendingCount.value;
    if (left > 0) {
      const one = left === 1;
      const ok = await shellConfirm(
        `${left} change${one ? '' : 's'} made on this device ${one ? 'has' : 'have'} not reached the server yet${
          syncState.value === 'offline' ? ' - you are offline' : ''
        }. ${one ? 'It stays' : 'They stay'} here and ${one ? 'is' : 'are'} sent the next time someone signs in on this device, but other devices will not see ${one ? 'it' : 'them'} until then.\n\nSign out anyway?`,
        'Not synced yet',
      );
      if (!ok) return false;
    }
  }
  stopAutoSync();
  stopAutoEvents();
  stopRealtime();
  await loader.unloadAll();
  await signOut();
  leaveOnPurpose();
  window.location.hash = '#/login';
  window.location.reload();
  return true;
}

interface ManifestResponse {
  sdk: string;
  modules: ModuleDescriptor[];
}

/** Why each switched-on module is or is not running, from the last load - the Modules panel shows it. */
export const loadOutcomes = ref<LoadOutcome[]>([]);

// Which modules are on comes from the server; the last answer is kept per
// account, so starting without the server (no signal at the venue) still
// brings up the till and the rest from the bundles already on the device.
const manifestKey = (accountId: string): string => `zollify.manifest.${accountId}`;

/** The server's last answer for this account, or null when this device never got one. */
function cachedManifest(accountId: string): ManifestResponse | null {
  try {
    const cached = JSON.parse(localStorage.getItem(manifestKey(accountId)) ?? 'null') as ManifestResponse | null;
    return cached?.modules ? cached : null;
  } catch {
    return null;
  }
}

function rememberManifest(accountId: string, manifest: ManifestResponse): void {
  try {
    localStorage.setItem(manifestKey(accountId), JSON.stringify(manifest));
  } catch {
    /* no storage: the next start simply needs the server for its modules, as before */
  }
}

/** A first start has nothing to fall back on, so the server gets the full request limit to answer. */
const MANIFEST_TIMEOUT_MS = 30_000;
/** With the last answer on the device, a weak signal must not hold anyone that long. */
const MANIFEST_TIMEOUT_WITH_CACHE_MS = 10_000;

function fetchManifest(timeoutMs: number = MANIFEST_TIMEOUT_MS): Promise<ManifestResponse> {
  return authFetch('/modules/manifest', { timeoutMs }) as Promise<ManifestResponse>;
}

/**
 * Mounts a manifest's modules for whoever is using the app.
 *
 * Routes are registered through the sink as each module mounts; a module
 * whose setup throws has its contributions rolled back, so a failed module
 * never leaves a navigable but broken screen behind.
 */
async function mountModules(manifest: ManifestResponse, role: Role): Promise<LoadOutcome[]> {
  const outcomes = await loader.loadAll(manifest.modules, role);
  loadedFor = role;
  const seen = new Set(outcomes.map((o) => o.moduleId));
  loadOutcomes.value = [...outcomes, ...loadOutcomes.value.filter((o) => !seen.has(o.moduleId))];

  for (const outcome of outcomes) {
    if (outcome.status === 'loaded') continue;
    console.warn(
      `[zollify] module "${outcome.moduleId}" ${outcome.status}: ${outcome.reason ?? 'no reason given'}`,
    );
  }
  return outcomes;
}

/**
 * Asks the server which modules this account has enabled, then loads them,
 * falling back to its last answer when it cannot be reached. Null when there
 * is neither - nobody signed in, or a first start that never got an answer.
 *
 * Failures are returned, not thrown: a module that will not load must never
 * stop the shell from starting. A booth with a broken Tax module still needs to
 * open the till.
 */
async function loadModulesFromServer(): Promise<LoadOutcome[] | null> {
  const account = getAccount();
  if (!account) return null;
  const cached = cachedManifest(account.accountId);
  let manifest: ManifestResponse;
  try {
    manifest = await fetchManifest(cached ? MANIFEST_TIMEOUT_WITH_CACHE_MS : MANIFEST_TIMEOUT_MS);
    rememberManifest(account.accountId, manifest);
  } catch (err) {
    if (!cached) {
      console.error('[zollify] could not fetch the module manifest', err);
      return null;
    }
    console.warn('[zollify] server not reached - starting the modules this device last ran');
    manifest = cached;
  }
  return mountModules(manifest, account.role);
}

/**
 * Loads the modules this device last ran, from what is on it - no request is
 * made and none is waited for. Null when the device has no answer to start from.
 */
export async function loadCachedModules(): Promise<LoadOutcome[] | null> {
  const account = getAccount();
  const cached = account ? cachedManifest(account.accountId) : null;
  if (!account || !cached) return null;
  bundlesFromDeviceOnly = true;
  try {
    return await mountModules(cached, account.role);
  } finally {
    bundlesFromDeviceOnly = false;
  }
}

/**
 * Server first - for a change made on this device (a module switched on in
 * Settings, a sign-in), where the newest answer is the point.
 */
export async function loadEnabledModules(_router?: Router): Promise<LoadOutcome[]> {
  return (await loadModulesFromServer()) ?? [];
}

/** Where the running modules came from: what was on the device, the server, or nowhere (none could be loaded). */
export type ModuleSource = 'device' | 'server' | 'none';

/**
 * Loads modules in the order asked and says where they came from. Never
 * throws: a booth whose modules will not load still gets its shell.
 */
async function loadModules(order: 'device-first' | 'server-first'): Promise<ModuleSource> {
  try {
    if (order === 'device-first' && (await loadCachedModules())) return 'device';
    if (await loadModulesFromServer()) return 'server';
    if (getAccount()) offerModuleRetry();
  } catch (err) {
    console.error('[zollify] module boot failed', err);
  }
  return 'none';
}

/** A first start that got no answer about its modules says so, instead of opening an app with no till and no reason. */
function offerModuleRetry(): void {
  createShellUi('shell').toast('The server did not answer, so your modules (the till among them) are not loaded yet.', {
    kind: 'error',
    timeoutMs: 0,
    action: { label: 'Try again', onClick: () => void loadModules('server-first') },
  });
}

/** The role modules were last loaded for; a shared till can hand the app to someone with another. */
let loadedFor: Role | null = null;

/**
 * Keeps modules and the open screen in step with whoever is using a shared
 * till: someone senior gets the modules they may use loaded, someone junior
 * loses the ones they may not, and nobody is left on a screen they cannot open.
 */
export function followTillPerson(router: Router): void {
  onAccountChange((account) => {
    if (!account || !loadedFor || account.role === loadedFor) return;
    void (async () => {
      // From the device first: someone senior unlocking at a venue must not wait on the server for their screens.
      if (ROLE_RANK[account.role] > ROLE_RANK[loadedFor!]) await loadModules('device-first');
      else {
        await loader.unloadAbove(account.role);
        loadedFor = account.role;
      }
      const needed = router.currentRoute.value.meta.minRole as Role | undefined;
      if (!router.currentRoute.value.name || (needed && !roleAtLeast(account.role, needed))) await router.replace({ name: 'home' });
    })();
  });
}

/** Unloads a module; the sink withdraws its routes as the registry drops them. */
export async function unloadModule(_router: Router, moduleId: string): Promise<void> {
  await loader.unload(moduleId);
}

// ── Starting the app ────────────────────────────────────────────────────────
//
// A booth restarts the app in a hall where the phone is connected but nothing
// gets through. Start used to ask the server first - renew the session, fetch
// the module list - and only fell back to the device once each request had
// run out its limit: most of a minute of splash, on the device that had
// everything it needed all along. With no signal at all it was quicker.
//
// So a device that is already signed in starts from itself: who signed it in,
// its own data, the modules it last ran. The server is asked afterwards, in
// the background, and whatever it answers never interrupts a sale. Only a
// device with nobody remembered (first run, signed out) waits for the server,
// and every one of those waits has a limit.

/** Resumes as whoever signed this device in, from what it remembers - no request. False when nobody is remembered. */
export function resumeLocalSession(): boolean {
  return resumeOffline();
}

/** Nobody remembered: the server has to say who this is. Limited by the refresh request's own timeout. */
async function signInFromServer(): Promise<boolean> {
  return refreshAccessToken().catch(() => false);
}

/**
 * Reads this account's data from the device into the stores. Core data comes
 * before modules: POS and Customs read the catalogue and events through the
 * SDK during setup, so it has to be there when they mount. One store failing
 * to load must not keep the others, or the till, from opening.
 */
export async function loadLocalStores(): Promise<void> {
  if (!getAccount()) return;
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

/**
 * Everything that talks to the server while the app runs. Started after
 * modules mount so the first pull's reload reaches a shell that can actually
 * render what arrives. None of it is waited for.
 */
function startBackgroundServices(opts: { unlocked?: boolean }): void {
  if (!getAccount()) return;
  startAutoSync();
  startRealtime();
  startAutoEvents();
  // A shared till opens locked: whoever is there says who they are first.
  startTillLock(opts);
}

export interface SessionOptions {
  /** `device-first` for a start from what the device has; `server-first` when the server has just been talked to. */
  modules: 'device-first' | 'server-first';
  /** Just signed in with a password: that already says who is at a shared till. */
  unlocked?: boolean;
}

/**
 * Brings the signed-in app up: data, then modules, then syncing. The one way
 * in, for a cold start and for a sign-in alike - there used to be a copy of
 * this in each and they had drifted apart.
 *
 * Resolves once the data is in the stores, so the caller can already show
 * the app; `ready` settles when the modules are mounted too (a module's
 * screen only exists then) and never rejects.
 */
export async function openSession(opts: SessionOptions): Promise<{ ready: Promise<ModuleSource> }> {
  await loadLocalStores();
  const ready = (async () => {
    const source = await loadModules(opts.modules);
    startBackgroundServices({ unlocked: opts.unlocked });
    return source;
  })();
  return { ready };
}

/**
 * Starts the app. Signed in already: from the device alone, the server asked
 * only afterwards. Otherwise the server says who this is first, as before.
 */
export async function bootApp(router: Router): Promise<void> {
  const resumed = resumeLocalSession();
  if (!resumed) await signInFromServer();

  let source: ModuleSource = 'none';
  if (getAccount()) source = await (await openSession({ modules: resumed ? 'device-first' : 'server-first' })).ready;

  // Closing the tab with changes not yet on the server asks first. Installed whether
  // or not anyone is signed in yet: a sign-in on this page starts the outbox too.
  guardUnsyncedOnClose();
  markBooted();
  if (resumed) void refreshInBackground(router, source);
}

/**
 * After a start from the device: renews the session and looks for module
 * changes, while the till is already in use. Nothing here may disturb it -
 * except the server refusing the session, which ends it as it always has.
 */
export async function refreshInBackground(router: Router, source: ModuleSource): Promise<void> {
  const renewed = await refreshAccessToken().catch(() => false);
  if (!getDeviceAccount()) return leaveRefusedSession(router);
  // No answer (stalled, the gateway restarting) is not a refusal: stay signed in
  // from the device. Sync keeps trying on its own schedule; modules wait for the next start.
  if (!renewed || source !== 'device') return;
  await updateModulesForNextStart().catch((err) => console.warn('[zollify] could not check for module changes', err));
}

/**
 * The server refused the session (signed out elsewhere, the device removed).
 * refreshAccessToken() has already dropped it, exactly as when this is found
 * out mid-shift; what is left is what the router does on the next navigation
 * then - the login screen, with the way back. Done now rather than on the next
 * tap because this start showed the app before the server had its say.
 * Unsynced work stays in this device's outbox for the next sign-in.
 */
function leaveRefusedSession(router: Router): void {
  stopAutoSync();
  stopAutoEvents();
  stopRealtime();
  const at = router.currentRoute.value;
  if (at.meta.public === true) return;
  void router.replace({ name: 'login', query: at.fullPath === '/home' ? {} : { next: at.fullPath } });
}

const moduleSet = (manifest: ManifestResponse): string =>
  manifest.modules
    .map((m) => `${m.moduleId}@${m.version}#${m.integrity}`)
    .sort()
    .join(' ');

/**
 * Fetches the server's current module list and gets the device ready to run
 * it at the next start. Deliberately not applied now: swapping a module out
 * from under a seller mid-sale is worse than one more shift on the old one.
 *
 * The new list only replaces the remembered one once every bundle it names is
 * on the device, so a start from the device never names a bundle it lacks.
 */
async function updateModulesForNextStart(): Promise<void> {
  const account = getAccount();
  if (!account) return;
  const fresh = await fetchManifest();
  const cached = cachedManifest(account.accountId);
  const bundles = await downloadMissingBundles(fresh.modules);
  if (bundles.failed > 0) return; // tried again at the next start
  rememberManifest(account.accountId, fresh);
  if (bundles.downloaded > 0 || !cached || moduleSet(cached) !== moduleSet(fresh)) announceModuleUpdate();
}

/** Puts a bundle on the device without running it. True when it had to be downloaded. */
async function downloadIfMissing(descriptor: ModuleDescriptor): Promise<boolean> {
  const have = await getCached(descriptor.moduleId, descriptor.version);
  if (have && (await verifyCached(have))) return false;
  const code = await downloadBundle(descriptor.url);
  await putCached({ moduleId: descriptor.moduleId, version: descriptor.version, code, integrity: descriptor.integrity });
  return true;
}

/** Bundled modules ship with the app, so only a build that downloads its modules has anything to fetch. */
async function downloadMissingBundles(modules: ModuleDescriptor[]): Promise<{ downloaded: number; failed: number }> {
  if (mode !== 'remote') return { downloaded: 0, failed: 0 };
  const results = await Promise.allSettled(modules.map(downloadIfMissing));
  return {
    downloaded: results.filter((r) => r.status === 'fulfilled' && r.value).length,
    failed: results.filter((r) => r.status === 'rejected').length,
  };
}

/** Same manners as a shell update: say it is there, and let the seller pick the moment. */
function announceModuleUpdate(): void {
  createShellUi('shell').toast("Your modules changed - they'll be ready next time the app opens.", {
    timeoutMs: 0,
    action: {
      label: 'Restart now',
      onClick: () => {
        // The outbox survives the reload, so no leave prompt.
        leaveOnPurpose();
        window.location.reload();
      },
    },
  });
}
