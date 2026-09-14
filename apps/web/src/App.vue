<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { roleAtLeast, type NavGroup, type Role } from '@zollify/sdk';
import {
  currentAccount,
  pendingCount,
  signOut,
  stopAutoSync,
  stopRealtime,
  syncNow,
  syncState,
  toasts,
} from '@zollify/platform';
import { booted, contributions, loader } from './boot';
import ConfirmDialog from './views/ConfirmDialog.vue';
import { Icon } from '@zollify/ui';

const account = currentAccount;
const route = useRoute();

/** First-run setup gets the whole screen; the nav would only bounce back to it. */
const build = typeof __ZOLLIFY_VERSION__ === 'string' ? __ZOLLIFY_VERSION__ : 'dev';
const settingUp = computed(() => route.name === 'welcome' || route.meta.bare === true);

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
  { routeName: 'discounts', label: 'Discounts', icon: 'tag', group: 'stock', order: 30, minRole: 'admin' },
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
const openSection = computed(() => sections.value.find((sec) => inSection(sec)) ?? null);

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
  stopRealtime();
  await loader.unloadAll();
  await signOut();
  window.location.hash = '#/login';
  window.location.reload();
}
</script>

<template>
  <!-- Signed out there is no sidebar, so the shell must not keep reserving its
       column — otherwise the login card is squeezed into a 15rem track. -->
  <div v-if="!booted" class="splash" aria-busy="true"><span class="brand">Zollify<span>.</span></span><small>Opening the booth…</small></div>
  <div v-else :class="['shell', { 'shell--bare': !account || settingUp }]">
    <aside v-if="account && !settingUp" class="sidebar">
      <div class="brand">Zollify<span>.</span></div>

      <nav aria-label="Main">
        <router-link :to="{ name: 'home' }" class="item top"><Icon name="home" /><span>Home</span></router-link>

        <div v-for="sec in sections" :key="sec.id" :class="['section', { open: inSection(sec) }]">
          <router-link :to="{ name: sec.head.routeName }" class="item top" :class="{ 'router-link-active': inSection(sec) && sec.head.routeName !== route.name }">
            <Icon :name="sec.icon" /><span>{{ sec.head.label }}</span>
          </router-link>
          <div v-if="sec.children.length && inSection(sec)" class="children">
            <router-link v-for="item in sec.children" :key="item.routeName" :to="{ name: item.routeName }" class="item sub">
              {{ item.label }}
            </router-link>
          </div>
        </div>

        <router-link v-if="isAdmin" :to="{ name: 'modules' }" class="item top spaced"><Icon name="puzzle" /><span>Modules</span></router-link>
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

        <router-link :to="{ name: 'settings' }" class="item top"><Icon name="settings" /><span>Settings</span></router-link>

        <footer class="who">
          <div class="name">{{ account.accountName }}</div>
          <div class="role">{{ account.email }} · {{ account.role }}</div>
          <button type="button" class="quiet out" @click="leave">Sign out</button>
          <div class="build">build {{ build }}</div>
        </footer>
      </div>
    </aside>

    <main class="content">
      <router-view />
    </main>

    <!-- Phone: ZollTool's bottom tab bar — thumbs reach it, and the till above
         keeps the whole viewport. The open section's pages sit in a row above. -->
    <nav v-if="account && !settingUp" class="bottom" aria-label="Main">
      <div v-if="openSection?.children.length" class="subrow">
        <router-link v-for="item in [openSection.head, ...openSection.children]" :key="item.routeName" :to="{ name: item.routeName }" class="chip" exact-active-class="on">{{ item.label }}</router-link>
      </div>
      <div class="tabs">
        <router-link :to="{ name: 'home' }" class="tab"><Icon name="home" :size="20" /><span>Home</span></router-link>
        <router-link v-for="sec in sections" :key="sec.id" :to="{ name: sec.head.routeName }" class="tab" :class="{ 'router-link-active': inSection(sec) }"><Icon :name="sec.icon" :size="20" /><span>{{ sec.head.label }}</span></router-link>
        <router-link :to="{ name: 'settings' }" class="tab"><Icon name="settings" :size="20" /><span>Settings</span><i v-if="pendingCount" class="badge"></i></router-link>
      </div>
    </nav>

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
.splash { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .5rem; color: var(--zfy-muted); }
.splash .brand { font-size: 1.6rem; color: var(--zfy-ink); }
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
.item.router-link-active .zfy-icon { color: var(--zfy-accent); }
.item.top .zfy-icon { color: var(--zfy-muted); }
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
.build { font-size: .68rem; color: var(--zfy-faint); font-family: ui-monospace, monospace; margin-top: .3rem; }
.out { align-self: flex-start; margin-top: .25rem; padding-left: .5rem; padding-right: .5rem; font-size: .8rem; }
.content { padding: 1.5rem; min-width: 0; }
.toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; }
.toast { margin: 0; padding: .6rem .9rem; border-radius: 8px; background: var(--zfy-surface); border: 1px solid var(--zfy-line); box-shadow: 0 8px 24px -14px var(--zfy-shadow); }
.toast.error { border-color: var(--zfy-danger); }
.toast.success { border-color: var(--zfy-accent); }

.bottom { display: none; }

/* Phone: a slim top bar (brand, sync) and a bottom tab bar; the sidebar's
   nav is hidden because the tabs carry it. */
@media (max-width: 720px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }
  .sidebar {
    display: flex; flex-direction: row; align-items: center; gap: .5rem; padding: .5rem .75rem;
    border-right: 0; border-bottom: 1px solid var(--zfy-line); height: auto; z-index: 5;
  }
  .brand { font-size: 1.1rem; }
  .sidebar nav, .who .name, .who .role, .tail .item { display: none; }
  .tail { margin: 0 0 0 auto; flex-direction: row; align-items: center; gap: .5rem; }
  .sync { min-height: 2rem; padding: .25rem .6rem; }
  .out { margin: 0; min-height: 2rem; }
  .content { padding: 1rem; padding-bottom: 1.5rem; }
  .bottom { display: flex; flex-direction: column; position: sticky; bottom: 0; z-index: 6; background: var(--zfy-surface); border-top: 1px solid var(--zfy-line); padding-bottom: env(safe-area-inset-bottom, 0); }
  .subrow { display: flex; gap: .3rem; padding: .4rem .6rem 0; overflow-x: auto; scrollbar-width: none; }
  .subrow::-webkit-scrollbar { display: none; }
  .chip { white-space: nowrap; font-size: .78rem; padding: .25rem .7rem; border-radius: 999px; border: 1px solid var(--zfy-line); color: var(--zfy-muted); text-decoration: none; }
  .chip.on { background: var(--zfy-accent-soft); color: var(--zfy-accent-ink); border-color: var(--zfy-accent-soft); font-weight: 600; }
  .tabs { display: flex; }
  .tab { position: relative; flex: 1; display: flex; flex-direction: column; align-items: center; gap: .15rem; padding: .45rem 0 .4rem; font-size: .66rem; color: var(--zfy-muted); text-decoration: none; }
  .tab.router-link-active { color: var(--zfy-accent-ink); }
  .tab.router-link-active .zfy-icon { color: var(--zfy-accent); }
  .badge { position: absolute; top: .3rem; right: calc(50% - .9rem); width: .45rem; height: .45rem; border-radius: 50%; background: var(--zfy-warning); }
}
</style>
