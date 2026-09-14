<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { allProviders, availableProviders, onActiveProviderChanged } from '../payments/registry';
import type { PaymentProvider } from '../payments/provider';
import { sdk } from '../runtime';

const available = ref<PaymentProvider[]>([]);
const unavailable = ref<PaymentProvider[]>([]);
const active = ref<string>('manual');
/** Extra buttons on the till for payments handled outside the app (TWINT, PayPal QR…). */
const customMethods = ref<string[]>([]);
const newMethod = ref('');

onMounted(async () => {
  const usable = await availableProviders();
  available.value = usable;
  const usableIds = new Set(usable.map((p) => p.id));
  unavailable.value = allProviders().filter((p) => !usableIds.has(p.id));
  active.value = (await sdk().config.get<string>('activeProvider')) ?? 'manual';
  customMethods.value = (await sdk().config.get<string[]>('customMethods')) ?? [];
});

async function addMethod(): Promise<void> {
  const name = newMethod.value.trim();
  if (!name || customMethods.value.some((m) => m.toLowerCase() === name.toLowerCase())) return;
  customMethods.value = [...customMethods.value, name];
  newMethod.value = '';
  await sdk().config.set('customMethods', customMethods.value);
}
async function removeMethod(name: string): Promise<void> {
  customMethods.value = customMethods.value.filter((m) => m !== name);
  await sdk().config.set('customMethods', customMethods.value);
}

async function select(id: string): Promise<void> {
  active.value = id;
  await sdk().config.set('activeProvider', id);
  onActiveProviderChanged(id as never);
}
</script>

<template>
  <section class="payments">
    <h2>Payments</h2>
    <p class="hint">Zollify never holds the money — the terminal settles straight to your bank.</p>

    <ul class="providers">
      <li v-for="provider in available" :key="provider.id">
        <label>
          <input
            type="radio"
            name="provider"
            :value="provider.id"
            :checked="active === provider.id"
            @change="select(provider.id)"
          />
          <span>{{ provider.label }}</span>
        </label>
      </li>
    </ul>

    <template v-if="unavailable.length">
      <h3>Needs the Android app</h3>
      <p class="hint">
        These terminals talk to hardware over Bluetooth, so they only appear in the Zollify Android
        app. The bridge and manual entry work anywhere.
      </p>
      <ul class="providers muted">
        <li v-for="provider in unavailable" :key="provider.id">{{ provider.label }}</li>
      </ul>
    </template>

    <h3>Extra payment methods</h3>
    <p class="hint">Extra buttons on the till for payments taken outside the app — TWINT, a PayPal QR code. Sales made with them count as non-cash.</p>
    <ul v-if="customMethods.length" class="methods">
      <li v-for="m in customMethods" :key="m"><span>{{ m }}</span><button type="button" class="quiet danger" @click="removeMethod(m)">Remove</button></li>
    </ul>
    <form class="add" @submit.prevent="addMethod">
      <input v-model="newMethod" type="text" placeholder="TWINT" aria-label="Method name" />
      <button type="submit" :disabled="!newMethod.trim()">Add</button>
    </form>
  </section>
</template>

<style scoped>
.payments { display: flex; flex-direction: column; gap: .75rem; max-width: 34rem; }
h2 { font-size: 1.05rem; margin: 0; }
h3 { font-size: .95rem; margin: .5rem 0 0; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .875rem; }
.providers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.providers label { display: flex; align-items: center; gap: .5rem; }
.muted { color: var(--zfy-muted, #5a6472); }
.methods { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.methods li { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .35rem .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; font-size: .875rem; }
.methods .quiet { min-height: 1.7rem; font-size: .78rem; }
.add { display: flex; gap: .4rem; }
.add input { flex: 1; min-width: 0; }
</style>
