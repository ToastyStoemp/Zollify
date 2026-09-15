import { booted, whenBooted } from './boot';
import { createRouter, createWebHashHistory, type Router } from 'vue-router';
import { getAccount, isAuthenticated } from '@zollify/platform';
import { roleAtLeast, type Role } from '@zollify/sdk';

/**
 * Hash history, carried over from ZollTool for the same reason: it behaves
 * identically on a file://-style Capacitor WebView, a GitHub Pages subpath and
 * the dev server, with no server rewrite rules to keep in sync.
 */
export const router: Router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/home' },
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    { path: '/home', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/welcome', name: 'welcome', component: () => import('./views/WelcomeView.vue'), meta: { minRole: 'admin' } },
    { path: '/events', name: 'events', component: () => import('./views/EventsView.vue') },
    { path: '/catalog', name: 'catalog', component: () => import('./views/CatalogView.vue') },
    { path: '/stock', name: 'stock', component: () => import('./views/StockView.vue') },
    { path: '/discounts', name: 'discounts', component: () => import('./views/DiscountsView.vue'), meta: { minRole: 'admin' } },
    { path: '/history', name: 'history', component: () => import('./views/HistoryView.vue') },
    { path: '/prices/:eventId', name: 'prices', component: () => import('./views/PricesView.vue'), meta: { minRole: 'admin' } },
    { path: '/display', name: 'display', component: () => import('./views/DisplayView.vue'), meta: { bare: true } },
    { path: '/cashup', name: 'cashup', component: () => import('./views/CashUpView.vue'), meta: { minRole: 'admin' } },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/modules', redirect: { name: 'settings', query: { panel: 'core.modules' } } },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue') },
  ],
});

/**
 * Authentication and role gates.
 *
 * Refusing the route is the control; hiding the nav link is only courtesy. The
 * server refusing the data is the actual guarantee - all three exist because
 * only the last one is load-bearing.
 */
router.beforeEach(async (to) => {
  // The shell mounts before the session is restored; no guard may judge a
  // navigation until it is, or a reload would bounce a signed-in user to login.
  if (!booted.value) await whenBooted;
  if (to.meta.public === true) return true;

  if (!isAuthenticated.value) {
    return { name: 'login', query: to.fullPath === '/home' ? {} : { next: to.fullPath } };
  }

  const account = getAccount();
  const required = to.meta.minRole as Role | undefined;
  if (required) {
    if (!account || !roleAtLeast(account.role, required)) return { name: 'home' };
  }

  // A fresh account is walked through setup before anything else. Only an
  // admin can complete it - a helper landing first just sees the app.
  if (
    account &&
    account.profile.setupCompletedAt === null &&
    roleAtLeast(account.role, 'admin') &&
    to.name !== 'welcome'
  ) {
    return { name: 'welcome' };
  }

  return true;
});

// Dev only: how long each page switch takes, from the click to the first
// painted frame of the new route - the number a "this feels slow" report is about.
if (import.meta.env.DEV) {
  let started = 0;
  router.beforeEach(() => {
    started = performance.now();
  });
  router.afterEach((to) => {
    requestAnimationFrame(() => requestAnimationFrame(() => console.info(`[zollify] route ${String(to.name)} in ${Math.round(performance.now() - started)} ms`)));
  });
  // Anything that blocks the main thread for 50 ms+ is logged with its attribution.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) console.info(`[zollify] long task ${Math.round(e.duration)} ms`, (e as PerformanceEntry & { attribution?: unknown[] }).attribution?.[0] ?? '');
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* unsupported */
  }
}

/**
 * Stale-deploy recovery, carried over from ZollTool. Route components are lazy
 * chunks; after a new build ships, a page still running the old index requests
 * chunk files that no longer exist and navigation dies silently. Reload once to
 * pick up the fresh index, landing on the intended route.
 */
router.onError((err, to) => {
  const message = String((err as { message?: string } | undefined)?.message ?? err);
  const staleChunk =
    /dynamically imported module|Importing a module script failed|Failed to fetch dynamically|error loading dynamically imported|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(
      message,
    );
  if (!staleChunk || typeof window === 'undefined') return;

  let last = 0;
  try {
    last = Number(sessionStorage.getItem('bly:chunkReload') ?? '0');
  } catch {
    /* private mode */
  }
  if (Date.now() - last < 10_000) return;
  try {
    sessionStorage.setItem('bly:chunkReload', String(Date.now()));
  } catch {
    /* ignore */
  }
  if (to?.fullPath) window.location.hash = to.fullPath;
  window.location.reload();
});
