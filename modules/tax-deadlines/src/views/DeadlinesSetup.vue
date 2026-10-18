<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  COUNTRIES,
  EU_COUNTRIES,
  GERMAN_STATES,
  REMINDER_PRESETS,
  defaultTaxDeadlineSettings,
  hasCountryRules,
  leadLabel,
  localIsoDay,
  normalizeLeadDays,
  rulesFor,
  type CustomDeadline,
  type TaxDeadlineSettings,
} from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { loadState, saveSettings } from '../api';
import { fromBusinessProfile, vatMismatch } from '../from-profile';
import { sdk } from '../runtime';

/**
 * The tax setup the deadlines are worked out from, how early to be reminded,
 * and the business's own deadlines. Shown on the module's page and as a
 * panel under Settings.
 */
const emit = defineEmits<{ saved: [] }>();
/** A plain copy: the cached state is reactive, which structuredClone refuses. */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const form = ref<TaxDeadlineSettings | null>(null);
const busy = ref(false);
const error = ref('');
const notice = ref('');
const extraDays = ref<number | ''>('');

const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  } catch {
    return 'Europe/Berlin';
  }
})();
const zones = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [] as string[];
  }
})();

onMounted(async () => {
  try {
    const s = (await loadState()).settings;
    // Never set up yet: start from what the business already said (country, VAT scheme, EX number).
    form.value = clone(s.configured ? s : { ...s, profile: fromBusinessProfile(s.profile, sdk().account()?.profile), reminders: { ...s.reminders, timeZone: deviceZone } });
  } catch {
    form.value = { ...defaultTaxDeadlineSettings(), reminders: { ...defaultTaxDeadlineSettings().reminders, timeZone: deviceZone } };
    error.value = 'Could not load your settings; saving will start fresh.';
  }
});

const p = computed(() => form.value!.profile);
/** The deadlines' VAT status disagrees with Settings → VAT: say so, the reminders would be for the wrong returns. */
const mismatch = computed(() => (form.value ? vatMismatch(form.value.profile, sdk().account()?.profile) : null));
const isDE = computed(() => p.value.country === 'DE');
const isSE = computed(() => p.value.country === 'SE');
const inEU = computed(() => EU_COUNTRIES.includes(p.value.country));
const known = computed(() => hasCountryRules(p.value.country));
const rules = computed(() => (form.value ? rulesFor(form.value.profile) : []));
const countryName = computed(() => COUNTRIES.find((c) => c.code === p.value.country)?.name ?? p.value.country);

const thisYear = Number(localIsoDay().slice(0, 4));
/** The start year as the input holds it: '' for none, since a number input cannot hold undefined. */
const startYear = computed<number | ''>({
  get: () => p.value.startYear ?? '',
  set: (v) => {
    const n = Number(v);
    if (v === '' || !Number.isInteger(n)) delete p.value.startYear;
    else p.value.startYear = n;
  },
});

const leads = computed(() => normalizeLeadDays(form.value?.reminders.leadDays ?? []));
const extraLeads = computed(() => leads.value.filter((d) => !REMINDER_PRESETS.some((pr) => pr.days === d)));
function toggleLead(days: number): void {
  const r = form.value!.reminders;
  r.leadDays = leads.value.includes(days) ? leads.value.filter((d) => d !== days) : normalizeLeadDays([...leads.value, days]);
}
function addExtra(): void {
  const n = Number(extraDays.value);
  if (!Number.isInteger(n) || n < 0 || n > 90) return void (error.value = 'Pick a whole number of days from 0 to 90.');
  if (leads.value.length >= 6 && !leads.value.includes(n)) return void (error.value = 'Six reminders per deadline at most.');
  error.value = '';
  form.value!.reminders.leadDays = normalizeLeadDays([...leads.value, n]);
  extraDays.value = '';
}

function toggleRule(id: string): void {
  const f = form.value!;
  f.off = f.off.includes(id) ? f.off.filter((x) => x !== id) : [...f.off, id];
}

const newId = () => Math.random().toString(36).slice(2, 10);
function addCustom(): void {
  form.value!.custom.push({ id: newId(), title: '', note: '', action: 'file', repeat: 'yearly', date: localIsoDay() });
}
function removeCustom(c: CustomDeadline): void {
  form.value!.custom = form.value!.custom.filter((x) => x.id !== c.id);
}

async function save(): Promise<void> {
  const f = form.value!;
  if (f.custom.some((c) => !c.title.trim())) return void (error.value = 'Give each of your own deadlines a name.');
  if (f.profile.startYear !== undefined && (f.profile.startYear < 1990 || f.profile.startYear > thisYear + 1)) return void (error.value = `The start year must be between 1990 and ${thisYear + 1}.`);
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    // Settings that do not apply are cleared, so the profile reads true later.
    const profile = { ...f.profile };
    if (profile.country !== 'DE') profile.region = '';
    if (profile.country !== 'SE') {
      profile.euTrade = false;
      profile.largeBusiness = false;
    }
    if (!EU_COUNTRIES.includes(profile.country)) profile.euSmeScheme = false;
    if (profile.vat !== 'regular') profile.extension = false;
    if (!profile.tradeTax) profile.tradeTaxPrepayments = false;
    // An emptied "until" field comes back as '', which is no date.
    const custom = f.custom.map(({ until, ...c }) => ({ ...c, title: c.title.trim(), ...(until && c.repeat !== 'once' ? { until } : {}) }));
    form.value = clone((await saveSettings({ ...f, profile, custom })).settings);
    notice.value = 'Saved. Reminders follow these settings from now on.';
    emit('saved');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="form" class="setup">
    <p class="hint">
      Deadlines are worked out from how your business is set up. They are not tax advice: check your own dates with the tax office or your tax advisor.
    </p>

    <section class="block">
      <h3>Your business</h3>
      <div class="two">
        <label>
          <span>Established in</span>
          <select v-model="form.profile.country">
            <option v-for="c in COUNTRIES" :key="c.code" :value="c.code">{{ c.name }}</option>
          </select>
        </label>
        <label v-if="isDE">
          <span>State (for holidays)</span>
          <select v-model="form.profile.region">
            <option value="">Not set: national holidays only</option>
            <option v-for="s in GERMAN_STATES" :key="s.code" :value="s.code">{{ s.name }}</option>
          </select>
        </label>
      </div>
      <p v-if="!known" class="note">
        <Icon name="alert-triangle" :size="14" />
        Zollify knows the tax calendars of Germany and Sweden so far. For {{ countryName }} you get {{ inEU ? 'the EU SME scheme report and ' : '' }}the deadlines you add below.
      </p>
      <p v-if="mismatch" class="note"><Icon name="alert-triangle" :size="14" /> {{ mismatch }}</p>

      <template v-if="isDE">
        <div class="field">
          <span>Legal form</span>
          <div class="seg">
            <button type="button" :class="{ on: p.legalForm === 'sole' }" @click="p.legalForm = 'sole'">Sole trader or freelancer</button>
            <button type="button" :class="{ on: p.legalForm === 'company' }" @click="p.legalForm = 'company'">Company (GmbH, UG)</button>
          </div>
        </div>

        <div class="field">
          <span>VAT</span>
          <div class="seg">
            <button type="button" :class="{ on: p.vat === 'regular' }" @click="p.vat = 'regular'">I charge VAT</button>
            <button type="button" :class="{ on: p.vat === 'small-business' }" @click="p.vat = 'small-business'">Kleinunternehmer (§19)</button>
            <button type="button" :class="{ on: p.vat === 'none' }" @click="p.vat = 'none'">No VAT</button>
          </div>
        </div>

        <template v-if="p.vat === 'regular'">
          <div class="field">
            <span>VAT returns</span>
            <div class="seg">
              <button type="button" :class="{ on: p.vatFrequency === 'monthly' }" @click="p.vatFrequency = 'monthly'">Monthly</button>
              <button type="button" :class="{ on: p.vatFrequency === 'quarterly' }" @click="p.vatFrequency = 'quarterly'">Quarterly</button>
              <button type="button" :class="{ on: p.vatFrequency === 'yearly' }" @click="p.vatFrequency = 'yearly'">Yearly only</button>
            </div>
            <small class="hint">The tax office tells you which. As a rule: monthly above €9,000 VAT owed last year, quarterly from €2,000, below that yearly only.</small>
          </div>
          <label v-if="p.vatFrequency !== 'yearly'" class="check">
            <input v-model="p.extension" type="checkbox" />
            <span>Dauerfristverlängerung: one month more for each return<small v-if="p.vatFrequency === 'monthly'">, with a special prepayment each February</small></span>
          </label>
        </template>

        <label class="check"><input v-model="p.advisor" type="checkbox" /><span>A tax advisor files my annual returns<small> (later deadline)</small></span></label>
        <label class="check"><input v-model="p.tradeTax" type="checkbox" /><span>I run a trade (Gewerbe) and pay trade tax<small> (most freelancers do not)</small></span></label>
        <label class="check"><input v-model="p.incomeTaxPrepayments" type="checkbox" /><span>{{ p.legalForm === 'company' ? 'Corporate' : 'Income' }} tax prepayments<small> (10 Mar, Jun, Sep, Dec)</small></span></label>
        <label v-if="p.tradeTax" class="check"><input v-model="p.tradeTaxPrepayments" type="checkbox" /><span>Trade tax prepayments<small> (15 Feb, May, Aug, Nov)</small></span></label>
        <label class="check"><input v-model="p.ecSalesList" type="checkbox" /><span>EC Sales List (Zusammenfassende Meldung)<small> for VAT-free sales to businesses in other EU countries</small></span></label>
        <div v-if="p.ecSalesList" class="seg indent">
          <button type="button" :class="{ on: p.ecSalesListFrequency === 'monthly' }" @click="p.ecSalesListFrequency = 'monthly'">Monthly</button>
          <button type="button" :class="{ on: p.ecSalesListFrequency === 'quarterly' }" @click="p.ecSalesListFrequency = 'quarterly'">Quarterly</button>
        </div>
      </template>

      <template v-if="isSE">
        <div class="field">
          <span>Legal form</span>
          <div class="seg">
            <button type="button" :class="{ on: p.legalForm === 'sole' }" @click="p.legalForm = 'sole'">Enskild firma</button>
            <button type="button" :class="{ on: p.legalForm === 'company' }" @click="p.legalForm = 'company'">Aktiebolag</button>
          </div>
        </div>

        <div class="field">
          <span>VAT (moms)</span>
          <div class="seg">
            <button type="button" :class="{ on: p.vat === 'regular' }" @click="p.vat = 'regular'">I charge VAT</button>
            <button type="button" :class="{ on: p.vat === 'small-business' }" @click="p.vat = 'small-business'">Exempt (momsbefriad)</button>
            <button type="button" :class="{ on: p.vat === 'none' }" @click="p.vat = 'none'">No VAT</button>
          </div>
          <small class="hint">Exempt: turnover under SEK 120,000 a year, or an artist selling only their own works for under SEK 300,000 - no VAT return to file.</small>
        </div>

        <template v-if="p.vat === 'regular'">
          <div class="field">
            <span>VAT returns</span>
            <div class="seg">
              <button type="button" :class="{ on: p.vatFrequency === 'monthly' }" @click="p.vatFrequency = 'monthly'">Monthly</button>
              <button type="button" :class="{ on: p.vatFrequency === 'quarterly' }" @click="p.vatFrequency = 'quarterly'">Quarterly</button>
              <button type="button" :class="{ on: p.vatFrequency === 'yearly' }" @click="p.vatFrequency = 'yearly'">Yearly</button>
            </div>
            <small class="hint">By your taxable base: yearly up to SEK 1 million, quarterly up to SEK 40 million (monthly on request), monthly above that. Skatteverket's registration says which.</small>
          </div>
          <label v-if="p.vatFrequency === 'monthly'" class="check">
            <input v-model="p.largeBusiness" type="checkbox" />
            <span>Taxable base over SEK 40 million<small>: returns due the 26th of the next month</small></span>
          </label>
          <label v-if="p.vatFrequency === 'yearly'" class="check">
            <input v-model="p.euTrade" type="checkbox" />
            <span>I buy or sell with other EU countries<small>: the yearly return is then due 26 February</small></span>
          </label>
        </template>

        <label class="check"><input v-model="p.incomeTaxPrepayments" type="checkbox" /><span>Debited preliminary tax (F-skatt) each month<small> (the 12th; the 17th in January and August)</small></span></label>
        <label class="check"><input v-model="p.ecSalesList" type="checkbox" /><span>EC Sales List (periodisk sammanställning)<small> for VAT-free sales to businesses in other EU countries</small></span></label>
        <div v-if="p.ecSalesList" class="seg indent">
          <button type="button" :class="{ on: p.ecSalesListFrequency === 'monthly' }" @click="p.ecSalesListFrequency = 'monthly'">Monthly (goods)</button>
          <button type="button" :class="{ on: p.ecSalesListFrequency === 'quarterly' }" @click="p.ecSalesListFrequency = 'quarterly'">Quarterly (services only)</button>
        </div>
        <p class="note">
          <Icon name="alert-triangle" :size="14" />
          Sweden requires a certified cash register (kassaregister with a control unit) once cash and card sales pass four price base amounts a year (SEK 236,800 in 2026). Zollify is not a certified kassaregister: below that line it can be your till, above it you need one that is, unless Skatteverket grants an exemption.
        </p>
      </template>

      <label v-if="inEU" class="check">
        <input v-model="p.euSmeScheme" type="checkbox" />
        <span>I use the EU cross-border SME scheme (EX number)<small>: a quarterly turnover report</small></span>
      </label>

      <label class="start">
        <span>My business started in <small>(optional)</small></span>
        <input v-model="startYear" type="number" inputmode="numeric" :min="1990" :max="thisYear + 1" :placeholder="String(thisYear)" />
        <small class="hint">Deadlines count from this year on. Left empty, they count from the day this account was created, so nothing from before shows as missed.</small>
      </label>
    </section>

    <section v-if="rules.length" class="block">
      <h3>Deadlines to follow</h3>
      <p class="hint">Only the deadlines your answers above call for are listed. Untick any that still do not apply to you.</p>
      <label v-for="r in rules" :key="r.id" class="check">
        <input type="checkbox" :checked="!form.off.includes(r.id)" @change="toggleRule(r.id)" />
        <span>{{ r.label }}</span>
      </label>
    </section>

    <section class="block">
      <h3>Reminders</h3>
      <p class="hint">How early to be reminded of each deadline. Pick as many as you like.</p>
      <div class="chips">
        <button v-for="pr in REMINDER_PRESETS" :key="pr.days" type="button" :class="['chip', { on: leads.includes(pr.days) }]" :aria-pressed="leads.includes(pr.days)" @click="toggleLead(pr.days)">
          {{ pr.label }}
        </button>
        <button v-for="d in extraLeads" :key="d" type="button" class="chip on" aria-pressed="true" @click="toggleLead(d)">{{ leadLabel(d) }} <Icon name="x" :size="12" /></button>
      </div>
      <div class="extra">
        <input v-model.number="extraDays" type="number" min="0" max="90" inputmode="numeric" placeholder="10" aria-label="Days before" @keydown.enter.prevent="addExtra" />
        <span>days before</span>
        <button type="button" class="quiet" @click="addExtra"><Icon name="plus" :size="14" /> Add</button>
      </div>
      <p v-if="!leads.length" class="note">No reminders: deadlines only show in the app.</p>
      <label class="check"><input v-model="form.reminders.email" type="checkbox" /><span>Also by email to the account owner</span></label>
      <label class="check"><input v-model="form.reminders.overdue" type="checkbox" /><span>One more reminder the day after a deadline that is not ticked off</span></label>
      <label>
        <span>Time zone</span>
        <select v-if="zones.length" v-model="form.reminders.timeZone">
          <option v-for="z in zones" :key="z" :value="z">{{ z }}</option>
        </select>
        <input v-else v-model="form.reminders.timeZone" type="text" />
        <small class="hint">Reminders go out from 8:00 in this time zone.</small>
      </label>
    </section>

    <section class="block">
      <h3>Your own deadlines</h3>
      <p class="hint">Anything else to remember: a deadline in another country, a payment plan, the car tax.</p>
      <div v-for="c in form.custom" :key="c.id" class="custom">
        <div class="two">
          <label><span>Name</span><input v-model="c.title" type="text" maxlength="120" placeholder="Belgian VAT return" /></label>
          <label>
            <span>To do</span>
            <select v-model="c.action">
              <option value="file">File</option>
              <option value="pay">Pay</option>
              <option value="file-pay">File and pay</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label><span>{{ c.repeat === 'once' ? 'Due' : 'First due' }}</span><input v-model="c.date" type="date" required /></label>
          <label>
            <span>Repeats</span>
            <select v-model="c.repeat">
              <option value="once">Once</option>
              <option value="monthly">Every month</option>
              <option value="quarterly">Every quarter</option>
              <option value="yearly">Every year</option>
            </select>
          </label>
          <label v-if="c.repeat !== 'once'"><span>Until (optional)</span><input v-model="c.until" type="date" /></label>
          <label><span>Note</span><input v-model="c.note" type="text" maxlength="500" placeholder="Where and how" /></label>
        </div>
        <button type="button" class="quiet danger" @click="removeCustom(c)"><Icon name="trash" :size="14" /> Remove</button>
      </div>
      <button type="button" class="quiet add" :disabled="form.custom.length >= 100" @click="addCustom"><Icon name="plus" :size="14" /> Add a deadline</button>
    </section>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ok" role="status">{{ notice }}</p>
    <div class="actions">
      <button type="button" class="primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save' }}</button>
    </div>
  </div>
  <p v-else-if="error" class="error" role="alert">{{ error }}</p>
  <p v-else class="hint">Loading…</p>
</template>

<style scoped>
.setup { display: flex; flex-direction: column; gap: 1rem; max-width: 46rem; }
.block { display: flex; flex-direction: column; gap: .55rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; }
h3 { margin: 0; font-size: .95rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.note { margin: 0; display: flex; gap: .4rem; align-items: flex-start; font-size: .82rem; color: var(--zfy-warning-ink, #8a5a1e); }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); font-size: .85rem; }
label, .field { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; }
label > span, .field > span { font-weight: 500; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .6rem; }
.check { flex-direction: row; align-items: flex-start; gap: .5rem; }
.check > span { font-weight: 400; }
.check small { color: var(--zfy-muted, #5a6472); }
.check input { margin-top: .15rem; flex: none; }
.indent { margin-left: 1.6rem; align-self: flex-start; }
.start input { width: 7rem; }
.start > span small { font-weight: 400; color: var(--zfy-muted, #5a6472); }
.chips { display: flex; flex-wrap: wrap; gap: .35rem; }
.chip { min-height: 2.1rem; padding: .25rem .75rem; border-radius: 999px; font-size: .82rem; font-weight: 400; display: inline-flex; align-items: center; gap: .3rem; }
.chip.on { background: var(--zfy-accent-soft); border-color: var(--zfy-accent); color: var(--zfy-accent-ink); font-weight: 600; }
.extra { display: flex; align-items: center; gap: .45rem; font-size: .85rem; }
.extra input { width: 5rem; }
.custom { display: flex; flex-direction: column; gap: .4rem; padding: .6rem 0; border-top: 1px solid var(--zfy-line, #d6dde4); }
.custom .danger { align-self: flex-end; }
.add { align-self: flex-start; }
.actions { display: flex; justify-content: flex-end; }
</style>
