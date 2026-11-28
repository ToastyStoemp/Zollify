<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { ModalShell } from '@zollify/ui';
import { GIVEN_AWAY, cardInBase, cart } from '../cart';
import type { PaymentFlow } from '../composables/usePaymentFlow';
import { useTillMoney } from '../composables/useTillMoney';
import type { PaymentProvider } from '../payments/provider';

/**
 * The payment sheet: the amount, then whatever the flow's phase asks for -
 * cash received and change, the two parts of a split, the terminal working,
 * a failed card, a reader to sign in to. It shows the flow it is given and
 * calls it; every decision is usePaymentFlow's.
 */
defineProps<{
  flow: UnwrapNestedRefs<PaymentFlow>;
  /** The terminal cards go to, for its name and whether it can be signed in to from here. */
  provider: PaymentProvider;
  hasTerminal: boolean;
}>();

const { money, onCard, cardRateLabel } = useTillMoney();
</script>

<template>
  <!-- ── Payment ───────────────────────────────────────────────────────── -->
  <ModalShell :title="flow.title" @close="flow.cancelPayment">
    <div class="paybody">
      <p class="amount">{{ money(flow.payment.total) }}</p>
      <p v-if="cardInBase && flow.payment.method === 'card'" class="oncard">
        <template v-if="onCard(flow.payment.total)"><span>Card: <strong>{{ onCard(flow.payment.total) }}</strong></span><small>{{ cardRateLabel }}</small></template>
        <template v-else>No {{ cart.baseCurrency }}/{{ cart.currency }} rate on this device yet</template>
      </p>

      <template v-if="flow.payment.phase === 'needsLogin'">
        <p class="warn strong">{{ provider.label }} isn't signed in</p>
        <p class="hint">Log in to take this card payment on the reader, or record the card another way.</p>
      </template>

      <template v-else-if="flow.payment.phase === 'terminal'">
        <p class="pulse">Present card to terminal…</p>
        <p class="hint">{{ provider.label }}</p>
      </template>

      <template v-else-if="flow.payment.phase === 'failed'">
        <p class="bad strong">Card payment didn't go through</p>
        <p v-if="flow.payment.error" class="hint">{{ flow.payment.error }}</p>
        <p class="hint">Retry the card, or complete the sale by hand if it was paid another way.</p>
        <button type="button" class="quiet" :disabled="flow.sendingLog" @click="flow.sendLog">{{ flow.sendingLog ? 'Sending…' : flow.logSent ? 'Log sent' : 'Send log to support' }}</button>
      </template>

      <template v-else-if="flow.payment.method === 'cash'">
        <div class="chips">
          <button type="button" class="chip exact" @click="flow.payment.cashReceived = flow.payment.total.toFixed(2)">Exact</button>
          <button v-for="a in flow.cashShortcuts" :key="a" type="button" class="chip" @click="flow.payment.cashReceived = String(a)">{{ a }}</button>
        </div>
        <label class="field"><span>Received</span><input v-model="flow.payment.cashReceived" type="number" inputmode="decimal" class="big" /></label>
        <p>Change: <strong :class="flow.change < -0.001 ? 'bad' : 'good'">{{ flow.change < -0.001 ? '− ' + money(-flow.change) : flow.change < 0.001 ? 'No change' : money(flow.change) }}</strong></p>
      </template>

      <template v-else-if="flow.payment.method === 'split'">
        <div class="two">
          <label class="field"><span>Cash</span><input v-model="flow.payment.splitCash" type="number" inputmode="decimal" /></label>
          <label class="field"><span>Card</span><input v-model="flow.payment.splitCard" type="number" inputmode="decimal" /></label>
        </div>
        <div class="chips">
          <button type="button" class="chip exact" @click="flow.payment.splitCash = Math.max(0, flow.payment.total - (Number(flow.payment.splitCard) || 0)).toFixed(2)">Cash remainder</button>
          <button v-for="a in flow.splitCashShortcuts" :key="a" type="button" class="chip" @click="flow.payment.splitCash = String(a)">{{ a }}</button>
          <button type="button" class="chip cardc" @click="flow.payment.splitCard = Math.max(0, flow.payment.total - (Number(flow.payment.splitCash) || 0)).toFixed(2)">Card remainder</button>
        </div>
        <p>{{ flow.splitState.label }}: <strong :class="flow.splitState.cls">{{ money(flow.splitState.amount) }}</strong></p>
        <p v-if="cart.busy && hasTerminal" class="pulse">Present card to terminal…</p>
        <p v-if="cardInBase && Number(flow.payment.splitCard) > 0 && onCard(Number(flow.payment.splitCard))" class="hint">Charge <strong>{{ onCard(Number(flow.payment.splitCard)) }}</strong> on the card · {{ cardRateLabel }}</p>
      </template>

      <template v-else-if="flow.payment.method === GIVEN_AWAY">
        <p>Nothing to pay - the items leave stock and the sale is kept on record as given away.</p>
      </template>

      <template v-else>
        <p>Confirm the {{ flow.payment.method === 'card' ? 'card' : flow.payment.method }} payment was completed{{ flow.payment.method === 'card' && !hasTerminal ? ' on the terminal' : '' }}.</p>
      </template>
    </div>
    <template #footer>
      <div class="actions">
        <button type="button" @click="flow.cancelPayment">Cancel</button>
        <button v-if="flow.payment.phase === 'confirm'" type="button" :class="['primary', 'confirm', flow.payment.method]" :disabled="flow.confirmDisabled || cart.busy" @click="flow.confirmPayment">{{ flow.payment.method === GIVEN_AWAY ? 'Give away' : 'Confirm sale' }}</button>
        <button v-if="flow.payment.phase === 'failed'" type="button" class="primary" @click="flow.retryCard">Retry card</button>
        <button v-if="flow.payment.phase === 'terminal' || flow.payment.phase === 'failed' || flow.payment.phase === 'needsLogin'" type="button" @click="flow.completeByHand">{{ flow.payment.phase === 'needsLogin' ? 'Enter card by hand' : 'Complete by hand' }}</button>
        <button v-if="flow.payment.phase === 'needsLogin' && provider.configure" type="button" class="primary" @click="flow.connectReader">Log in</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.hint { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.bad { color: var(--zfy-danger, #c6512f); }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.strong { font-weight: 600; }
.confirm { min-height: 2.8rem; font-weight: 700; color: #fff; border: 0; }
.confirm.cash { background: #0e7c66; }
.confirm.card { background: #2f6fb8; }
.confirm.split { background: #b8742f; }
.confirm.free { background: #8a4fb8; }
.confirm:hover:not(:disabled) { filter: brightness(1.08); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.field { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; text-align: left; }
.field .big { font-size: 1.2rem; }
.actions { display: flex; justify-content: flex-end; gap: .5rem; }
.paybody { display: flex; flex-direction: column; gap: .8rem; text-align: center; }
.paybody p { margin: 0; }
.amount { font-size: 2rem; font-weight: 800; letter-spacing: -.01em; }
.oncard { display: flex; flex-direction: column; margin: -.25rem 0 0; font-size: 1rem; }
.oncard small { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.chips { display: flex; justify-content: center; gap: .4rem; flex-wrap: wrap; }
.chip { min-height: 2.2rem; padding: .2rem .8rem; font-weight: 600; }
.chip.exact { color: var(--zfy-accent-ink, #0a5a4a); border-color: var(--zfy-accent, #0e7c66); background: var(--zfy-accent-soft, #deeee9); }
.chip.cardc { color: #2f6fb8; border-color: #2f6fb8; }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
</style>
