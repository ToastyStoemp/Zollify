<script setup lang="ts">
import { computed } from 'vue';
import { useAsyncAction } from './async-action';

/**
 * The app's button: a real <button> wearing the shell's global button looks
 * (`.primary`, `.danger`, `.quiet`), so it is indistinguishable from the
 * hand-written ones it replaces.
 *
 * What it adds is the part every view used to get wrong by hand. Give it the
 * work as `:action` and a second tap while the first is still saving is
 * ignored, and the button shows it is busy:
 *
 *   <ZButton variant="primary" :action="save">Save</ZButton>
 *
 * A view that tracks its own state passes `:busy` instead and listens to
 * `@click` as on any button.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'danger' | 'quiet';
    type?: 'button' | 'submit' | 'reset';
    busy?: boolean;
    disabled?: boolean;
    /** Run on click. Taps are ignored until it settles. */
    action?: () => unknown;
  }>(),
  { variant: 'default', type: 'button' },
);
const emit = defineEmits<{
  /** The action finished. */
  done: [value: unknown];
  /** The action threw; the message is ready to show. */
  error: [message: string, err: unknown];
}>();

// A failure is never dropped: it goes to the listener, and to the console for
// the view that forgot to listen.
const pressed = useAsyncAction(async () => props.action?.(), {
  onError: (message, err) => {
    console.error('[zollify] button action failed', err);
    emit('error', message, err);
  },
});
const isBusy = computed(() => props.busy || pressed.busy.value);

async function onClick(): Promise<void> {
  if (!props.action) return;
  const result = await pressed.run();
  if (result.ok) emit('done', result.value);
}
</script>

<template>
  <button
    :type="props.type"
    :class="['zfy-button', props.variant === 'default' ? null : props.variant, { busy: isBusy }]"
    :disabled="props.disabled || isBusy"
    :aria-busy="isBusy ? 'true' : undefined"
    @click="onClick"
  >
    <slot />
    <i v-if="isBusy" class="progress" aria-hidden="true"></i>
  </button>
</template>

<style scoped>
/* The bar lies over the bottom edge, so a busy button is exactly the size it was. */
.zfy-button { position: relative; }
.zfy-button.busy { overflow: hidden; cursor: progress; }
.progress { position: absolute; left: 0; bottom: 0; width: 35%; height: 3px; border-radius: 999px; background: currentColor; animation: zfy-button-slide 1.1s ease-in-out infinite; }
@keyframes zfy-button-slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) { .progress { animation: none; width: 100%; opacity: .5; } }
/* A finger needs 44px; with a mouse the button keeps the shell's own 2.5rem. */
@media (pointer: coarse) { .zfy-button { min-height: 44px; } }
</style>
