<script setup lang="ts">
import { computed } from 'vue';
import { currentAccount } from '@zollify/platform';
import { loader } from '../boot';

const account = currentAccount;
const modules = computed(() => loader.list());
</script>

<template>
  <section class="home">
    <h1>Good day{{ account ? `, ${account.accountName}` : '' }}</h1>
    <p class="lede">
      {{ modules.length }} module{{ modules.length === 1 ? '' : 's' }} loaded.
    </p>

    <ul v-if="modules.length" class="modules">
      <li v-for="mod in modules" :key="mod.moduleId">
        <strong>{{ mod.title }}</strong>
        <span class="ver">{{ mod.moduleId }} · {{ mod.version }}</span>
      </li>
    </ul>
    <p v-else class="empty">
      No modules are switched on yet. An owner or admin can enable them under Modules.
    </p>
  </section>
</template>

<style scoped>
.home { display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
.lede, .empty { color: var(--zfy-muted, #5a6472); margin: 0; }
.modules { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); }
.modules li { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .75rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .15rem; }
.ver { font-size: .78rem; color: var(--zfy-muted, #5a6472); font-variant-numeric: tabular-nums; }
</style>
