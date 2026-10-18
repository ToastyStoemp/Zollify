<script setup lang="ts">
import { computed, ref } from 'vue';
import { COUNTRY_BY_CODE, VAT_RATES_AS_OF, countryCodeOf, vatIdLabel } from '@zollify/shared';
import { currentAccount, shellConfirm, updateProfile } from '@zollify/platform';
import { CountryPicker } from '@zollify/ui';
import SmeExemptionForm from '../components/SmeExemptionForm.vue';

/**
 * VAT across the countries the business sells in: whether it is on a
 * small-business scheme, and its VAT number in each country it is registered
 * in. Rates follow each event's country and can be set per event.
 *
 * Answering Yes opens the exemption itself (which countries, the EX number,
 * the receipt line) right here - one panel for one decision. Choosing "I
 * charge VAT" ends an exemption, after asking.
 */

const account = currentAccount;
const canEdit = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');
const stored = account.value?.profile.vat;
const scheme = ref<'' | 'sme' | 'vat'>(stored?.scheme || (stored?.exemptCountries?.length ? 'sme' : ''));
// Country kept as an ISO code; blank rows are dropped on save.
const numbers = ref<{ country: string; number: string }[]>((stored?.vatNumbers ?? []).map((v) => ({ ...v })));
const saved = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

const home = computed(() => countryCodeOf(account.value?.profile.artist.countryOfOrigin));
const defaultVat = computed(() => account.value?.profile.artist.vatId?.trim() ?? '');
const exemptIn = computed(() => account.value?.profile.vat?.exemptCountries ?? []);
const name = (code: string): string => COUNTRY_BY_CODE[code] ?? code;
const dupes = computed(() => {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const n of numbers.value) {
    if (!n.country) continue;
    if (seen.has(n.country)) out.add(n.country);
    seen.add(n.country);
  }
  return out;
});

function addRow(): void {
  numbers.value = [...numbers.value, { country: '', number: '' }];
}
function removeRow(i: number): void {
  numbers.value = numbers.value.filter((_, j) => j !== i);
}

async function save(): Promise<void> {
  error.value = null;
  if (dupes.value.size) {
    error.value = `Only one VAT number per country - ${[...dupes.value].map(name).join(', ')} is listed twice.`;
    return;
  }
  const clean = numbers.value
    .map((n) => ({ country: n.country.trim().toUpperCase(), number: n.number.trim() }))
    .filter((n) => /^[A-Z]{2}$/.test(n.country) && n.number);
  // Charging VAT everywhere ends any exemption, or new sales would keep printing it.
  const endExemption = scheme.value === 'vat' && exemptIn.value.length > 0;
  if (endExemption && !(await shellConfirm(`New sales in ${exemptIn.value.map(name).join(', ')} will charge VAT instead of printing the exemption.`, 'Stop the exemption?'))) return;
  busy.value = true;
  try {
    await updateProfile({ vat: { scheme: scheme.value, vatNumbers: clean, ...(endExemption ? { exemptCountries: [] } : {}) } });
    numbers.value = clean;
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the VAT settings.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="vat" @submit.prevent="save">
    <h2>VAT</h2>
    <p class="hint">
      Each event charges the VAT of its country - standard rate, or the reduced rate for products set to
      "Reduced" in the catalogue (rates checked {{ VAT_RATES_AS_OF }}, and adjustable per event).
    </p>
    <p v-if="!canEdit" class="hint">Only an owner or admin can change these.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <fieldset :disabled="!canEdit" class="choice">
      <legend>Are you on a small-business VAT scheme?</legend>
      <label :class="{ on: scheme === 'sme' }">
        <input v-model="scheme" type="radio" name="scheme" value="sme" />
        <strong>Yes</strong>
        <span>Exempt below a turnover threshold, at home and maybe abroad under the EU SME scheme.</span>
      </label>
      <label :class="{ on: scheme === 'vat' }">
        <input v-model="scheme" type="radio" name="scheme" value="vat" />
        <strong>No, I charge VAT</strong>
        <span>Receipts show VAT and your VAT number.</span>
      </label>
    </fieldset>

    <section v-if="scheme === 'sme'" class="exemption">
      <h3>Where you are exempt</h3>
      <p v-if="!exemptIn.length" class="warn">No exempt countries ticked yet, so every sale still charges VAT.</p>
      <SmeExemptionForm />
      <p class="hint">The quarterly report of sales per country for the EU scheme is the SME report module, under Books.</p>
    </section>

    <fieldset :disabled="!canEdit">
      <legend>VAT numbers</legend>
      <p class="hint">
        <template v-if="scheme === 'sme'">If you are registered for VAT anywhere you are not exempt, add that number here.</template>
        <template v-else>Add a number for each country you are registered in.</template>
        Receipts in that country print it; everywhere else prints your default
        {{ defaultVat ? `(${defaultVat}, from the business profile)` : 'from the business profile' }}.
      </p>
      <div v-for="(n, i) in numbers" :key="i" class="vatrow">
        <CountryPicker v-model="n.country" store="code" :placeholder="name(home) || 'Country'" />
        <input v-model="n.number" type="text" class="mono" :placeholder="n.country ? `${vatIdLabel(n.country)} number` : 'VAT number'" :aria-label="`VAT number ${i + 1}`" />
        <button type="button" class="quiet" aria-label="Remove" @click="removeRow(i)">×</button>
        <small v-if="dupes.has(n.country)" class="warn">Listed twice</small>
      </div>
      <button type="button" class="quiet add" @click="addRow">+ Add a country</button>
    </fieldset>

    <div class="row">
      <button type="submit" class="primary" :disabled="busy || !canEdit">{{ busy ? 'Saving…' : 'Save' }}</button>
      <p v-if="saved" class="ok" role="status">Saved.</p>
    </div>
  </form>
</template>

<style scoped>
.vat { display: flex; flex-direction: column; gap: .85rem; max-width: 44rem; }
h2 { font-size: 1.05rem; margin: 0; }
.hint { color: var(--zfy-muted); margin: 0; font-size: .85rem; }
fieldset { border: 1px solid var(--zfy-line); border-radius: 10px; padding: .7rem .9rem; display: flex; flex-direction: column; gap: .6rem; margin: 0; }
legend { font-size: .85rem; font-weight: 600; padding: 0 .3rem; }
.choice { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .5rem; }
.choice label { display: flex; flex-direction: column; gap: .2rem; padding: .6rem .75rem; border: 1px solid var(--zfy-line); border-radius: 10px; cursor: pointer; font-size: .85rem; }
.choice label.on { border-color: var(--zfy-accent); background: var(--zfy-accent-soft); }
.choice label:focus-within { outline: 2px solid var(--zfy-accent); outline-offset: 2px; }
.choice input { position: absolute; opacity: 0; pointer-events: none; }
.choice span { color: var(--zfy-muted); }
.exemption { display: flex; flex-direction: column; gap: .6rem; border: 1px solid var(--zfy-line); border-radius: 10px; padding: .7rem .9rem; }
.exemption h3 { margin: 0; font-size: .85rem; font-weight: 600; }
.vatrow { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(10rem, 1.3fr) auto; gap: .4rem; align-items: center; }
.vatrow small { grid-column: 1 / -1; }
.mono { font-variant-numeric: tabular-nums; }
.add { align-self: flex-start; }
.warn { color: var(--zfy-warning-ink); }
.row { display: flex; align-items: center; gap: .75rem; }
.ok { color: var(--zfy-success); margin: 0; }
.error { color: var(--zfy-danger); margin: 0; }
@media (max-width: 480px) { .vatrow { grid-template-columns: 1fr auto; } .vatrow input { grid-column: 1; } }
</style>
