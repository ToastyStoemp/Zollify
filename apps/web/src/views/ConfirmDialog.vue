<script setup lang="ts">
import { ref } from 'vue';
import { pendingConfirm } from '@zollify/platform';
import { DialogHeading, DialogLayer, DialogPanel, DialogSummary } from '@zollify/ui';

const confirmButton = ref<HTMLButtonElement | null>(null);

// Focus lands on the confirming action so Enter completes the flow and Escape
// backs out - the two keys anyone reaches for on a dialog. The rest is the
// same dialog behaviour as ModalShell: focus stays inside and returns to
// whatever asked.
const confirmFirst = () => confirmButton.value;
</script>

<template>
  <DialogLayer v-if="pendingConfirm.current" @close="pendingConfirm.current?.resolve(false)">
    <div class="backdrop">
      <DialogPanel described :initial-focus="confirmFirst">
        <div class="dialog" aria-modal="true" tabindex="-1">
          <DialogHeading><h2>{{ pendingConfirm.current.title }}</h2></DialogHeading>
          <DialogSummary><p>{{ pendingConfirm.current.message }}</p></DialogSummary>
          <div class="actions">
            <button type="button" @click="pendingConfirm.current.resolve(false)">{{ pendingConfirm.current.cancelLabel }}</button>
            <button ref="confirmButton" type="button" class="primary" @click="pendingConfirm.current.resolve(true)">
              {{ pendingConfirm.current.confirmLabel }}
            </button>
          </div>
        </div>
      </DialogPanel>
    </div>
  </DialogLayer>
</template>

<style scoped>
/* Above ModalShell's own backdrop (30) - shellConfirm() is how a product's
   "Remove"/a merge's confirmation is asked from inside an already-open
   ModalShell, and this is one global instance shared by every caller, so it
   has to outrank any modal that might be open under it, not just sit at some
   fixed layer of its own. Also above TypeaheadPicker's dropdown (40). */
.backdrop { position: fixed; inset: 0; z-index: var(--zfy-z-confirm, 50); background: var(--zfy-scrim); display: grid; place-items: center; padding: 1rem; }
/* Focused by script only when it holds nothing else - no ring for that. */
.dialog { outline: none; background: var(--zfy-surface); border-radius: 12px; padding: 1.25rem; max-width: 26rem; width: 100%; display: flex; flex-direction: column; gap: .75rem; box-shadow: 0 24px 48px -24px var(--zfy-shadow); }
h2 { margin: 0; font-size: 1.05rem; }
p { margin: 0; color: var(--zfy-muted); }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
</style>
