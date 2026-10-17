<script setup lang="ts">
import { ref, watch } from 'vue';
import { logoIsDarkInk } from './logo-tone';

/**
 * The booth's logo on a screen. A dark logo on a transparent background is
 * drawn white on a dark theme instead of vanishing into it (see logo-tone.ts);
 * `size` is the booth's choice under POS → Receipts.
 */
const props = defineProps<{ src: string; size?: 'small' | 'medium' | 'large' }>();
const ink = ref(false);
watch(
  () => props.src,
  async (src) => {
    ink.value = false;
    ink.value = await logoIsDarkInk(src);
  },
  { immediate: true },
);
</script>

<template>
  <img class="zfy-logo" :class="[size ?? 'medium', { ink }]" :src="src" alt="" />
</template>

<style scoped>
.zfy-logo { display: block; max-width: min(16rem, 70vw); object-fit: contain; }
.zfy-logo.small { --zfy-logo-h: 3rem; max-height: 3rem; max-width: min(9rem, 50vw); }
.zfy-logo.medium { --zfy-logo-h: 6rem; max-height: 6rem; }
.zfy-logo.large { --zfy-logo-h: 10rem; max-height: 10rem; max-width: min(22rem, 80vw); }
</style>

<style>
/* Unscoped on purpose: the theme sits on <html>, outside this component. */
:root[data-theme='dark'] .zfy-logo.ink { filter: invert(1); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) .zfy-logo.ink { filter: invert(1); }
}
</style>
