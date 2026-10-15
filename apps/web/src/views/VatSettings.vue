<script setup lang="ts">
import { computed, ref } from 'vue';
import { COUNTRY_BY_CODE, EU_COUNTRIES, VAT_RATES, VAT_RATES_AS_OF, countryCodeOf, defaultExemptionNotes, fmtRate } from '@zollify/shared';
import { currentAccount, updateProfile } from '@zollify/platform';

/**
 * VAT across the countries the booth sells in: where it is exempt under a
 * small-business scheme, the EX number those receipts need, and the wording
 * printed on them. Everything else - the rates - follows each event's country,
 * and can be set per event.
 */

const account = currentAccount;
const canEdit = computed(() => account.value?.role === 'owner' || account.value?.role === 'admin');
const stored = account.value?.profile.vat;
const exempt = ref<Set<string>>(new Set(stored?.exemptCountries ?? []));
const exNumber = ref(stored?.exNumber ?? '');
const homeNote = ref(stored?.homeNote ?? '');
const crossBorderNote = ref(stored?.crossBorderNote ?? '');
const saved = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

const home = computed(() => countryCodeOf(account.value?.profile.artist.countryOfOrigin));
const defaults = computed(() => defaultExemptionNotes(home.value));
const name = (code: string): string => COUNTRY_BY_CODE[code] ?? code;
const byName = (a: string, b: string): number => name(a).localeCompare(name(b));
const eu = [...EU_COUNTRIES].sort(byName);
const other = Object.keys(VAT_RATES).filter((c) => !EU_COUNTRIES.includes(c)).sort(byName);
/** Exempt somewhere in the EU other than home: receipts there need the EX number. */
const needsEx = computed(() => [...exempt.value].some((c) => c !== home.value && EU_COUNTRIES.includes(c)));

function toggle(code: string, on: boolean): void {
  const next = new Set(exempt.value);
  if (on) next.add(code);
  else next.delete(code);
  exempt.value = next;
}
const rates = (code: string): string => {
  const r = VAT_RATES[code]!;
  return [r.standard, ...r.reduced].map(fmtRate).join(' / ');
};

async function save(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({
      vat: {
        exemptCountries: [...exempt.value].sort(),
        exNumber: exNumber.value.trim(),
        homeNote: homeNote.value.trim(),
        crossBorderNote: crossBorderNote.value.trim(),
      },
    });
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
      "Reduced" in the catalogue. Where your business is exempt under a small-business scheme, its receipts carry
      the exemption instead of VAT. Rates and exemption can also be set on each event.
    </p>
    <p v-if="!canEdit" class="hint">Only an owner or admin can change these.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <fieldset :disabled="!canEdit">
      <legend>Small-business exemption</legend>
      <p class="hint">Tick every country where you are exempt - at home, and abroad under the EU SME scheme.</p>
      <h3>EU</h3>
      <div class="countries">
        <label v-for="c in eu" :key="c">
          <input type="checkbox" :checked="exempt.has(c)" @change="toggle(c, ($event.target as HTMLInputElement).checked)" />
          <span>{{ name(c) }}<em v-if="c === home">home</em></span>
          <small>{{ rates(c) }}</small>
        </label>
      </div>
      <h3>Elsewhere</h3>
      <div class="countries">
        <label v-for="c in other" :key="c">
          <input type="checkbox" :checked="exempt.has(c)" @change="toggle(c, ($event.target as HTMLInputElement).checked)" />
          <span>{{ name(c) }}<em v-if="c === home">home</em></span>
          <small>{{ rates(c) }}</small>
        </label>
      </div>
      <p class="hint">Rates checked {{ VAT_RATES_AS_OF }}. Standard rate first, then the reduced rates; the first reduced rate is used for "Reduced" products unless an event says otherwise.</p>
    </fieldset>

    <fieldset :disabled="!canEdit">
      <legend>On exempt receipts</legend>
      <label>
        <span>EX number</span>
        <input v-model="exNumber" type="text" placeholder="e.g. DE123456789EX" />
        <small :class="{ warn: needsEx && !exNumber.trim() }">
          Your EU SME scheme identification number (it ends in "EX"). Receipts for exempt sales in another EU country
          must show it{{ needsEx && !exNumber.trim() ? ' - you have exempt countries abroad but no EX number yet.' : '.' }}
        </small>
      </label>
      <label>
        <span>Note at home</span>
        <input v-model="homeNote" type="text" :placeholder="defaults.home" />
        <small>Leave blank for the default shown.</small>
      </label>
      <label>
        <span>Note abroad</span>
        <input v-model="crossBorderNote" type="text" :placeholder="defaults.crossBorder" />
        <small>Leave blank for the default shown - the EU scheme asks receipts to say the sale is exempt under it.</small>
      </label>
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
h3 { font-size: .8rem; margin: .25rem 0 0; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted); }
.hint { color: var(--zfy-muted); margin: 0; font-size: .85rem; }
fieldset { border: 1px solid var(--zfy-line); border-radius: 10px; padding: .7rem .9rem; display: flex; flex-direction: column; gap: .6rem; }
legend { font-size: .85rem; font-weight: 600; padding: 0 .3rem; }
.countries { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: .3rem .75rem; }
.countries label { display: grid; grid-template-columns: auto 1fr; align-items: center; column-gap: .45rem; font-size: .875rem; }
.countries small { grid-column: 2; color: var(--zfy-muted); font-size: .72rem; }
.countries em { font-style: normal; font-size: .66rem; margin-left: .35rem; padding: .05rem .35rem; border-radius: 4px; background: var(--zfy-accent-soft); color: var(--zfy-accent-ink); }
fieldset > label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
fieldset > label small { color: var(--zfy-muted); font-size: .78rem; }
small.warn { color: var(--zfy-warning-ink); }
.row { display: flex; align-items: center; gap: .75rem; }
.ok { color: var(--zfy-success); margin: 0; }
.error { color: var(--zfy-danger); margin: 0; }
</style>
