<script setup lang="ts">
import { computed } from 'vue';
import { currentAccount, toasts } from '@boothly/platform';
import { contributions } from './boot';
import ConfirmDialog from './views/ConfirmDialog.vue';

const account = currentAccount;

/** Core nav first, then whatever the loaded modules contributed, by order. */
const coreNav = [
  { routeName: 'home', label: 'Home', order: 0 },
  { routeName: 'settings', label: 'Settings', order: 900 },
];

const moduleNav = computed(() =>
  account.value ? contributions.navFor(account.value.role) : [],
);

const isAdmin = computed(
  () => account.value?.role === 'owner' || account.value?.role === 'admin',
);
</script>

<template>
  <div class="shell">
    <aside v-if="account" class="sidebar">
      <div class="brand">Boothly<span>.</span></div>

      <nav aria-label="Main">
        <router-link v-for="item in coreNav" :key="item.routeName" :to="{ name: item.routeName }">
          {{ item.label }}
        </router-link>
        <router-link v-if="isAdmin" :to="{ name: 'modules' }">Modules</router-link>

        <hr v-if="moduleNav.length" />

        <router-link v-for="item in moduleNav" :key="item.routeName" :to="{ name: item.routeName }">
          {{ item.label }}
        </router-link>
      </nav>

      <footer class="who">
        <div class="name">{{ account.accountName }}</div>
        <div class="role">{{ account.email }} · {{ account.role }}</div>
      </footer>
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
.sidebar {
  display: flex; flex-direction: column; gap: 1rem; padding: 1rem;
  background: var(--bly-surface, #fff); border-right: 1px solid var(--bly-line, #d6dde4);
}
.brand { font-weight: 800; font-size: 1.25rem; letter-spacing: -.02em; }
.brand span { color: var(--bly-accent, #0e7c66); }
nav { display: flex; flex-direction: column; gap: .15rem; }
nav a { padding: .45rem .6rem; border-radius: 8px; text-decoration: none; color: inherit; }
nav a:hover { background: var(--bly-surface-2, #e9edf1); }
nav a.router-link-active { background: var(--bly-accent-soft, #deeee9); color: var(--bly-accent-ink, #0a5a4a); font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--bly-line, #d6dde4); margin: .5rem 0; width: 100%; }
.who { margin-top: auto; font-size: .8rem; color: var(--bly-muted, #5a6472); }
.who .name { font-weight: 600; color: var(--bly-ink, #141a22); }
.content { padding: 1.5rem; }
.toasts { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; }
.toast { margin: 0; padding: .6rem .9rem; border-radius: 8px; background: var(--bly-surface, #fff); border: 1px solid var(--bly-line, #d6dde4); box-shadow: 0 8px 24px -14px rgba(20,26,34,.4); }
.toast.error { border-color: var(--bly-danger, #c6512f); }
.toast.success { border-color: var(--bly-accent, #0e7c66); }
@media (max-width: 720px) { .shell { grid-template-columns: 1fr; } .sidebar { position: sticky; top: 0; } }
</style>
