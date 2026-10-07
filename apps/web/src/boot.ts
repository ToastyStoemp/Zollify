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
  getServerUrl,
  isNative,
  noteSale,
  onAccountChange,
  recordSale,
  signOut,
  stopAutoSync,
  stopRealtime,
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

function resolverFor(mode: 'bundled' | 'remote'): ModuleResolver {
  if (mode === 'bundled') return new StaticResolver(BUNDLED_MODULES);
  return new RemoteResolver(async (url) => {
    // Bundle paths are server-relative; the Android shell must reach across to the server.
    const abs = isNative() && getServerUrl() && url.startsWith('/') ? `${getServerUrl()}${url}` : url;
    const res = await fetch(abs, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Could not download module bundle (${res.status}).`);
    return res.text();
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
export async function signOutAndReload(): Promise<void> {
  stopAutoSync();
  stopRealtime();
  await loader.unloadAll();
  await signOut();
  window.location.hash = '#/login';
  window.location.reload();
}

interface ManifestResponse {
  sdk: string;
  modules: ModuleDescriptor[];
}

/**
 * Asks the server which modules this account has enabled, then loads them.
 *
 * Failures are returned, not thrown: a module that will not load must never
 * stop the shell from starting. A booth with a broken Tax module still needs to
 * open the till.
 */
/** Why each switched-on module is or is not running, from the last load - the Modules panel shows it. */
export const loadOutcomes = ref<LoadOutcome[]>([]);

export async function loadEnabledModules(router: Router): Promise<LoadOutcome[]> {
  const account = getAccount();
  if (!account) return [];

  let manifest: ManifestResponse;
  try {
    manifest = (await authFetch('/modules/manifest')) as ManifestResponse;
  } catch (err) {
    console.error('[zollify] could not fetch the module manifest', err);
    return [];
  }

  // Routes are registered through the sink as each module mounts; a module
  // whose setup throws has its contributions rolled back, so a failed module
  // never leaves a navigable but broken screen behind.
  const outcomes = await loader.loadAll(manifest.modules, account.role);
  loadedFor = account.role;
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
      if (ROLE_RANK[account.role] > ROLE_RANK[loadedFor!]) await loadEnabledModules(router);
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
