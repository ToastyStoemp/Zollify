<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { COUNTRY_BY_CODE, EU_COUNTRIES, VAT_RATES, VAT_RATES_AS_OF, countryCodeOf, defaultExemptionNotes, fmtRate } from '@zollify/shared';
import { sdk } from '../runtime';

/**
 * Where the business is exempt under a small-business scheme, the EX number
 * those receipts need abroad, and the wording printed on them. The till reads
 * all of this from the account profile for every sale, so it is saved there.
 *
 * Two uses: the module's settings panel (Save button), and its first-run
 * setup step, where `autosave` saves each change as it happens, since setup's
 * Continue button belongs to the shell and cannot save for us. In setup the
 * home country starts ticked: the person has just said they are on a scheme,
 * and nearly always that means at home.
 */
const props = defineProps<{ autosave?: boolean }>();

const account = sdk().account();
const canEdit = account?.role === 'owner' || account?.role === 'admin';
const stored = account?.profile.vat;
const home = countryCodeOf(account?.profile.artist.countryOfOrigin);
const startExempt = stored?.exemptCountries?.length ? stored.exemptCountries : props.autosave && home ? [home] : [];
const exempt = ref<Set<string>>(new Set(startExempt));
const exNumber = ref(stored?.exNumber ?? '');
const homeNote = ref(stored?.homeNote ?? '');
const crossBorderNote = ref(stored?.crossBorderNote ?? '');
const saved = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

const defaults = defaultExemptionNotes(home);
const name = (code: string): string => COUNTRY_BY_CODE[code] ?? code;
const byName = (a: string, b: string): number => name(a).localeCompare(name(b));
const eu = [...EU_COUNTRIES].sort(byName);
const other = Object.keys(VAT_RATES).filter((c) => !EU_COUNTRIES.includes(c)).sort(byName);
/** Exempt somewhere in the EU other than home: receipts there need the EX number. */
const needsEx = computed(() => [...exempt.value].some((c) => c !== home && EU_COUNTRIES.includes(c)));
const rates = (code: string): string => {
  const r = VAT_RATES[code]!;
  return [r.standard, ...r.reduced].map(fmtRate).join(' / ');
};

let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
function changed(): void {
  if (!props.autosave) return;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => void save(), 600);
}
function toggle(code: string, on: boolean): void {
  const next = new Set(exempt.value);
  if (on) next.add(code);
  else next.delete(code);
  exempt.value = next;
  changed();
}

async function save(): Promise<void> {
  if (!canEdit) return;
  clearTimeout(timer);
  dirty = false;
  busy.value = true;
  error.value = null;
  try {
    await sdk().updateVatProfile({
      scheme: 'sme',
      exemptCountries: [...exempt.value].sort(),
      exNumber: exNumber.value.trim(),
      homeNote: homeNote.value.trim(),
      crossBorderNote: crossBorderNote.value.trim(),
    });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the exemption.';
  } finally {
    busy.value = false;
  }
}

// Setup prefilled the home country: keep it even if nothing else is touched.
if (props.autosave && !stored?.exemptCountries?.length && startExempt.length) changed();
// Leaving setup mid-typing still keeps what was typed.
onUnmounted(() => {
  if (dirty) void save();
});
</script>

<template>
  <form class="sme-exempt" @submit.prevent="save">
    <h2 v-if="!autosave">Small-business exemption</h2>
    <p class="hint">
      Tick every country where you are exempt - at home, and abroad under the EU SME scheme. Sales there print
      the exemption instead of VAT; everywhere else charges the country's VAT.
    </p>
    <p v-if="!canEdit" class="hint">Only an owner or admin can change these.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <fieldset :disabled="!canEdit">
      <legend>Exempt in</legend>
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
      <p class="hint">Rates checked {{ VAT_RATES_AS_OF }}. Standard rate first, then the reduced rates.</p>
    </fieldset>

    <fieldset :disabled="!canEdit">
      <legend>On exempt receipts</legend>
      <label>
        <span>EX number</span>
        <input v-model="exNumber" type="text" placeholder="e.g. BE0123456789EX" @input="changed" />
        <small :class="{ warn: needsEx && !exNumber.trim() }">
          Your EU SME scheme identification number (it ends in "EX"). Receipts for exempt sales in another EU country
          must show it{{ needsEx && !exNumber.trim() ? ' - you are exempt abroad but have no EX number yet.' : '.' }}
        </small>
      </label>
      <label>
        <span>Note at home</span>
        <input v-model="homeNote" type="text" :placeholder="defaults.home" @input="changed" />
        <small>Leave blank for the default shown.</small>
      </label>
      <label>
        <span>Note abroad</span>
        <input v-model="crossBorderNote" type="text" :placeholder="defaults.crossBorder" @input="changed" />
        <small>Leave blank for the default shown - the EU scheme asks receipts to say the sale is exempt under it.</small>
      </label>
    </fieldset>

    <div v-if="!autosave" class="row">
      <button type="submit" class="primary" :disabled="busy || !canEdit">{{ busy ? 'Saving…' : 'Save' }}</button>
      <p v-if="saved" class="ok" role="status">Saved.</p>
    </div>
    <p v-else class="hint" role="status">{{ busy ? 'Saving…' : saved ? 'Saved.' : 'Changes save as you go.' }}</p>
  </form>
</template>

<style scoped>
.sme-exempt { display: flex; flex-direction: column; gap: .85rem; max-width: 44rem; }
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
