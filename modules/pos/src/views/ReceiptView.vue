<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fmtPrice, type Transaction } from '@boothly/shared';
import { buildReceiptLines, loadReceiptConfig, printReceipt, printingAvailable } from '../receipt';
import { sdk } from '../runtime';

const props = defineProps<{ saleId?: string }>();

const tx = ref<Transaction | null>(null);
const eventName = ref('');
const canPrintNatively = ref(false);
const message = ref<string | null>(null);
const failed = ref(false);

/**
 * Rendered from the recorded transaction rather than the cart.
 *
 * The cart is cleared the moment a sale completes, and a receipt reprinted
 * later must show what was actually sold — so the stored row is the only
 * honest source.
 */
onMounted(async () => {
  canPrintNatively.value = await printingAvailable().catch(() => false);

  if (!props.saleId) return;
  const found = sdk().data.transactions.get(props.saleId) ?? null;
  tx.value = found;
  if (found?.eventId) {
    eventName.value = sdk().data.events.get(found.eventId)?.name ?? '';
  }
});

const lines = computed(() => tx.value?.items ?? []);

const paidWith = computed(() =>
  (tx.value?.payments ?? [])
    .map((leg) => [leg.provider ?? leg.kind, leg.cardBrand].filter(Boolean).join(' · '))
    .join(', '),
);

/**
 * Prints through the thermal printer when there is one, and falls back to the
 * browser otherwise — a booth on a laptop still needs to hand over a receipt.
 */
async function print(): Promise<void> {
  message.value = null;
  failed.value = false;

  if (!tx.value) return;

  if (!canPrintNatively.value) {
    window.print();
    return;
  }

  try {
    const config = await loadReceiptConfig();
    const receiptLines = buildReceiptLines(tx.value, eventName.value, config);
    const result = await printReceipt(receiptLines);
    failed.value = !result.printed;
    message.value = result.printed ? 'Printed.' : (result.error ?? 'The printer did not respond.');
  } catch (err) {
    failed.value = true;
    message.value = err instanceof Error ? err.message : 'Could not print that receipt.';
  }
}
</script>

<template>
  <section class="receipt">
    <header class="bar">
      <h1>Receipt</h1>
      <button type="button" :disabled="!tx" @click="print">
        {{ canPrintNatively ? 'Print' : 'Print (browser)' }}
      </button>
    </header>

    <p v-if="!tx" class="empty">
      That sale isn't on this device. Receipts can only be reprinted where the sale was recorded, or
      after a sync has brought it across.
    </p>
    <p v-if="message" :class="['result', { bad: failed }]" role="status">{{ message }}</p>

    <article v-if="tx" class="paper">
      <p class="event">{{ eventName || 'No event' }}</p>
      <p class="when">{{ new Date(tx.timestamp).toLocaleString() }}</p>

      <ul class="items">
        <li v-for="(item, i) in lines" :key="i">
          <span class="qty">{{ item.qty }}×</span>
          <span class="title">
            {{ item.title }}
            <template v-if="item.variantLabel"> · {{ item.variantLabel }}</template>
          </span>
          <span class="amount">{{ fmtPrice(item.lineTotal, tx.currency) }}</span>
        </li>
      </ul>

      <p v-for="(discount, i) in tx.discounts" :key="i" class="row discount">
        <span>{{ discount.name }}</span>
        <span>−{{ fmtPrice(discount.amount, tx.currency) }}</span>
      </p>

      <p class="row total">
        <span>Total</span>
        <strong>{{ fmtPrice(tx.total, tx.currency) }}</strong>
      </p>

      <p class="row paid"><span>Paid</span><span>{{ paidWith }}</span></p>
      <p v-if="tx.revertedAt" class="reverted">Reverted {{ new Date(tx.revertedAt).toLocaleString() }}</p>
      <p class="ref">{{ tx.id }}</p>
    </article>
  </section>
</template>

<style scoped>
.receipt { display: flex; flex-direction: column; gap: 1rem; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h1 { font-size: 1.25rem; margin: 0; }
.empty { color: var(--bly-muted, #5a6472); margin: 0; }
.result { margin: 0; color: var(--bly-accent-ink, #0a5a4a); }
.result.bad { color: var(--bly-danger, #c6512f); }

/* Sized to 58mm thermal paper so the on-screen copy matches what prints. */
.paper {
  width: 100%; max-width: 22rem; background: #fff; color: #141a22;
  border: 1px solid var(--bly-line, #d6dde4); border-radius: 8px;
  padding: 1rem; font-family: ui-monospace, "SFMono-Regular", monospace; font-size: .8rem;
  display: flex; flex-direction: column; gap: .35rem;
}
.event { margin: 0; font-weight: 700; }
.when, .ref { margin: 0; color: #5a6472; font-size: .72rem; }
.ref { word-break: break-all; }
.items { list-style: none; margin: .4rem 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; }
.items li { display: grid; grid-template-columns: 2.2rem 1fr auto; gap: .4rem; }
.amount { text-align: right; font-variant-numeric: tabular-nums; }
.row { display: flex; justify-content: space-between; margin: 0; }
.row.total { border-top: 1px dashed #999; padding-top: .35rem; font-size: .95rem; }
.row.discount { color: #0a5a4a; }
.reverted { margin: 0; color: #c6512f; }

@media print {
  .bar, .empty, .result { display: none; }
  .paper { border: 0; max-width: none; }
}
</style>
