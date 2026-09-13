<script setup lang="ts">
import { computed, ref } from 'vue';
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

const account = currentAccount;
const route = useRoute();

type Group = NavGroup | 'addons';
interface Entry { routeName: string; label: string; group: Group; order: number; minRole?: Role }

/**
 * The sidebar is arranged by what someone is doing, not by where a screen
 * lives in the code. A module's screen sits next to the core screens for the
 * same job; the seller never sees the word "module".
 */
const GROUPS: { id: Group; label: string }[] = [
  { id: 'selling', label: 'Selling' },
  { id: 'stock', label: 'Stock' },
  { id: 'events', label: 'Events' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'addons', label: 'Add-ons' },
  { id: 'account', label: 'Account' },
];

const coreNav: Entry[] = [
  { routeName: 'history', label: 'History', group: 'selling', order: 110 },
  { routeName: 'cashup', label: 'Cash up', group: 'selling', order: 115, minRole: 'admin' },
  { routeName: 'catalog', label: 'Catalog', group: 'stock', order: 20 },
  { routeName: 'stock', label: 'Inventory', group: 'stock', order: 25 },
  { routeName: 'events', label: 'Events', group: 'events', order: 10 },
  { routeName: 'modules', label: 'Modules', group: 'account', order: 890, minRole: 'admin' },
  { routeName: 'settings', label: 'Settings', group: 'account', order: 900 },
];

const groups = computed(() => {
  const acct = account.value;
  if (!acct) return [];
  const mine = coreNav.filter((e) => !e.minRole || roleAtLeast(acct.role, e.minRole));
  const theirs: Entry[] = contributions.navFor(acct.role).map((item) => ({
    routeName: item.routeName,
    label: item.label,
    group: item.group ?? 'addons',
    order: item.order ?? 100,
  }));
  const all = [...mine, ...theirs].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return GROUPS.map((g) => ({ ...g, items: all.filter((e) => e.group === g.id) })).filter(
    (g) => g.items.length > 0,
  );
});

/**
 * Which groups are folded. Persisted per browser so the sidebar opens the way
 * it was left; the group holding the current screen is always shown open so
 * the active item can never be hidden.
 */
const COLLAPSED_KEY = 'zollify.nav.collapsed';
const collapsed = ref<Set<string>>(new Set());
try {
  const raw = localStorage.getItem(COLLAPSED_KEY);
  if (raw) collapsed.value = new Set(JSON.parse(raw) as string[]);
} catch {
  // Storage unavailable: groups simply start open.
}

function isOpen(group: { id: string; items: Entry[] }): boolean {
  if (group.items.some((e) => e.routeName === route.name)) return true;
  return !collapsed.value.has(group.id);
}

function toggle(id: string): void {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  } catch {
    // Not worth surfacing; the sidebar still works for this session.
  }
}

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
        <router-link :to="{ name: 'home' }" class="item">Home</router-link>

        <section v-for="group in groups" :key="group.id" :class="['group', { closed: !isOpen(group) }]">
          <button
            type="button"
            class="quiet head"
            :aria-expanded="isOpen(group)"
            :aria-controls="`nav-${group.id}`"
            @click="toggle(group.id)"
          >
            <span>{{ group.label }}</span>
            <span class="chev" aria-hidden="true">▾</span>
          </button>
          <div :id="`nav-${group.id}`" class="items">
            <router-link v-for="item in group.items" :key="item.routeName" :to="{ name: item.routeName }" class="item">
              {{ item.label }}
            </router-link>
          </div>
        </section>
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
  position: sticky; top: 0; height: 100vh;
}
.brand { font-weight: 800; font-size: 1.25rem; letter-spacing: -.02em; }
.brand span { color: var(--zfy-accent); }
nav { display: flex; flex-direction: column; gap: .15rem; overflow-y: auto; }
.item { display: block; padding: .5rem .6rem; border-radius: 8px; text-decoration: none; color: inherit; }
.item:hover { background: var(--zfy-surface-2); }
.item.router-link-active { background: var(--zfy-accent-soft); color: var(--zfy-accent-ink); font-weight: 600; }
.group { display: flex; flex-direction: column; gap: .1rem; margin-top: .5rem; }
.head {
  display: flex; justify-content: space-between; align-items: center; width: 100%;
  min-height: 1.75rem; padding: .2rem .6rem; font-size: .7rem; font-weight: 600;
  letter-spacing: .1em; text-transform: uppercase; color: var(--zfy-faint);
}
.head:hover:not(:disabled) { color: var(--zfy-muted); background: transparent; }
.chev { font-size: .75rem; transition: transform .15s; }
.closed .chev { transform: rotate(-90deg); }
.items { display: flex; flex-direction: column; gap: .1rem; }
.closed .items { display: none; }
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
  .group { flex-direction: row; margin: 0; }
  .head { display: none; }
  .items, .closed .items { display: flex; flex-direction: row; gap: .25rem; }
  .group::before { content: ''; border-left: 1px solid var(--zfy-line); margin: .35rem .2rem; }
  .tail { margin: 0; flex-direction: row; align-items: center; justify-content: flex-end; gap: .5rem; }
  .sync { min-height: 2rem; padding: .25rem .6rem; }
  .who .name, .who .role { display: none; }
  .out { margin: 0; min-height: 2rem; }
  .content { padding: 1rem; }
}
</style>
