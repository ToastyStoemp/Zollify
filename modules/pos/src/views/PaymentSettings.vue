<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { allProviders, availableProviders, onActiveProviderChanged } from '../payments/registry';
import type { PaymentProvider } from '../payments/provider';
import { sdk } from '../runtime';

const available = ref<PaymentProvider[]>([]);
const unavailable = ref<PaymentProvider[]>([]);
const active = ref<string>('manual');

onMounted(async () => {
  const usable = await availableProviders();
  available.value = usable;
  const usableIds = new Set(usable.map((p) => p.id));
  unavailable.value = allProviders().filter((p) => !usableIds.has(p.id));
  active.value = (await sdk().config.get<string>('activeProvider')) ?? 'manual';
});

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
</style>
