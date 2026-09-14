<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { roleAtLeast, type NavGroup, type Role } from '@zollify/sdk';
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
import NavIcon from './components/NavIcon.vue';

const account = currentAccount;
const route = useRoute();

/** First-run setup gets the whole screen; the nav would only bounce back to it. */
const settingUp = computed(() => route.name === 'welcome');

type Group = NavGroup | 'addons';
interface Entry { routeName: string; label: string; icon: string; group: Group; order: number; minRole?: Role }

/**
 * Laid out the way a shop admin is: a short list of top-level sections, each
 * with an icon, and the section you are in unfolds its pages underneath. A
 * module's screen sits inside the section for the job it belongs to; the
 * seller never sees the word "module".
 */
const SECTIONS: { id: Group; icon: string }[] = [
  { id: 'selling', icon: 'shopping-cart' },
  { id: 'stock', icon: 'package' },
  { id: 'events', icon: 'calendar' },
  { id: 'books', icon: 'book' },
  { id: 'suppliers', icon: 'truck' },
  { id: 'addons', icon: 'puzzle' },
];

const coreNav: Entry[] = [
  { routeName: 'history', label: 'History', icon: 'clock', group: 'selling', order: 110 },
  { routeName: 'cashup', label: 'Cash up', icon: 'banknote', group: 'selling', order: 115, minRole: 'admin' },
  { routeName: 'catalog', label: 'Products', icon: 'package', group: 'stock', order: 20 },
  { routeName: 'stock', label: 'Inventory', icon: 'layers', group: 'stock', order: 25 },
  { routeName: 'events', label: 'Events', icon: 'calendar', group: 'events', order: 10 },
];

interface Section { id: Group; icon: string; head: Entry; children: Entry[] }

/**
 * Each section's first page is the section itself: clicking "Selling" opens
 * the till, and History and Cash up hang below it. A section with one page is
 * just that page.
 */
const sections = computed<Section[]>(() => {
  const acct = account.value;
  if (!acct) return [];
  const mine = coreNav.filter((e) => !e.minRole || roleAtLeast(acct.role, e.minRole));
  const theirs: Entry[] = contributions.navFor(acct.role).map((item) => ({
    routeName: item.routeName,
    label: item.label,
    icon: item.icon ?? '',
    group: item.group ?? 'addons',
    order: item.order ?? 100,
  }));
  const all = [...mine, ...theirs].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return SECTIONS.flatMap((sec) => {
    const [head, ...children] = all.filter((e) => e.group === sec.id);
    if (!head) return [];
    return [{ id: sec.id, icon: head.icon || sec.icon, head, children }];
  });
});

const isAdmin = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');

/** The section holding the current page unfolds; the others stay one line each. */
const inSection = (sec: Section): boolean =>
  sec.head.routeName === route.name || sec.children.some((c) => c.routeName === route.name);

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
  <div :class="['shell', { 'shell--bare': !account || settingUp }]">
    <aside v-if="account && !settingUp" class="sidebar">
      <div class="brand">Zollify<span>.</span></div>

      <nav aria-label="Main">
        <router-link :to="{ name: 'home' }" class="item top"><NavIcon name="home" /><span>Home</span></router-link>

        <div v-for="sec in sections" :key="sec.id" :class="['section', { open: inSection(sec) }]">
          <router-link :to="{ name: sec.head.routeName }" class="item top" :class="{ 'router-link-active': inSection(sec) && sec.head.routeName !== route.name }">
            <NavIcon :name="sec.icon" /><span>{{ sec.head.label }}</span>
          </router-link>
          <div v-if="sec.children.length && inSection(sec)" class="children">
            <router-link v-for="item in sec.children" :key="item.routeName" :to="{ name: item.routeName }" class="item sub">
              {{ item.label }}
            </router-link>
          </div>
        </div>

        <router-link v-if="isAdmin" :to="{ name: 'modules' }" class="item top spaced"><NavIcon name="puzzle" /><span>Modules</span></router-link>
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

        <router-link :to="{ name: 'settings' }" class="item top"><NavIcon name="settings" /><span>Settings</span></router-link>

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
.shell--bare .content > .welcome { padding: 1.5rem; width: 100%; }
.sidebar {
  display: flex; flex-direction: column; gap: 1rem; padding: 1rem;
  background: var(--zfy-surface); border-right: 1px solid var(--zfy-line);
  position: sticky; top: 0; height: 100vh;
}
.brand { font-weight: 800; font-size: 1.25rem; letter-spacing: -.02em; }
.brand span { color: var(--zfy-accent); }
nav { display: flex; flex-direction: column; gap: .1rem; overflow-y: auto; }
.item { display: flex; align-items: center; gap: .6rem; padding: .45rem .6rem; border-radius: 8px; text-decoration: none; color: inherit; font-size: .9rem; }
.item:hover { background: var(--zfy-surface-2); }
.item.router-link-active { background: var(--zfy-accent-soft); color: var(--zfy-accent-ink); font-weight: 600; }
.item.router-link-active .nav-icon { color: var(--zfy-accent); }
.item.top .nav-icon { color: var(--zfy-muted); }
.item.spaced { margin-top: .6rem; }
.section { display: flex; flex-direction: column; gap: .1rem; }
/* The open section's own row stays quiet when a child is the page: one accent at a time. */
.section.open > .item.top:not(.router-link-exact-active) { background: transparent; color: inherit; font-weight: 600; }
.children { display: flex; flex-direction: column; gap: .05rem; padding: .1rem 0 .3rem; }
.item.sub { margin-left: 1.55rem; padding: .35rem .6rem .35rem .95rem; font-size: .85rem; color: var(--zfy-muted); border-left: 2px solid var(--zfy-line); border-radius: 0 8px 8px 0; }
.item.sub:hover { color: var(--zfy-ink); }
.item.sub.router-link-active { color: var(--zfy-accent-ink); border-left-color: var(--zfy-accent); background: transparent; }
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
.toast { margin: 0; padding: .6rem .9rem; border-radius: 8px; background: var(--zfy-surface); border: 1px solid var(--zfy-line); box-shadow: 0 8px 24px -14px var(--zfy-shadow); }
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
    height: auto; z-index: 5;
  }
  .brand { font-size: 1.1rem; }
  nav {
    grid-column: 1 / -1; flex-direction: row; gap: .25rem;
    overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
    margin: 0 -.75rem; padding: 0 .75rem;
  }
  nav::-webkit-scrollbar { display: none; }
  .item { white-space: nowrap; padding: .5rem .7rem; }
  .item.spaced { margin: 0; }
  .section { flex-direction: row; gap: .25rem; }
  .children { flex-direction: row; padding: 0; }
  .item.sub { margin: 0; border-left: 0; padding: .5rem .7rem; }
  .tail { margin: 0; flex-direction: row; align-items: center; justify-content: flex-end; gap: .5rem; }
  .sync { min-height: 2rem; padding: .25rem .6rem; }
  .who .name, .who .role { display: none; }
  .out { margin: 0; min-height: 2rem; }
  .content { padding: 1rem; }
}
</style>
