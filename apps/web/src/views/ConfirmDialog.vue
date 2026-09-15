<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { pendingConfirm } from '@zollify/platform';

const confirmButton = ref<HTMLButtonElement | null>(null);

// Focus lands on the confirming action so Enter completes the flow and Escape
// backs out - the two keys anyone reaches for on a dialog.
watch(
  () => pendingConfirm.current,
  async (req) => {
    if (!req) return;
    await nextTick();
    confirmButton.value?.focus();
  },
);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') pendingConfirm.current?.resolve(false);
}
</script>

<template>
  <div
    v-if="pendingConfirm.current"
    class="backdrop"
    @click.self="pendingConfirm.current.resolve(false)"
    @keydown="onKey"
  >
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{{ pendingConfirm.current.title }}</h2>
      <p>{{ pendingConfirm.current.message }}</p>
      <div class="actions">
        <button type="button" @click="pendingConfirm.current.resolve(false)">Cancel</button>
        <button ref="confirmButton" type="button" class="primary" @click="pendingConfirm.current.resolve(true)">
          Confirm
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; z-index: 20; background: var(--zfy-scrim); display: grid; place-items: center; padding: 1rem; }
.dialog { background: var(--zfy-surface); border-radius: 12px; padding: 1.25rem; max-width: 26rem; width: 100%; display: flex; flex-direction: column; gap: .75rem; box-shadow: 0 24px 48px -24px var(--zfy-shadow); }
h2 { margin: 0; font-size: 1.05rem; }
p { margin: 0; color: var(--zfy-muted); }
.actions { display: flex; gap: .5rem; justify-content: flex-end; }
</style>
