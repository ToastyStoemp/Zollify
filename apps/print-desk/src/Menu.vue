<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

/**
 * A button that opens a short list of actions under it. Picking an action (role="menuitem")
 * closes it; so do Escape and a click elsewhere. A checkbox item (role="menuitemcheckbox")
 * leaves it open, so its tick can be seen.
 */
defineProps<{ label: string; title?: string; disabled?: boolean; align?: 'left' | 'right' }>();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

const outside = (e: MouseEvent): void => {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
};
const escape = (e: KeyboardEvent): void => {
  if (e.key === 'Escape') open.value = false;
};
const stopListening = (): void => {
  document.removeEventListener('mousedown', outside);
  document.removeEventListener('keydown', escape);
};
watch(open, (o) => {
  if (o) {
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
  } else stopListening();
});
onBeforeUnmount(stopListening);

function picked(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('[role="menuitem"]')) open.value = false;
}
</script>

<template>
  <div ref="root" class="menu">
    <button type="button" aria-haspopup="menu" :aria-expanded="open" :title="title" :disabled="disabled" @click="open = !open">
      {{ label }}
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div v-if="open" class="menu-list" :class="align === 'right' ? 'right' : 'left'" role="menu" :aria-label="label" @click="picked">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.menu { position: relative; }
.menu > button { display: inline-flex; align-items: center; gap: .35rem; }
.menu-list {
  position: absolute;
  top: calc(100% + 4px);
  z-index: 10;
  min-width: 17rem;
  display: flex;
  flex-direction: column;
  padding: .3rem;
  border: 1px solid var(--zfy-line);
  border-radius: 10px;
  background: var(--zfy-surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
}
.menu-list.left { left: 0; }
.menu-list.right { right: 0; }
.menu-list :slotted([role='menuitem']),
.menu-list :slotted([role='menuitemcheckbox']) {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: .1rem;
  width: 100%;
  padding: .45rem .6rem;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.menu-list :slotted([role='menuitemcheckbox']) { flex-direction: row; align-items: center; gap: .5rem; }
.menu-list :slotted([role='menuitem']:hover:not(:disabled)),
.menu-list :slotted([role='menuitemcheckbox']:hover) { background: color-mix(in srgb, var(--zfy-ink) 7%, var(--zfy-surface)); }
.menu-list :slotted([role='menuitem']:disabled) { opacity: .5; cursor: default; }
.menu-list :slotted(small) { color: var(--zfy-muted); font-size: .78rem; }
.menu-list :slotted(hr) { width: 100%; margin: .25rem 0; border: 0; border-top: 1px solid var(--zfy-line); }
</style>
