<script setup lang="ts">
import { reactive } from 'vue';
import { ModalShell } from '@zollify/ui';
import { addMisc } from '../cart';
import { useTillMoney } from '../composables/useTillMoney';
import type { ToastKind } from '../composables/useToast';

/** Misc item: something that is not in the catalogue, typed in at the till. Opens empty every time. */
const emit = defineEmits<{ close: []; notify: [text: string, kind: ToastKind] }>();

const { currency } = useTillMoney();
const miscForm = reactive({ title: '', price: '', qty: '1' });
function addMiscItem(): void {
  const p = Number(miscForm.price);
  const qty = Math.max(1, Math.floor(Number(miscForm.qty)) || 1);
  if (!Number.isFinite(p) || p <= 0) return emit('notify', 'Enter a price for the item.', 'bad');
  // Entered in the charge currency; the cart charges it as typed and keeps its base value for the books.
  addMisc(miscForm.title, p, qty);
  emit('close');
}
</script>

<template>
  <ModalShell title="Misc item" @close="emit('close')">
    <p class="hint">Sell something that isn't in the catalogue - a commission, old stock. No stock is tracked and rule discounts don't apply.</p>
    <div class="form">
      <input v-model="miscForm.title" type="text" placeholder="Description (e.g. Commission)" />
      <div class="two">
        <label><span>Price ({{ currency }})</span><input v-model="miscForm.price" type="number" min="0" step="0.05" inputmode="decimal" /></label>
        <label><span>Quantity</span><input v-model="miscForm.qty" type="number" min="1" inputmode="numeric" /></label>
      </div>
    </div>
    <template #footer>
      <div class="actions"><button type="button" @click="emit('close')">Cancel</button><button type="button" class="primary" @click="addMiscItem">Add to cart</button></div>
    </template>
  </ModalShell>
</template>

<style scoped>
.hint { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
.form { display: flex; flex-direction: column; gap: .6rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.actions { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
