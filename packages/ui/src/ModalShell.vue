<script setup lang="ts">
import { DialogHeading, DialogLayer, DialogPanel } from './dialog';
import { Icon } from './icon';

/**
 * A sheet on a phone, a centred card on a desk. Ported from ZollTool.
 *
 * Focus is kept inside while it is open, Escape closes it wherever focus is,
 * the page behind does not scroll, and focus returns to the opener on close.
 * A backdrop press closes only when press and release both land on the
 * backdrop. All of that is dialog.ts; this file is the looks.
 */
const props = defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

/** Whether the element took focus; a hidden one (a file input behind an "Add photo" button) does not. */
function takesFocus(el: HTMLElement): boolean {
  el.focus();
  return document.activeElement === el;
}
/** The first field, so typing can start at once; the close button is never the first stop. */
const firstField = (card: HTMLElement) => [...card.querySelectorAll<HTMLElement>('input, button:not(.close), select, textarea')].find(takesFocus);
</script>

<template>
  <DialogLayer @close="emit('close')">
    <div class="backdrop">
      <DialogPanel :initial-focus="firstField">
        <div :class="['card', { wide: props.wide }]" aria-modal="true" :aria-label="props.title" tabindex="-1">
          <header>
            <DialogHeading><h2>{{ props.title }}</h2></DialogHeading>
            <button type="button" class="quiet close" aria-label="Close" @click="emit('close')"><Icon name="x" :size="18" /></button>
          </header>
          <div class="body"><slot /></div>
          <footer v-if="$slots.footer"><slot name="footer" /></footer>
        </div>
      </DialogPanel>
    </div>
  </DialogLayer>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: var(--zfy-z-modal, 30); display: flex; align-items: flex-end; justify-content: center; background: var(--zfy-scrim, rgba(20,26,34,.45)); padding: 0; }
.card { display: flex; flex-direction: column; width: 100%; max-width: 34rem; max-height: 92vh; background: var(--zfy-surface, #fff); border-radius: 16px 16px 0 0; box-shadow: 0 24px 48px -24px var(--zfy-shadow, rgba(20,26,34,.4)); outline: none; }
.card.wide { max-width: 44rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .9rem 1.1rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
h2 { margin: 0; font-size: 1.05rem; }
.close { min-height: 2rem; padding: .2rem .4rem; }
.body { min-height: 0; flex: 1; overflow-y: auto; padding: 1rem 1.1rem; }
footer { padding: .8rem 1.1rem; border-top: 1px solid var(--zfy-line, #d6dde4); }
/* 720 = the shell's phone breakpoint (apps/web/src/styles.css); a bottom sheet below, a centred dialog above. */
@media (min-width: 721px) {
  .backdrop { align-items: center; padding: 1rem; }
  .card { border-radius: 16px; }
}
</style>
