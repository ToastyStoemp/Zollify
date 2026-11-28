<script setup lang="ts">
import { reactive } from 'vue';
import { ModalShell } from '@zollify/ui';
import { cart, setCustomDiscount } from '../cart';
import { useTillMoney } from '../composables/useTillMoney';
import type { ToastKind } from '../composables/useToast';
import { GIVEN_AWAY_LABEL } from '../lib/given-away';

/** Cart discount: one amount or percentage off the whole cart. Opens on the discount the cart has, if any. */
const emit = defineEmits<{ close: []; notify: [text: string, kind: ToastKind] }>();

const { currency } = useTillMoney();
const discountForm = reactive({
  type: cart.custom?.type ?? ('amount' as 'amount' | 'percent'),
  value: cart.custom ? String(cart.custom.value) : '',
  name: cart.custom?.name ?? '',
});
function applyDiscount(): void {
  const value = Number(discountForm.value);
  if (!Number.isFinite(value) || value <= 0) return emit('notify', 'Enter a discount value.', 'bad');
  if (discountForm.type === 'percent' && value > 100) return emit('notify', 'Percent discount cannot be over 100%.', 'bad');
  setCustomDiscount({ type: discountForm.type, value, name: discountForm.name.trim() || (discountForm.type === 'percent' ? `${value}% off` : 'Discount') });
  emit('close');
}
/** The whole cart for nothing: a 100% discount, which the till then completes with Give away. */
function giveAwayCart(): void {
  setCustomDiscount({ type: 'percent', value: 100, name: GIVEN_AWAY_LABEL });
  emit('close');
}
function removeDiscount(): void {
  setCustomDiscount(null);
  emit('close');
}
</script>

<template>
  <ModalShell title="Cart discount" @close="emit('close')">
    <div class="form">
      <div class="seg two">
        <button type="button" :class="{ active: discountForm.type === 'amount' }" @click="discountForm.type = 'amount'">Amount ({{ currency }})</button>
        <button type="button" :class="{ active: discountForm.type === 'percent' }" @click="discountForm.type = 'percent'">Percent (%)</button>
      </div>
      <input v-model="discountForm.value" type="number" min="0" step="0.05" inputmode="decimal" placeholder="Value" />
      <input v-model="discountForm.name" type="text" placeholder="Name (optional)" />
      <button type="button" class="free" @click="giveAwayCart">Give away - 100% off</button>
    </div>
    <template #footer>
      <div class="actions between">
        <button v-if="cart.custom" type="button" class="danger" @click="removeDiscount">Remove</button>
        <span class="spacer"></span>
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" @click="applyDiscount">Apply</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.actions .spacer { flex: 1; }
.form .free { min-height: 2.8rem; font-weight: 700; color: #fff; border: 0; background: #8a4fb8; }
.form { display: flex; flex-direction: column; gap: .6rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.seg.two { display: flex; }
.seg.two button { flex: 1; min-height: 2.5rem; }
.actions { display: flex; justify-content: flex-end; gap: .5rem; }
.actions.between { justify-content: flex-start; }
</style>
