<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { Icon } from './icon';

/**
 * A sheet on a phone, a centred card on a desk. Ported from ZollTool.
 *
 * A backdrop click closes only when press and release both land on the
 * backdrop, so a text-selection drag that ends outside a field does not
 * dismiss the modal. Closing on `click` rather than `pointerup` keeps the
 * overlay mounted for the follow-up click, so on touch the tap is absorbed
 * instead of landing on whatever is behind.
 */
const props = defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const card = ref<HTMLElement | null>(null);
let pressedOnBackdrop = false;

function onBackdropDown(e: PointerEvent): void {
  pressedOnBackdrop = e.target === e.currentTarget;
}
function onBackdropClick(e: MouseEvent): void {
  if (pressedOnBackdrop && e.target === e.currentTarget) emit('close');
  pressedOnBackdrop = false;
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(async () => {
  await nextTick();
  (card.value?.querySelector<HTMLElement>('input, button:not(.close), select, textarea') ?? card.value)?.focus();
});
</script>

<template>
  <div class="backdrop" @pointerdown="onBackdropDown" @click="onBackdropClick" @keydown="onKey">
    <div ref="card" :class="['card', { wide: props.wide }]" role="dialog" aria-modal="true" :aria-label="props.title" tabindex="-1">
      <header>
        <h2>{{ props.title }}</h2>
        <button type="button" class="quiet close" aria-label="Close" @click="emit('close')"><Icon name="x" :size="18" /></button>
      </header>
      <div class="body"><slot /></div>
      <footer v-if="$slots.footer"><slot name="footer" /></footer>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 30; display: flex; align-items: flex-end; justify-content: center; background: var(--zfy-scrim, rgba(20,26,34,.45)); padding: 0; }
.card { display: flex; flex-direction: column; width: 100%; max-width: 34rem; max-height: 92vh; background: var(--zfy-surface, #fff); border-radius: 16px 16px 0 0; box-shadow: 0 24px 48px -24px var(--zfy-shadow, rgba(20,26,34,.4)); outline: none; }
.card.wide { max-width: 44rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .9rem 1.1rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
h2 { margin: 0; font-size: 1.05rem; }
.close { min-height: 2rem; padding: .2rem .4rem; }
.body { min-height: 0; flex: 1; overflow-y: auto; padding: 1rem 1.1rem; }
footer { padding: .8rem 1.1rem; border-top: 1px solid var(--zfy-line, #d6dde4); }
@media (min-width: 640px) {
  .backdrop { align-items: center; padding: 1rem; }
  .card { border-radius: 16px; }
}
</style>
