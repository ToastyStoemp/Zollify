<script setup lang="ts">
import QrCode from './QrCode.vue';

/**
 * What a screen shows once a sale is paid - shared by the register and the
 * customer display so both read the same. Either half can be switched off on
 * its own; the caller decides from the device's own settings.
 */
defineProps<{
  thankYou: boolean;
  /** Formatted amount paid, e.g. "CHF 45.00". */
  total: string;
  /** Online receipt link; no QR when absent. */
  receiptUrl?: string;
  qrSize?: number;
  /** The booth's logo as an image URL (usually a data: URL); none when absent. */
  logo?: string;
}>();
</script>

<template>
  <div class="zfy-after-sale">
    <img v-if="logo" class="logo" :src="logo" alt="" />
    <p v-if="thankYou" class="thanks">Thank you!</p>
    <p class="paid">{{ total }}</p>
    <template v-if="receiptUrl">
      <QrCode :value="receiptUrl" :size="qrSize ?? 220" label="QR code for your receipt" />
      <p class="scan">Scan for your receipt</p>
    </template>
  </div>
</template>

<style scoped>
.zfy-after-sale { display: flex; flex-direction: column; align-items: center; gap: .75rem; text-align: center; }
.logo { display: block; max-width: min(16rem, 70vw); max-height: 6rem; object-fit: contain; }
.thanks { margin: 0; font-size: 2.5rem; font-weight: 800; color: var(--zfy-accent, #0e7c66); }
.paid { margin: 0; font-size: 3rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.scan { margin: 0; font-size: 1.05rem; color: var(--zfy-muted, #5a6472); }
</style>
