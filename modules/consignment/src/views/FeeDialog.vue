<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { FEE_REASONS, type FeeReason, type SetupMoment } from '@zollify/shared';
import { ModalShell } from '@zollify/ui';
import { deliveryText, errorText, issueFee, loadBooksSettings, today } from '../api';
import { sdk } from '../runtime';

/**
 * Charging an artist a fee - for a setup they missed, going quiet, or
 * anything else the store's terms cover. It comes off what the artist is
 * owed, and they are told why; a fee can be waived later.
 */
const props = defineProps<{ consignorId: string; name: string; setup?: SetupMoment | null; storeId?: string | null }>();
const emit = defineEmits<{ close: []; done: [] }>();

const reasons = Object.entries(FEE_REASONS) as [FeeReason, string][];
const form = reactive({
  reason: (props.setup ? 'no_show' : 'unresponsive') as FeeReason,
  amount: '' as string | number,
  currency: sdk().account()?.profile.defaultCurrency ?? 'CHF',
  date: today(),
  note: '',
});
const presets = ref<Partial<Record<FeeReason, number>>>({});
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => {
  try {
    presets.value = (await loadBooksSettings()).feePresets;
  } catch {
    // Presets are a convenience: the dialog works without them.
  }
  usePreset();
});
function usePreset(): void {
  const preset = presets.value[form.reason];
  if (preset) form.amount = preset.toFixed(2);
}

async function submit(): Promise<void> {
  const amount = Number(form.amount);
  if (!(amount > 0)) return void (error.value = 'Enter the fee.');
  busy.value = true;
  error.value = null;
  try {
    const { delivery } = await issueFee({
      consignorId: props.consignorId,
      storeId: props.storeId ?? props.setup?.storeId ?? null,
      reason: form.reason,
      amount,
      currency: form.currency.trim().toUpperCase(),
      date: form.date,
      note: form.note.trim(),
      setupId: props.setup?.id ?? null,
    });
    sdk().ui.toast(`Fee charged. ${deliveryText(props.name, delivery)}`, { kind: 'success' });
    emit('done');
    emit('close');
  } catch (err) {
    error.value = errorText(err, 'Could not charge the fee.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalShell :title="`Charge ${name} a fee`" @close="emit('close')">
    <div class="form">
      <p class="hint">
        <template v-if="setup">For the setup on {{ setup.date }} at {{ setup.time }}. </template>It comes off what you owe {{ name }}, who is told by notification and email, and can object. You can waive it later.
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <label>
        <span>Reason</span>
        <select v-model="form.reason" @change="usePreset">
          <option v-for="[id, label] in reasons" :key="id" :value="id">{{ label }}</option>
        </select>
      </label>
      <div class="two">
        <label><span>Amount</span><input v-model="form.amount" type="number" min="0" step="0.01" inputmode="decimal" /></label>
        <label><span>Currency</span><input v-model="form.currency" type="text" maxlength="3" /></label>
      </div>
      <label><span>Date</span><input v-model="form.date" type="date" /></label>
      <label><span>Note for {{ name }}</span><textarea v-model="form.note" rows="2" placeholder="As agreed in our consignment terms…" /></label>
    </div>
    <template #footer>
      <div class="footer">
        <button type="button" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" :disabled="busy" @click="submit">Charge and notify</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: .7rem; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.two { display: grid; grid-template-columns: 2fr 1fr; gap: .6rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.footer { display: flex; justify-content: flex-end; gap: .5rem; }
</style>
