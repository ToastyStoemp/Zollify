<script setup lang="ts">
import { Icon } from '@zollify/ui';
import { AfterSalePanel, type PrintState } from '../lib/after-sale';

/**
 * The card a customer sees about their receipt: logo, amount, the QR to the
 * online copy and the print buttons. Shown right after a sale, and again for
 * any past sale opened from History - one component, so both look and behave
 * the same. Printing itself is the caller's: it knows which sale and event.
 */

withDefaults(
  defineProps<{
    thankYou?: boolean;
    /** Formatted amount, e.g. "CHF 45.00". */
    total: string;
    receiptUrl?: string;
    logo?: string;
    /** A line above the card identifying the sale, e.g. event and time. */
    caption?: string;
    /** Shown under the amount, e.g. that the sale was cancelled. */
    warning?: string;
    canPrint: boolean;
    print: PrintState;
    /** Label of the print button before the first print. */
    printLabel?: string;
    closeLabel?: string;
    /** An extra quiet button, e.g. to see the full receipt. */
    secondaryLabel?: string;
    ariaLabel?: string;
  }>(),
  { thankYou: false, printLabel: 'Print receipt', closeLabel: 'Close', ariaLabel: 'Receipt' },
);
defineEmits<{ print: []; close: []; secondary: [] }>();
</script>

<template>
  <div class="after-sale" role="dialog" aria-modal="true" :aria-label="ariaLabel" @click.self="$emit('close')">
    <div class="after-sale-card">
      <p v-if="caption" class="caption">{{ caption }}</p>
      <component :is="AfterSalePanel" v-if="AfterSalePanel" :thank-you="thankYou" :total="total" :receipt-url="receiptUrl" :logo="logo" :qr-size="240" />
      <p v-else class="fallback-total">{{ total }}</p>
      <p v-if="warning" class="warning" role="status">{{ warning }}</p>
      <p v-if="print === 'printed'" class="print-note" role="status"><Icon name="check" :size="14" /> Receipt printed</p>
      <div class="after-sale-actions">
        <button v-if="canPrint" type="button" :disabled="print === 'printing'" @click="$emit('print')">
          <Icon name="printer" :size="16" />
          {{ print === 'printing' ? 'Printing…' : print === 'printed' ? 'Print again' : print === 'failed' ? 'Retry print' : printLabel }}
        </button>
        <button type="button" class="primary" @click="$emit('close')">{{ closeLabel }}</button>
      </div>
      <button v-if="secondaryLabel" type="button" class="quiet secondary" @click="$emit('secondary')">{{ secondaryLabel }}</button>
    </div>
  </div>
</template>

<style scoped>
.after-sale { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 1rem; background: color-mix(in srgb, var(--zfy-ink, #1a2230) 45%, transparent); }
.after-sale-card { display: flex; flex-direction: column; align-items: center; gap: 1.25rem; padding: 2rem 2.5rem; border-radius: 18px; background: var(--zfy-surface, #fff); box-shadow: 0 20px 50px rgb(0 0 0 / .25); max-width: 100%; max-height: 100%; overflow-y: auto; }
.after-sale-card .primary { min-width: 10rem; }
.after-sale-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: .6rem; }
.after-sale-actions button { min-height: 2.75rem; display: inline-flex; align-items: center; justify-content: center; gap: .4rem; }
.caption { margin: 0 0 -.5rem; font-size: .85rem; color: var(--zfy-muted, #5a6472); text-align: center; }
.fallback-total { margin: 0; font-size: 2.5rem; font-weight: 800; font-variant-numeric: tabular-nums; }
.warning { margin: -.5rem 0 0; font-size: .9rem; font-weight: 600; color: var(--zfy-danger, #c6512f); }
.print-note { margin: -.5rem 0 0; display: inline-flex; align-items: center; gap: .3rem; font-size: .85rem; color: var(--zfy-accent-ink, #0a5a4a); }
.secondary { margin-top: -.5rem; font-size: .85rem; }
@media (max-width: 420px) { .after-sale-card { padding: 1.5rem 1.25rem; } }
@media print { .after-sale { display: none; } }
</style>
