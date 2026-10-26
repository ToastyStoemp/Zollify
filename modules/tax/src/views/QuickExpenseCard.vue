<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@zollify/ui';
import { sdk } from '../runtime';

/**
 * Home screen: one tap to log something bought at the event - snacks,
 * parking, tape - so its profit counts it. On Android the same screen is
 * the "Add expense" shortcut on the app icon.
 */
const event = computed(() => sdk().data.events.active());
</script>

<template>
  <div class="card-body">
    <header class="head">
      <h2>Spent something?</h2>
      <Icon name="banknote" :size="16" />
    </header>
    <p class="sub">{{ event ? `Snacks, parking, tape - it goes into ${event.name}'s profit.` : 'Snacks, parking, tape - it goes into the event\'s profit.' }}</p>
    <router-link :to="{ name: 'tax:quick-expense' }" class="add"><Icon name="plus" :size="16" /> Add an expense</router-link>
  </div>
</template>

<style scoped>
.card-body { display: flex; flex-direction: column; gap: .5rem; }
.head { display: flex; align-items: center; justify-content: space-between; }
.head h2 { margin: 0; font-size: 1rem; }
.sub { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.add { display: inline-flex; align-items: center; justify-content: center; gap: .35rem; min-height: 2.8rem; padding: 0 1rem; border-radius: 10px; background: var(--zfy-accent, #0e7c66); color: var(--zfy-on-accent, #fff); font-weight: 700; text-decoration: none; }
</style>
