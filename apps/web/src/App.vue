<script setup lang="ts">
import { computed } from 'vue';
import {
  currentAccount,
  pendingCount,
  signOut,
  stopAutoSync,
  syncNow,
  syncState,
  toasts,
} from '@zollify/platform';
import { contributions, loader } from './boot';
import ConfirmDialog from './views/ConfirmDialog.vue';

const account = currentAccount;

/** Core nav first, then whatever the loaded modules contributed, by order. */
const coreNav: { routeName: string; label: string; order: number; minRole?: 'owner' | 'admin' }[] = [
  { routeName: 'home', label: 'Home', order: 0 },
  { routeName: 'events', label: 'Events', order: 10 },
  { routeName: 'catalog', label: 'Catalog', order: 20 },
  { routeName: 'stock', label: 'Inventory', order: 25 },
  { routeName: 'history', label: 'History', order: 30 },
  { routeName: 'cashup', label: 'Cash up', order: 35, minRole: 'admin' },
  { routeName: 'settings', label: 'Settings', order: 900 },
];

const moduleNav = computed(() =>
  account.value ? contributions.navFor(account.value.role) : [],
);

const isAdmin = computed(
  () => account.value?.role === 'owner' || account.value?.role === 'admin',
);

/**
 * One label that cannot contradict itself: queued work is named as such, and
 * "Synced" is only claimed when nothing is waiting.
 */
const syncLabel = computed(() => {
  if (syncState.value === 'syncing') return 'Syncing…';
  if (syncState.value === 'offline') return pendingCount.value ? `Offline · ${pendingCount.value} waiting` : 'Offline';
  if (syncState.value === 'error') return 'Sync failed — tap to retry';
  return pendingCount.value ? `${pendingCount.value} to sync` : 'Synced';
});

/**
 * Everything in memory belongs to the account that just left, so the cleanest
 * teardown is a fresh boot. Modules are unloaded first so their teardown hooks
 * run while the SDK they were given is still valid.
 */
async function leave(): Promise<void> {
  stopAutoSync();
  await loader.unloadAll();
  await signOut();
  window.location.hash = '#/login';
  window.location.reload();
}
</script>

<template>
  <!-- Signed out there is no sidebar, so the shell must not keep reserving its
       column — otherwise the login card is squeezed into a 15rem track. -->
  <div :class="['shell', { 'shell--bare': !account }]">
    <aside v-if="account" class="sidebar">
      <div class="brand">Zollify<span>.</span></div>

      <nav aria-label="Main">
        <template v-for="item in coreNav" :key="item.routeName">
          <router-link
            v-if="!item.minRole || isAdmin"
            :to="{ name: item.routeName }"
          >
            {{ item.label }}
          </router-link>
        </template>
        <router-link v-if="isAdmin" :to="{ name: 'modules' }">Modules</router-link>

        <span v-if="moduleNav.length" class="rule" role="separator"></span>

        <router-link v-for="item in moduleNav" :key="item.routeName" :to="{ name: item.routeName }">
          {{ item.label }}
        </router-link>
      </nav>

      <div class="tail">
        <button
          type="button"
          class="sync"
          :disabled="syncState === 'syncing'"
          :aria-label="`Sync now. ${syncLabel}`"
          @click="syncNow()"
        >
          <span class="dot" :class="syncState" aria-hidden="true"></span>
          <span>{{ syncLabel }}</span>
        </button>

        <footer class="who">
          <div class="name">{{ account.accountName }}</div>
          <div class="role">{{ account.email }} · {{ account.role }}</div>
          <button type="button" class="quiet out" @click="leave">Sign out</button>
        </footer>
      </div>
    </aside>

    <main class="content">
      <router-view />
    </main>

    <!-- Toast text is bound, never injected as markup: a module controls this string. -->
    <div class="toasts" aria-live="polite">
      <p v-for="toast in toasts" :key="toast.id" :class="['toast', toast.kind]">
        {{ toast.message }}
      </p>
    </div>

    <ConfirmDialog />
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: 15rem 1fr; min-height: 100vh; }
.shell--bare { grid-template-columns: 1fr; }
.shell--bare .content { padding: 0; display: grid; }
.sidebar {
  display: flex; flex-direction: column; gap: 1rem; padding: 1rem;
  background: var(--zfy-surface); border-right: 1px solid var(--zfy-line);
}
.brand { font-weight: 800; font-size: 1.25rem; letter-spacing: -.02em; }
.brand span { color: var(--zfy-accent); }
nav { display: flex; flex-direction: column; gap: .15rem; }
nav a { padding: .55rem .6rem; border-radius: 8px; text-decoration: none; color: inherit; }
nav a:hover { background: var(--zfy-surface-2); }
nav a.router-link-active { background: var(--zfy-accent-soft); color: var(--zfy-accent-ink); font-weight: 600; }
.rule { border-top: 1px solid var(--zfy-line); margin: .5rem 0; }
.tail { margin-top: auto; display: flex; flex-direction: column; gap: .75rem; }
.sync { display: flex; align-items: center; gap: .45rem; font-size: .8rem; justify-content: flex-start; }
.sync .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--zfy-accent); flex: none; }
.sync .dot.offline { background: var(--zfy-muted); }
.sync .dot.error { background: var(--zfy-danger); }
.sync .dot.syncing { background: var(--zfy-warning); }
.who { font-size: .8rem; color: var(--zfy-muted); display: flex; flex-direction: column; gap: .15rem; }
.who .name { font-weight: 600; color: var(--zfy-ink); }
.who .role { overflow-wrap: anywhere; }
.out { align-self: flex-start; margin-top: .25rem; padding-left: .5rem; padding-right: .5rem; font-size: .8rem; }
.content { padding: 1.5rem; min-width: 0; }
.toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; }
.toast { margin: 0; padding: .6rem .9rem; border-radius: 8px; background: var(--zfy-surface); border: 1px solid var(--zfy-line); box-shadow: 0 8px 24px -14px rgba(20,26,34,.4); }
.toast.error { border-color: var(--zfy-danger); }
.toast.success { border-color: var(--zfy-accent); }

/* Phone: the sidebar becomes a compact top bar with a scrolling nav row, so
   the screen below it — usually the till — is what fills the viewport. */
@media (max-width: 720px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .sidebar {
    display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto;
    align-items: center; gap: .5rem .75rem; padding: .6rem .75rem;
    border-right: 0; border-bottom: 1px solid var(--zfy-line);
    position: sticky; top: 0; z-index: 5;
  }
  .brand { font-size: 1.1rem; }
  nav {
    grid-column: 1 / -1; flex-direction: row; gap: .25rem;
    overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
    margin: 0 -.75rem; padding: 0 .75rem;
  }
  nav::-webkit-scrollbar { display: none; }
  nav a { white-space: nowrap; padding: .5rem .7rem; }
  .rule { border-top: 0; border-left: 1px solid var(--zfy-line); margin: .25rem .25rem; }
  .tail { margin: 0; flex-direction: row; align-items: center; justify-content: flex-end; gap: .5rem; }
  .sync { min-height: 2rem; padding: .25rem .6rem; }
  .who .name, .who .role { display: none; }
  .out { margin: 0; min-height: 2rem; }
  .content { padding: 1rem; }
}
</style>
