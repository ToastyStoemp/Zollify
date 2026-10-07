<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { api } from '../api';
import { choiceOf, emptyChoice, retentionLine, type CustomerChoice, type CustomerContact } from '../customer-form';

/**
 * The customer part of a commission form: search for someone already on file
 * (name, email or phone, looked up on the server), or just type a new customer
 * in the same form. A new customer who looks like an existing one is offered
 * back, never merged. Says how long details are kept.
 */
const props = defineProps<{ modelValue: CustomerChoice; keepDays: number; duplicates: CustomerContact[] }>();
const emit = defineEmits<{ 'update:modelValue': [CustomerChoice]; 'use-duplicate': [CustomerContact]; 'add-anyway': [] }>();

const query = ref('');
const results = ref<CustomerContact[]>([]);
const searching = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let latest = 0;

const set = (patch: Partial<CustomerChoice>): void => emit('update:modelValue', { ...props.modelValue, ...patch });
const field = (e: Event): string => (e.target as HTMLInputElement).value;

function onSearch(): void {
  clearTimeout(timer);
  const q = query.value.trim();
  if (q.length < 2) {
    results.value = [];
    searching.value = false;
    return;
  }
  searching.value = true;
  const mine = ++latest;
  timer = setTimeout(async () => {
    try {
      const res = await api.searchCustomers(q);
      if (mine === latest) results.value = res.customers;
    } catch {
      if (mine === latest) results.value = [];
    } finally {
      if (mine === latest) searching.value = false;
    }
  }, 250);
}
onBeforeUnmount(() => clearTimeout(timer));

function pick(c: CustomerContact): void {
  emit('update:modelValue', choiceOf(c));
  query.value = '';
  results.value = [];
}
const change = (): void => emit('update:modelValue', emptyChoice());
</script>

<template>
  <fieldset class="customer">
    <legend>Customer</legend>

    <div v-if="modelValue.picked" class="chip">
      <span>
        <strong>{{ modelValue.picked.name }}</strong>
        <small class="hint">{{ [modelValue.picked.email, modelValue.picked.phone].filter(Boolean).join(' · ') || 'No contact details' }}</small>
      </span>
      <button type="button" @click="change">Change</button>
    </div>

    <template v-else>
      <label class="find">Find a customer <small>name, email or phone</small>
        <input v-model="query" type="search" autocomplete="off" placeholder="Start typing to find someone on file" @input="onSearch" />
      </label>
      <ul v-if="results.length" class="results" aria-label="Customers found">
        <li v-for="c in results" :key="c.id">
          <button type="button" @click="pick(c)"><strong>{{ c.name }}</strong> <small class="hint">{{ [c.email, c.phone].filter(Boolean).join(' · ') }}</small></button>
        </li>
      </ul>
      <p v-else-if="query.trim().length >= 2 && !searching" class="hint">Nobody found. Fill in the details below to add them.</p>

      <p class="or">or a new customer</p>
      <label>Name <input :value="modelValue.name" type="text" maxlength="120" required autocomplete="off" @input="set({ name: field($event) })" /></label>
      <div class="two">
        <label>Email <input :value="modelValue.email" type="email" maxlength="254" autocomplete="off" @input="set({ email: field($event) })" /></label>
        <label>Phone <input :value="modelValue.phone" type="tel" maxlength="40" autocomplete="off" @input="set({ phone: field($event) })" /></label>
      </div>

      <div v-if="duplicates.length" class="dup" role="alert">
        <p><strong>Already on file?</strong> Someone with this email or phone number is already a customer.</p>
        <ul>
          <li v-for="d in duplicates" :key="d.id">
            <span>{{ d.name }} <small class="hint">{{ [d.email, d.phone].filter(Boolean).join(' · ') }}</small></span>
            <button type="button" class="primary" @click="emit('use-duplicate', d)">Use this customer</button>
          </li>
        </ul>
        <button type="button" @click="emit('add-anyway')">Add as a new customer anyway</button>
      </div>
    </template>

    <p class="hint">{{ retentionLine(keepDays) }}</p>
  </fieldset>
</template>

<style scoped>
.customer { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .5rem; margin: 0; min-width: 0; }
legend { font-weight: 600; font-size: .9rem; padding: 0 .3rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .875rem; }
label small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.chip { display: flex; justify-content: space-between; align-items: center; gap: .6rem; }
.chip span { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
.results button { width: 100%; text-align: left; font-weight: 400; min-height: 2.6rem; }
.or { margin: .1rem 0 0; font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.dup { border: 1px solid #c2410c; border-radius: 8px; padding: .5rem .7rem; display: flex; flex-direction: column; gap: .4rem; font-size: .88rem; }
.dup p { margin: 0; }
.dup ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.dup li { display: flex; justify-content: space-between; align-items: center; gap: .5rem; flex-wrap: wrap; }
@media (max-width: 800px) { .two { grid-template-columns: 1fr; } }
</style>
