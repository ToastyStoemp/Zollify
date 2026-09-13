import { createApp } from 'vue';
import { configureApiBase, refreshAccessToken } from '@boothly/platform';
import '@boothly/ui/tokens.css';
import './styles.css';
import App from './App.vue';
import { router } from './router';
import { loadEnabledModules } from './boot';

configureApiBase(import.meta.env.VITE_API_BASE ?? '/api');

/**
 * Boot order matters: restore the session first, because which modules load
 * depends on the account, and a module's routes must exist before the router
 * resolves the first navigation.
 */
async function start(): Promise<void> {
  await refreshAccessToken().catch(() => false);
  await loadEnabledModules(router).catch((err) => {
    console.error('[boothly] module boot failed', err);
    return [];
  });

  createApp(App).use(router).mount('#app');
}

void start();
