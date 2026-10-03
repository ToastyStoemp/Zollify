<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * A QR code for `value`, always dark-on-white with a quiet zone: phone
 * cameras read inverted (dark-theme) codes poorly, so the code ignores the
 * theme on purpose. The encoder loads on first use.
 */
const props = withDefaults(defineProps<{ value: string; size?: number; label?: string }>(), { size: 220, label: 'QR code' });

const src = ref('');
watch(
  () => [props.value, props.size] as const,
  async ([value, size]) => {
    src.value = '';
    if (!value) return;
    const { toDataURL } = await import('qrcode');
    const url = await toDataURL(value, { width: size * 2, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    // A newer value may have arrived while this one encoded.
    if (value === props.value) src.value = url;
  },
  { immediate: true },
);
</script>

<template>
  <img v-if="src" class="zfy-qr" :src="src" :width="size" :height="size" :alt="label" />
  <span v-else class="zfy-qr zfy-qr-pending" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true"></span>
</template>

<style scoped>
.zfy-qr { display: block; border-radius: 12px; background: #fff; image-rendering: pixelated; }
.zfy-qr-pending { background: #fff; opacity: .5; }
</style>
