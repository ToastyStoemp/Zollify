import { ref } from 'vue';
import type { Router } from 'vue-router';
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
  recordSale,
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
  customs: () => import('@zollify/customs'),
  'price-cards': () => import('@zollify/price-cards'),
  sourcing: () => import('@zollify/sourcing'),
  migration: () => import('@zollify/migration'),
  'shopify-sync': () => import('@zollify/shopify-sync'),
  'public-events': () => import('@zollify/public-events'),
  tax: () => import('@zollify/tax'),
  costs: () => import('@zollify/costs'),
};

/** False until the session, core data and modules are in; the shell shows a splash meanwhile. */
export const booted = ref(false);
let resolveBoot: () => void = () => {};
/** Settles when boot is done — the router's first navigation waits on it. */
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
  void recordSale(sale).catch((err) => {
    // Never rethrow into the emitter: the payment already happened, and the
    // till must not appear to fail after the customer has paid.
    console.error('[zollify] could not record a sale', err);
  });
});

/**
 * Routes reach the router the instant a module contributes them, rather than in
 * a pass afterwards — the nav is reactive and would otherwise render a link to
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
/** Why each switched-on module is or is not running, from the last load — the Modules panel shows it. */
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

/** Unloads a module; the sink withdraws its routes as the registry drops them. */
export async function unloadModule(_router: Router, moduleId: string): Promise<void> {
  await loader.unload(moduleId);
}
