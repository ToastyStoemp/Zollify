<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { imageUrl } from '@zollify/platform';

const props = defineProps<{ imageId?: string; alt: string; size?: number }>();

const url = ref<string | null>(null);

/**
 * Object URLs are revoked when the image changes and when the component goes
 * away. A POS tile grid re-renders constantly, and leaking one URL per render
 * would pin every thumbnail blob in memory for the whole session.
 */
function release(): void {
  if (url.value) {
    URL.revokeObjectURL(url.value);
    url.value = null;
  }
}

watch(
  () => props.imageId,
  async (id) => {
    release();
    if (!id) return;
    // A missing image is not an error worth surfacing — the placeholder says
    // enough, and a broken thumbnail must never block selling.
    url.value = await imageUrl(id, 'thumb').catch(() => null);
  },
  { immediate: true },
);

onUnmounted(release);
</script>

<template>
  <img
    v-if="url"
    :src="url"
    :alt="alt"
    :style="{ width: `${size ?? 40}px`, height: `${size ?? 40}px` }"
  />
  <span
    v-else
    class="placeholder"
    :style="{ width: `${size ?? 40}px`, height: `${size ?? 40}px` }"
    aria-hidden="true"
  />
</template>

<style scoped>
img,
.placeholder { border-radius: 6px; object-fit: cover; flex: none; }
.placeholder { background: var(--zfy-surface-2, #e9edf1); display: inline-block; }
</style>
