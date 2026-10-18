<script setup lang="ts">
import type { ThresholdWarning } from '@zollify/shared';

/**
 * Small-business threshold warnings: one line each, most serious first, a
 * bar for how far along, and the country's official page. Over a threshold
 * reads as an alert; getting close as a note.
 */
defineProps<{ warnings: ThresholdWarning[]; /** Link to Settings → VAT to change a threshold. */ settingsLink?: boolean }>();

const tone = (w: ThresholdWarning): string => (w.level === 'near' || w.level === 'over-year-end' ? 'near' : 'over');
</script>

<template>
  <section v-if="warnings.length" class="thresholds" aria-label="Small-business thresholds">
    <article v-for="w in warnings" :key="`${w.country}-${w.level}`" :class="['tw', tone(w)]" :role="tone(w) === 'over' ? 'alert' : 'note'">
      <header>
        <strong>{{ w.title }}</strong>
      </header>
      <div v-if="w.limit" class="bar" aria-hidden="true"><span :style="{ width: `${Math.min(100, w.share * 100)}%` }"></span></div>
      <p>{{ w.text }}</p>
      <p class="src">
        <a :href="w.source" target="_blank" rel="noopener noreferrer">{{ w.country === 'EU' ? 'EU SME scheme rules' : 'Official rules for this country' }}</a>
        <template v-if="w.unverified"> · threshold from published 2026 figures, check it</template>
        <template v-if="settingsLink && w.country !== 'EU' && w.level !== 'no-scheme'"> · <router-link :to="{ name: 'settings', query: { panel: 'core.vat' } }">change the threshold</router-link></template>
      </p>
    </article>
  </section>
</template>

<style scoped>
.thresholds { display: flex; flex-direction: column; gap: .5rem; }
.tw { display: flex; flex-direction: column; gap: .35rem; padding: .7rem .85rem; border-radius: 12px; border: 1px solid var(--zfy-warning); background: var(--zfy-surface); }
.tw.over { border-color: var(--zfy-danger); }
.tw header strong { font-size: .92rem; }
.tw.over header strong { color: var(--zfy-danger); }
.tw.near header strong { color: var(--zfy-warning-ink); }
.tw p { margin: 0; font-size: .85rem; color: var(--zfy-ink); }
.tw .src { font-size: .78rem; color: var(--zfy-muted); }
.tw .src a { color: var(--zfy-accent-ink); }
.bar { height: 6px; border-radius: 999px; background: var(--zfy-line); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--zfy-warning); }
.over .bar span { background: var(--zfy-danger); }
</style>
