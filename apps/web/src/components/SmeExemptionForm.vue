<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { COUNTRY_BY_CODE, EU_COUNTRIES, NO_SME_EXEMPTION, SME_THRESHOLDS, VAT_RATES, VAT_RATES_AS_OF, countryCodeOf, defaultExemptionNotes, fmtRate, smeRulesUrl } from '@zollify/shared';
import { currentAccount, updateProfile } from '@zollify/platform';
import ThresholdWarnings from './ThresholdWarnings.vue';
import { useThresholdWarnings } from '../composables/thresholds';

/**
 * Where the business is exempt under a small-business scheme, the EX number
 * those receipts need abroad, and the line printed on them. The till reads
 * all of this from the account profile for every sale.
 *
 * Two uses: inside Settings → VAT (Save button), and as a first-run setup
 * stage, where `autosave` saves each change as it happens, since setup's
 * Continue button is the wizard's. In setup the home country starts ticked:
 * the person has just said they are on a scheme, and nearly always that
 * means at home.
 */
const props = defineProps<{ autosave?: boolean }>();

const account = currentAccount.value;
const canEdit = account?.role === 'owner' || account?.role === 'admin';
const stored = account?.profile.vat;
const home = countryCodeOf(account?.profile.artist.countryOfOrigin);
const startExempt = stored?.exemptCountries?.length ? stored.exemptCountries : props.autosave && home ? [home] : [];
const exempt = ref<Set<string>>(new Set(startExempt));
const exNumber = ref(stored?.exNumber ?? '');
const homeNote = ref(stored?.homeNote ?? '');
const crossBorderNote = ref(stored?.crossBorderNote ?? '');
/** Own thresholds per country, as typed; blank = the built-in figure. */
const ownThreshold = ref<Record<string, string>>(
  Object.fromEntries(Object.entries(stored?.thresholds ?? {}).map(([c, n]) => [c, String(n)])),
);
const { warnings, thisYearBy } = useThresholdWarnings();
/** EU countries ticked as exempt, in name order: the ones with a threshold to watch. */
const exemptEu = computed(() => [...exempt.value].filter((c) => EU_COUNTRIES.includes(c)).sort(byName));
const money = (n: number, cur: string): string => `${cur} ${Math.round(n).toLocaleString('en-GB')}`;
function thresholdsToSave(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [c, v] of Object.entries(ownThreshold.value)) {
    const n = Number(String(v).replace(/[\s,']/g, ''));
    if (exempt.value.has(c) && Number.isFinite(n) && n > 0 && n !== SME_THRESHOLDS[c]?.amount) out[c] = n;
  }
  return out;
}
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
    await updateProfile({ vat: {
      scheme: 'sme',
      exemptCountries: [...exempt.value].sort(),
      exNumber: exNumber.value.trim(),
      homeNote: homeNote.value.trim(),
      crossBorderNote: crossBorderNote.value.trim(),
      thresholds: thresholdsToSave(),
    } });
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
    <p class="hint">
      Tick every country where you are exempt - at home, and abroad under the EU small-business (SME) scheme. Sales there print
      the exemption instead of VAT; everywhere else charges the country's VAT.
    </p>
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
      <h3>Outside the EU</h3>
      <p class="hint">The EU scheme does not reach these. Tick one only if that country's own rules exempt you (Switzerland, for example, below CHF 100,000 worldwide turnover).</p>
      <div class="countries">
        <label v-for="c in other" :key="c">
          <input type="checkbox" :checked="exempt.has(c)" @change="toggle(c, ($event.target as HTMLInputElement).checked)" />
          <span>{{ name(c) }}<em v-if="c === home">home</em></span>
          <small>{{ rates(c) }}</small>
        </label>
      </div>
      <p class="hint">Rates checked {{ VAT_RATES_AS_OF }}. Standard rate first, then the reduced rates.</p>
    </fieldset>

    <fieldset v-if="!autosave && exemptEu.length" :disabled="!canEdit" class="thresholds">
      <legend>Thresholds</legend>
      <p class="hint">
        The exemption only lasts while your sales in a country stay under its threshold, and across the EU under EUR 100,000 once you
        use it abroad. Zollify warns on Home from 80%. The figures are the published 2026 ones and change: check yours and type your own
        where it differs.
      </p>
      <ThresholdWarnings :warnings="warnings" />
      <div v-for="c in exemptEu" :key="c" class="th-row">
        <span class="th-name">
          <strong>{{ name(c) }}</strong>
          <small v-if="thisYearBy.get(c)">{{ money(thisYearBy.get(c)!.amount, thisYearBy.get(c)!.currency) }} this year</small>
          <small v-else>No sales there this year</small>
        </span>
        <template v-if="SME_THRESHOLDS[c]">
          <label class="th-input">
            <span class="sr-only">Threshold in {{ name(c) }}</span>
            <input v-model="ownThreshold[c]" type="number" min="0" inputmode="numeric" :placeholder="String(SME_THRESHOLDS[c]!.amount)" @input="changed" />
            <small>{{ SME_THRESHOLDS[c]!.currency }}</small>
          </label>
          <a :href="smeRulesUrl(c)" target="_blank" rel="noopener noreferrer" class="th-src">Rules</a>
        </template>
        <small v-else-if="NO_SME_EXEMPTION.includes(c)" class="warn">No small-business exemption here</small>
      </div>
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
        <span>Receipt line at home{{ home ? ` (${name(home)})` : '' }}</span>
        <input v-model="homeNote" type="text" :placeholder="defaults.home" @input="changed" />
        <small>Printed instead of VAT on sales at home. Default: "{{ defaults.home }}" - leave blank to use it.</small>
      </label>
      <label>
        <span>Receipt line in other EU countries</span>
        <input v-model="crossBorderNote" type="text" :placeholder="defaults.crossBorder" @input="changed" />
        <small>The EU scheme asks receipts to say the sale is exempt under it. Default: "{{ defaults.crossBorder }}".</small>
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
.th-row { display: grid; grid-template-columns: 1fr minmax(0, 9.5rem) auto; align-items: center; gap: .6rem; padding: .35rem 0; border-top: 1px solid var(--zfy-line); }
.th-name { display: flex; flex-direction: column; min-width: 0; font-size: .875rem; }
.th-name small { color: var(--zfy-muted); font-size: .76rem; }
.th-input { display: flex; align-items: center; gap: .35rem; }
.th-input input { width: 100%; min-width: 0; }
.th-input small { color: var(--zfy-muted); font-size: .76rem; }
.th-src { font-size: .78rem; color: var(--zfy-accent-ink); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
