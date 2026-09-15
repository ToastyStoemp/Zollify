<script setup lang="ts">
import { ref, watch } from 'vue';
import { imageUrl } from '@zollify/platform';

const props = defineProps<{ imageId?: string; alt: string; size?: number }>();

const url = ref<string | null>(null);

// Object URLs come from a platform-level cache keyed by image id, so they are
// shared by every tile that shows the same thumbnail and live for the session.
// Revoking one here (as an earlier version did) broke every other user of it -
// the second visit to a page showed blank thumbnails.
watch(
  () => props.imageId,
  async (id) => {
    url.value = null;
    if (!id) return;
    // A missing image is not an error worth surfacing - the placeholder says
    // enough, and a broken thumbnail must never block selling.
    url.value = await imageUrl(id, 'thumb').catch(() => null);
  },
  { immediate: true },
);
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
