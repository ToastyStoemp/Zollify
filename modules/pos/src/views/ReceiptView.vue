<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { fmtPrice, type Transaction } from '@zollify/shared';
import { receiptAmounts, receiptVat, vatRateLabel, printReceipt, printableReceipt, printingAvailable } from '../receipt';
import { sdk } from '../runtime';
import { QrCode, receiptUrl as receiptUrlFor, type PrintState } from '../lib/after-sale';
import { screenLogo } from '../lib/branding';
import AfterSaleOverlay from '../components/AfterSaleOverlay.vue';

const props = defineProps<{ saleId?: string }>();

const tx = ref<Transaction | null>(null);
const eventName = ref('');
const canPrintNatively = ref(false);
const message = ref<string | null>(null);
const failed = ref(false);
const router = useRouter();

/**
 * Opened from History (or the till's last-sale bar), a past sale shows the
 * same card as right after the sale: amount, QR to the online receipt and the
 * print buttons. Closing it goes back where it came from; "Full receipt"
 * stays here on the paper copy.
 */
const showCard = ref(true);
const logo = ref<string | undefined>();
const printState = ref<PrintState>('idle');

/**
 * Rendered from the recorded transaction rather than the cart.
 *
 * The cart is cleared the moment a sale completes, and a receipt reprinted
 * later must show what was actually sold - so the stored row is the only
 * honest source.
 */
onMounted(async () => {
  canPrintNatively.value = await printingAvailable().catch(() => false);
  logo.value = await screenLogo().catch(() => undefined);

  if (!props.saleId) return;
  const found = sdk().data.transactions.get(props.saleId) ?? null;
  tx.value = found;
  if (found?.eventId) {
    eventName.value = sdk().data.events.get(found.eventId)?.name ?? '';
  }
});

const lines = computed(() => tx.value?.items ?? []);
/** Lines at the till's price and each discount, in what the customer paid - matches the printed copy. */
const breakdown = computed(() => (tx.value ? receiptAmounts(tx.value) : { lines: [], discounts: [] }));
const subtotal = computed(() => breakdown.value.lines.reduce((s, a) => s + Math.round(a * 100), 0) / 100);
/** KassenSichV: the sale's TSE outcome, and its cancellation's when reverted. */
const tseBlocks = computed(() => {
  const out: { title: string; tse: NonNullable<Transaction['tse']>; till?: string }[] = [];
  const t = tx.value;
  if (t?.tse) out.push({ title: 'TSE', tse: t.tse, till: t.receipt?.till });
  if (t?.revertTse) {
    const no = t.revertReceipt ? ` - receipt no. ${t.revertReceipt.number}` : '';
    out.push({ title: `TSE - Storno${no}`, tse: t.revertTse, till: t.revertReceipt?.till });
  }
  return out;
});
/** VAT per rate, lettered when a sale has more than one - as on the printed copy. */
const vatRows = computed(() => (tx.value ? receiptVat(tx.value) : []));
const letterFor = (i: number): string => {
  if (vatRows.value.length < 2) return '';
  const rate = tx.value?.tax?.rates[i];
  return vatRows.value.find((r) => r.rate === rate)?.letter ?? '';
};
/** The customer's online receipt, for one who asks after the fact. A cancelled sale gets none. */
const receiptUrl = computed(() => (QrCode && !tx.value?.revertedAt && receiptUrlFor(tx.value?.receiptToken)) || '');
const caption = computed(() => {
  if (!tx.value) return '';
  const when = new Date(tx.value.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return [eventName.value, when].filter(Boolean).join(' · ');
});

function closeCard(): void {
  // Came from somewhere in the app (History, the till): go back there.
  if ((window.history.state as { back?: string | null } | null)?.back) router.back();
  else showCard.value = false;
}

const paidWith = computed(() =>
  (tx.value?.payments ?? [])
    .map((leg) => [leg.provider ?? leg.kind, leg.cardBrand].filter(Boolean).join(' · '))
    .join(', '),
);

/**
 * Prints through the thermal printer when there is one, and falls back to the
 * browser otherwise - a booth on a laptop still needs to hand over a receipt.
 */
async function print(): Promise<void> {
  message.value = null;
  failed.value = false;

  if (!tx.value) return;

  if (!canPrintNatively.value) {
    window.print();
    return;
  }
  if (printState.value === 'printing') return;

  printState.value = 'printing';
  try {
    const receiptLines = await printableReceipt(tx.value, eventName.value, sdk().data.events.get(tx.value.eventId)?.venue?.country);
    const result = await printReceipt(receiptLines);
    failed.value = !result.printed;
    printState.value = result.printed ? 'printed' : 'failed';
    message.value = result.printed ? 'Printed.' : (result.error ?? 'The printer did not respond.');
  } catch (err) {
    failed.value = true;
    printState.value = 'failed';
    message.value = err instanceof Error ? err.message : 'Could not print that receipt.';
  }
}
</script>

<template>
  <section class="receipt">
    <header class="bar">
      <h1>Receipt</h1>
      <div class="bar-actions">
        <button v-if="tx && !showCard" type="button" @click="showCard = true">Show QR</button>
        <button type="button" :disabled="!tx || printState === 'printing'" @click="print">
          {{ canPrintNatively ? 'Print' : 'Print (browser)' }}
        </button>
      </div>
    </header>

    <p v-if="!tx" class="empty">
      That sale isn't on this device. Receipts can only be reprinted where the sale was recorded, or
      after a sync has brought it across.
    </p>
    <p v-if="message" :class="['result', { bad: failed }]" role="status">{{ message }}</p>

    <article v-if="tx" class="paper">
      <p class="event">{{ eventName || 'No event' }}</p>
      <p class="when">{{ new Date(tx.timestamp).toLocaleString() }}</p>
      <p v-if="tx.receipt" class="when">Receipt no. {{ tx.receipt.number }} · Till {{ tx.receipt.till }}</p>

      <ul class="items">
        <li v-for="(item, i) in lines" :key="i">
          <span class="qty">{{ item.qty }}×</span>
          <span class="title">
            {{ item.title }}
            <template v-if="item.variantLabel"> · {{ item.variantLabel }}</template>
          </span>
          <span class="amount">{{ fmtPrice(breakdown.lines[i] ?? item.lineTotal, tx.currency) }}<template v-if="letterFor(i)"> {{ letterFor(i) }}</template></span>
        </li>
      </ul>

      <p v-if="breakdown.discounts.length" class="row subtotal"><span>Subtotal</span><span>{{ fmtPrice(subtotal, tx.currency) }}</span></p>
      <p v-for="(discount, i) in breakdown.discounts" :key="i" class="row discount">
        <span>{{ discount.name }}</span>
        <span>−{{ fmtPrice(discount.amount, tx.currency) }}</span>
      </p>

      <p class="row total">
        <span>Total</span>
        <strong>{{ fmtPrice(tx.total, tx.currency) }}</strong>
      </p>

      <template v-for="r in vatRows" :key="r.rate">
        <p class="row vat"><span>{{ vatRows.length > 1 ? `${r.letter} ` : '' }}incl. VAT {{ vatRateLabel(r.rate) }}</span><span>{{ fmtPrice(r.vat, tx.currency) }}</span></p>
        <p class="row vat net"><span>net</span><span>{{ fmtPrice(r.net, tx.currency) }}</span></p>
      </template>
      <p v-if="tx.tax?.exempt && tx.tax.note" class="exempt">{{ tx.tax.note }}</p>
      <p v-if="tx.tax?.exempt && tx.tax.exNumber" class="exempt">EX: {{ tx.tax.exNumber }}</p>

      <p class="row paid"><span>Paid</span><span>{{ paidWith }}</span></p>
      <template v-for="block in tseBlocks" :key="block.title">
        <div class="tse">
          <p class="tse-title">{{ block.title }}</p>
          <template v-if="'failed' in block.tse">
            <p>TSE ausgefallen - Beleg ohne TSE-Signatur</p>
            <p class="tse-reason">{{ block.tse.failed.reason }}</p>
          </template>
          <template v-else>
            <p v-if="block.tse.signed.test" class="tse-test">Test-TSE - nicht zertifiziert</p>
            <p class="row"><span>Transaktion</span><span>{{ block.tse.signed.transactionNumber }}</span></p>
            <p class="row"><span>Signaturzähler</span><span>{{ block.tse.signed.signatureCounter }}</span></p>
            <p class="row"><span>Start</span><span>{{ new Date(block.tse.signed.start).toLocaleString() }}</span></p>
            <p class="row"><span>Ende</span><span>{{ new Date(block.tse.signed.finish).toLocaleString() }}</span></p>
            <p v-if="block.tse.signed.clientId !== block.till" class="row"><span>Kasse</span><span>{{ block.tse.signed.clientId }}</span></p>
            <p class="tse-serial">TSE {{ block.tse.signed.serial }}</p>
          </template>
        </div>
      </template>
      <p v-if="tx.revertedAt" class="reverted">
        Reverted {{ new Date(tx.revertedAt).toLocaleString() }}<template v-if="tx.revertReceipt">
          - cancellation receipt no. {{ tx.revertReceipt.number }}<template v-if="tx.revertReceipt.till !== tx.receipt?.till"> (till {{ tx.revertReceipt.till }})</template></template>
      </p>
      <p class="ref">{{ tx.id }}</p>
    </article>

    <div v-if="receiptUrl" class="online">
      <component :is="QrCode" :value="receiptUrl" :size="160" label="QR code for the online receipt" />
      <p>Online receipt - the customer scans this to keep a copy. It opens once this sale has synced.</p>
    </div>

    <AfterSaleOverlay
      v-if="tx && showCard"
      :caption="caption"
      :total="fmtPrice(tx.total, tx.currency)"
      :receipt-url="receiptUrl || undefined"
      :logo="logo"
      :warning="tx.revertedAt ? 'This sale was cancelled' : undefined"
      :can-print="true"
      :print="printState"
      :print-label="canPrintNatively ? 'Print receipt' : 'Print (browser)'"
      secondary-label="Full receipt"
      @print="print"
      @close="closeCard"
      @secondary="showCard = false"
    />
  </section>
</template>

<style scoped>
.receipt { display: flex; flex-direction: column; gap: 1rem; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.bar-actions { display: flex; gap: .5rem; }
h1 { font-size: 1.25rem; margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; }
.result { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); }
.result.bad { color: var(--zfy-danger, #c6512f); }

/* Sized to 58mm thermal paper so the on-screen copy matches what prints. */
.paper {
  width: 100%; max-width: 22rem; background: #fff; color: #141a22;
  border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px;
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
.row.vat { color: #5a6472; font-size: .75rem; }
.row.vat.net { padding-left: 1.2rem; }
.tse { border-top: 1px dashed #999; padding-top: .35rem; display: flex; flex-direction: column; gap: .15rem; font-size: .72rem; color: #5a6472; }
.tse p { margin: 0; }
.tse-title { font-weight: 700; color: #141a22; }
.tse-test, .tse-reason { color: #c6512f; }
.tse-serial { word-break: break-all; }
.exempt { margin: 0; text-align: center; font-size: .75rem; color: #5a6472; }
.row.subtotal { border-top: 1px dashed #999; padding-top: .35rem; }
.reverted { margin: 0; color: #c6512f; }

.online { display: flex; align-items: center; gap: 1rem; max-width: 22rem; }
.online p { margin: 0; font-size: .8rem; color: var(--zfy-muted, #5a6472); }

@media print {
  .bar, .empty, .result { display: none; }
  .online p { display: none; }
  .paper { border: 0; max-width: none; }
}
</style>
