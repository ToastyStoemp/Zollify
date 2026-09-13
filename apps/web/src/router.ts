import { createRouter, createWebHashHistory, type Router } from 'vue-router';
import { getAccount, isAuthenticated } from '@boothly/platform';
import { roleAtLeast, type Role } from '@boothly/sdk';

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
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/modules', name: 'modules', component: () => import('./views/ModulesView.vue'), meta: { minRole: 'admin' } },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('./views/NotFoundView.vue') },
  ],
});

/**
 * Authentication and role gates.
 *
 * Refusing the route is the control; hiding the nav link is only courtesy. The
 * server refusing the data is the actual guarantee — all three exist because
 * only the last one is load-bearing.
 */
router.beforeEach((to) => {
  if (to.meta.public === true) return true;

  if (!isAuthenticated.value) {
    return { name: 'login', query: to.fullPath === '/home' ? {} : { next: to.fullPath } };
  }

  const required = to.meta.minRole as Role | undefined;
  if (required) {
    const account = getAccount();
    if (!account || !roleAtLeast(account.role, required)) return { name: 'home' };
  }

  return true;
});

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
