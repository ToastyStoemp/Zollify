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
  type LoadOutcome,
  type ModuleDescriptor,
  type ModuleResolver,
} from '@boothly/platform';

/**
 * Modules compiled into this build.
 *
 * First-party modules ship with the shell during development so the loader path
 * can be exercised without a registry. The remote resolver uses the identical
 * code path, which is what makes switching them on at runtime a configuration
 * change rather than an architectural one.
 */
const BUNDLED_MODULES: Record<string, () => Promise<unknown>> = {
  pos: () => import('@boothly/pos'),
  customs: () => import('@boothly/customs'),
  'price-cards': () => import('@boothly/price-cards'),
  sourcing: () => import('@boothly/sourcing'),
  migration: () => import('@boothly/migration'),
};

export const contributions = new ContributionRegistry();
export const events = new PlatformEventBus();

function resolverFor(mode: 'bundled' | 'remote'): ModuleResolver {
  if (mode === 'bundled') return new StaticResolver(BUNDLED_MODULES);
  return new RemoteResolver(async (url) => {
    const res = await fetch(url, { credentials: 'same-origin' });
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
export async function loadEnabledModules(router: Router): Promise<LoadOutcome[]> {
  const account = getAccount();
  if (!account) return [];

  let manifest: ManifestResponse;
  try {
    manifest = (await authFetch('/modules/manifest')) as ManifestResponse;
  } catch (err) {
    console.error('[boothly] could not fetch the module manifest', err);
    return [];
  }

  const outcomes = await loader.loadAll(manifest.modules, account.role);

  // Routes only reach the router once their module has mounted successfully, so
  // a failed module never leaves a navigable but broken screen behind.
  for (const route of contributions.routes) {
    if (router.hasRoute(route.name)) continue;
    router.addRoute({
      path: route.fullPath,
      name: route.name,
      component: route.component as never,
      meta: { moduleId: route.moduleId, minRole: route.minRole, title: route.title },
    });
  }

  for (const outcome of outcomes) {
    if (outcome.status === 'loaded') continue;
    console.warn(
      `[boothly] module "${outcome.moduleId}" ${outcome.status}: ${outcome.reason ?? 'no reason given'}`,
    );
  }

  return outcomes;
}

/** Unloads a module and removes its routes — used when it is switched off in settings. */
export async function unloadModule(router: Router, moduleId: string): Promise<void> {
  const owned = contributions.routes.filter((r) => r.moduleId === moduleId).map((r) => r.name);
  await loader.unload(moduleId);
  for (const name of owned) {
    if (router.hasRoute(name)) router.removeRoute(name);
  }
}
