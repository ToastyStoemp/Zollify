<script setup lang="ts">
import QrCode from './QrCode.vue';
import BrandLogo from './BrandLogo.vue';

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
  /** How large the logo shows - the booth's choice under POS → Receipts. */
  logoSize?: 'small' | 'medium' | 'large';
}>();
</script>

<template>
  <div class="zfy-after-sale">
    <BrandLogo v-if="logo" :src="logo" :size="logoSize" />
    <p v-if="thankYou" class="thanks">Thank you!</p>
    <p class="paid">{{ total }}</p>
    <template v-if="receiptUrl">
      <div class="qr" :style="{ '--qr-max': `${qrSize ?? 220}px` }">
        <QrCode :value="receiptUrl" :size="qrSize ?? 220" label="QR code for your receipt" />
      </div>
      <p class="scan">Scan for your receipt</p>
    </template>
  </div>
</template>

<style scoped>
/*
 * Never taller than the space it is given: the QR is the part that gives way,
 * shrinking with the screen down to a size a phone still reads; the text and
 * gaps scale with the screen height. Whoever places the panel bounds it.
 */
.zfy-after-sale { display: flex; flex-direction: column; align-items: center; gap: clamp(.35rem, 1.5vh, .75rem); text-align: center; flex: 1 1 auto; min-height: 0; max-height: 100%; width: 100%; }
.zfy-after-sale > * { flex: none; }
.thanks { margin: 0; font-size: clamp(1.4rem, 5.5vh, 2.5rem); font-weight: 800; color: var(--zfy-accent, #0e7c66); }
.paid { margin: 0; font-size: clamp(1.6rem, 6.5vh, 3rem); font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1; }
.scan { margin: 0; font-size: clamp(.85rem, 2.2vh, 1.05rem); color: var(--zfy-muted, #5a6472); }
.zfy-after-sale > .qr { flex: 0 1 var(--qr-max); min-height: 6.5rem; max-height: var(--qr-max); width: 100%; display: flex; justify-content: center; }
.qr :deep(.zfy-qr) { height: 100%; width: auto; max-width: 100%; aspect-ratio: 1 / 1; }
.zfy-after-sale > :deep(.zfy-logo) { flex: 0 1 auto; min-height: 2rem; max-height: min(var(--zfy-logo-h, 6rem), 14vh); }
</style>
