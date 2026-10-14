<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  DEFAULT_BOOKS_SETTINGS,
  VAT_RATES,
  booksFrom,
  countryCodeOf,
  fmtRate,
  guessFromDevice,
  resolveEventVat,
  storeSetupDefaults,
  storeSetupProblem,
  storeSetupSteps,
  storeVat,
  type BooksSettings,
  type SalesEvent,
  type StoreSetupStep,
} from '@zollify/shared';
import { CountryPicker, CurrencyPicker, ModalShell } from '@zollify/ui';
import { activeEventId, authFetch, currentAccount, setActiveEvent, upsertSalesEvent } from '@zollify/platform';
import { loadEnabledModules } from '../boot';

/**
 * Store setup: the few questions that decide how a store behaves - where it
 * is, what VAT it charges, whether it sells other people's work and on what
 * terms, and when it settles with them. It makes the store, then the
 * account's consignment books; both can be changed later where they live.
 *
 * Used when an account is first set up and whenever a store is added. The
 * books belong to the account, not to one store, so a second store starts
 * from what the first one chose.
 */
const props = withDefaults(defineProps<{ onboarding?: boolean }>(), { onboarding: false });
const emit = defineEmits<{ close: []; created: [storeId: string] }>();

const router = useRouter();
const account = currentAccount;
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const zones: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [deviceZone];
  } catch {
    return [deviceZone];
  }
})();

const form = reactive(
  storeSetupDefaults(DEFAULT_BOOKS_SETTINGS, {
    country: account.value?.profile.artist.countryOfOrigin || guessFromDevice()?.name || '',
    currency: account.value?.profile.defaultCurrency ?? '',
    timeZone: deviceZone,
  }),
);
/** The books as they stand; the answers change only what they cover. */
const current = ref<BooksSettings>(DEFAULT_BOOKS_SETTINGS);
const consignmentAvailable = ref(false);
const consignmentOn = ref(false);

onMounted(async () => {
  try {
    const res = (await authFetch('/modules/available')) as { modules: { moduleId: string; enabled: boolean }[] };
    const mod = res.modules.find((m) => m.moduleId === 'consignment');
    consignmentAvailable.value = Boolean(mod);
    consignmentOn.value = Boolean(mod?.enabled);
    if (mod?.enabled) {
      current.value = ((await authFetch('/m/consignment/books/settings')) as { settings: BooksSettings }).settings;
      // A second store starts from what the first one chose.
      const { defaultCommissionPct, artistDiscounts, artistDiscountMaxPct, reportPeriod, emailReport, timeZone, passCardFees, cardFeePct, cardFeeFixed } = storeSetupDefaults(current.value, { timeZone: deviceZone });
      Object.assign(form, { defaultCommissionPct, artistDiscounts, artistDiscountMaxPct, reportPeriod, emailReport, timeZone, passCardFees, cardFeePct, cardFeeFixed });
    }
  } catch {
    /* without the module list the artist questions are simply left out */
  }
});

const steps = computed<StoreSetupStep[]>(() => storeSetupSteps(form));
const at = ref<StoreSetupStep>('store');
const index = computed(() => steps.value.indexOf(at.value));
const TITLES: Record<StoreSetupStep, string> = { store: 'Your store', vat: 'VAT', artists: 'Artists', money: 'Reports & card costs', review: 'Review' };

const busy = ref(false);
const error = ref<string | null>(null);
const warnings = ref<string[]>([]);
const createdId = ref<string | null>(null);

function next(): void {
  error.value = storeSetupProblem(at.value, form);
  if (!error.value) at.value = steps.value[index.value + 1]!;
}
function back(): void {
  error.value = null;
  at.value = steps.value[index.value - 1]!;
}

// ── VAT ─────────────────────────────────────────────────────────────────────
const rates = computed(() => VAT_RATES[countryCodeOf(form.country)]);
const vatPreview = computed(() => {
  const r = resolveEventVat({ venue: { country: form.country }, vat: storeVat(form) }, account.value?.profile);
  if (r.exempt) return `Exempt - receipts say “${r.note}”.`;
  if (r.standard == null) return 'No VAT rates known for this country - enter them, or sales are recorded without VAT.';
  return `Charging ${fmtRate(r.standard)}${r.reduced != null && r.reduced !== r.standard ? `, ${fmtRate(r.reduced)} on reduced products` : ''}. Prices at the till include VAT.`;
});

// ── Create ──────────────────────────────────────────────────────────────────
const summary = computed(() => {
  const rows: [string, string][] = [
    ['Store', [form.name.trim(), form.city.trim(), form.country].filter(Boolean).join(', ')],
    ['Sells in', form.currency.trim().toUpperCase()],
    ['VAT', vatPreview.value],
  ];
  if (form.consignment) {
    rows.push(['Artists', `New artists start at ${form.defaultCommissionPct}% commission${form.artistDiscounts ? `; they may discount up to ${form.artistDiscountMaxPct}%` : '; they cannot discount their own work'}.`]);
    rows.push(['Reports', `${form.reportPeriod === 'monthly' ? 'Monthly' : 'Every two weeks'}${form.emailReport ? ', emailed to you' : ''}; days end by ${form.timeZone}.`]);
    rows.push(['Card costs', form.passCardFees ? `Artists carry their share (${form.cardFeePct || 0}% + ${form.cardFeeFixed || 0} per payment).` : 'The store carries them.']);
  }
  return rows;
});

async function enableConsignment(): Promise<void> {
  await authFetch('/modules/toggle', { method: 'POST', body: JSON.stringify({ moduleId: 'consignment', enabled: true }) });
  await loadEnabledModules(router);
  consignmentOn.value = true;
}

async function create(): Promise<void> {
  error.value = null;
  for (const s of steps.value) {
    const problem = storeSetupProblem(s, form);
    if (problem) {
      at.value = s;
      error.value = problem;
      return;
    }
  }
  busy.value = true;
  try {
    const store: SalesEvent = {
      id: crypto.randomUUID(),
      name: form.name.trim(),
      kind: 'store',
      venue: {
        street: form.street.trim() || undefined,
        postcode: form.postcode.trim() || undefined,
        city: form.city.trim() || undefined,
        country: form.country.trim() || undefined,
      },
      currency: form.currency.trim().toUpperCase(),
      roundingIncrement: 0,
      vat: storeVat(form),
      // A store has no dates to wait for, so it opens as soon as it exists.
      status: 'active',
      updatedAt: Date.now(),
    };
    await upsertSalesEvent(store);
    if (!activeEventId.value) await setActiveEvent(store.id);
    createdId.value = store.id;
    emit('created', store.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create the store.';
    busy.value = false;
    return;
  }
  // The store exists; a failure below leaves it standing and says what to finish by hand.
  if (form.consignment) {
    try {
      if (!consignmentOn.value) await enableConsignment();
      await authFetch('/m/consignment/books/settings', { method: 'PUT', body: JSON.stringify(booksFrom(form, current.value)) });
    } catch (err) {
      warnings.value.push(`The artist settings were not saved (${err instanceof Error ? err.message : 'unknown error'}). Set them under Stores → Reports → Settings.`);
    }
  }
  busy.value = false;
}

function go(to: { name: string; query?: Record<string, string> }): void {
  emit('close');
  void router.push(to);
}
const nextSteps = computed(() => {
  const list: { title: string; text: string; to: { name: string; query?: Record<string, string> } }[] = [];
  if (form.consignment) {
    list.push({ title: 'Add your artists', text: 'Name, commission and the store they sell in.', to: { name: 'consignment:index' } });
    list.push({ title: 'Plan shelves and rent', text: 'Spaces, who rents what and for how long.', to: { name: 'consignment:planner' } });
  }
  list.push({ title: 'Connect a card terminal', text: 'Payments settings.', to: { name: 'settings', query: { panel: 'pos.payments' } } });
  list.push({ title: 'Business details and receipts', text: 'Name, VAT number and what the receipt says.', to: { name: 'settings', query: { panel: 'core.profile' } } });
  return list;
});
</script>

<template>
  <ModalShell :title="createdId ? 'Store ready' : `Set up a store - ${TITLES[at]}`" @close="emit('close')">
    <div v-if="!createdId" class="wizard">
      <ol class="progress" aria-label="Setup progress">
        <li v-for="(s, i) in steps" :key="s" :class="{ current: s === at, done: i < index }">{{ TITLES[s] }}</li>
      </ol>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div v-if="at === 'store'" class="body">
        <label><span>Store name</span><input v-model="form.name" type="text" placeholder="Atelier Zurich" autofocus /></label>
        <div class="two">
          <label><span>Street</span><input v-model="form.street" type="text" /></label>
          <label><span>City</span><input v-model="form.city" type="text" /></label>
          <label><span>Postcode</span><input v-model="form.postcode" type="text" /></label>
          <label><span>Country</span><CountryPicker v-model="form.country" store="name" /></label>
        </div>
        <label><span>Sells in</span><CurrencyPicker v-model="form.currency" /></label>
        <p class="hint">The country decides the VAT. A store is open until you close it - no dates.</p>
        <fieldset v-if="consignmentAvailable" class="choice">
          <legend>Whose work do you sell?</legend>
          <label class="radio"><input v-model="form.consignment" type="radio" :value="false" /> <span><strong>Only my own</strong> - no artists to settle with</span></label>
          <label class="radio"><input v-model="form.consignment" type="radio" :value="true" /> <span><strong>Other artists' or renters' work</strong> - commission, rent and payouts</span></label>
        </fieldset>
      </div>

      <div v-else-if="at === 'vat'" class="body">
        <label>
          <span>VAT in this store</span>
          <select v-model="form.vatMode">
            <option value="auto">Automatic - from the country</option>
            <option value="charge">Charge VAT</option>
            <option value="exempt">Exempt (small business)</option>
          </select>
        </label>
        <div v-if="form.vatMode !== 'exempt'" class="two">
          <label>
            <span>Standard rate %</span>
            <input v-model="form.vatStandard" type="number" min="0" max="99" step="0.1" inputmode="decimal" :placeholder="rates ? String(rates.standard) : '-'" />
          </label>
          <label>
            <span>Reduced rate %</span>
            <input v-model="form.vatReduced" type="number" min="0" max="99" step="0.1" inputmode="decimal" :placeholder="rates ? String(rates.reduced[0] ?? rates.standard) : '-'" />
          </label>
        </div>
        <p class="hint">{{ vatPreview }} Leave the rates blank to use the country's.</p>
      </div>

      <div v-else-if="at === 'artists'" class="body">
        <p class="hint">These apply to all your stores.</p>
        <label>
          <span>Commission a new artist starts with (%)</span>
          <input v-model="form.defaultCommissionPct" type="number" min="0" max="100" inputmode="decimal" />
          <small class="hint">The store's share of each sale. You can change it for each artist, and per store.</small>
        </label>
        <label class="check"><input v-model="form.artistDiscounts" type="checkbox" /> Linked artists may put their own work on discount</label>
        <label v-if="form.artistDiscounts">
          <span>At most (% off)</span>
          <input v-model="form.artistDiscountMaxPct" type="number" min="1" max="100" inputmode="decimal" />
        </label>
      </div>

      <div v-else-if="at === 'money'" class="body">
        <p class="hint">These apply to all your stores.</p>
        <div class="choice">
          <label class="radio"><input v-model="form.reportPeriod" type="radio" value="monthly" /> <span><strong>Monthly</strong> report and payout</span></label>
          <label class="radio"><input v-model="form.reportPeriod" type="radio" value="biweekly" /> <span><strong>Every two weeks</strong></span></label>
        </div>
        <label class="check"><input v-model="form.emailReport" type="checkbox" /> Email me the report when a period closes</label>
        <label>
          <span>Time zone</span>
          <input v-model="form.timeZone" type="text" list="zfy-wizard-zones" />
          <small class="hint">Decides which day a late sale counts on.</small>
          <datalist id="zfy-wizard-zones"><option v-for="z in zones" :key="z" :value="z" /></datalist>
        </label>
        <label class="check"><input v-model="form.passCardFees" type="checkbox" /> Artists carry their share of the card costs on their own sales</label>
        <div v-if="form.passCardFees" class="two">
          <label><span>Percent per card payment</span><input v-model="form.cardFeePct" type="number" min="0" max="20" step="0.01" inputmode="decimal" placeholder="1.5" /></label>
          <label><span>Plus per payment ({{ form.currency.toUpperCase() }})</span><input v-model="form.cardFeeFixed" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.20" /></label>
        </div>
      </div>

      <dl v-else class="review">
        <template v-for="[label, text] in summary" :key="label"><dt>{{ label }}</dt><dd>{{ text }}</dd></template>
        <dt>Later</dt>
        <dd>Everything here can be changed afterwards: the store under Stores, VAT and artists under Stores → Reports → Settings.</dd>
      </dl>
    </div>

    <div v-else class="wizard">
      <p class="done">{{ form.name.trim() }} is open.</p>
      <p v-for="w in warnings" :key="w" class="error" role="alert">{{ w }}</p>
      <ol v-if="!props.onboarding" class="next">
        <li v-for="n in nextSteps" :key="n.title">
          <strong>{{ n.title }}</strong>
          <span>{{ n.text }}</span>
          <button type="button" @click="go(n.to)">Open</button>
        </li>
      </ol>
      <p v-else class="hint">Artists, shelves and payments are waiting under Stores once setup is done.</p>
    </div>

    <template #footer>
      <div class="footer">
        <template v-if="!createdId">
          <button type="button" class="quiet" :disabled="busy" @click="index === 0 ? emit('close') : back()">{{ index === 0 ? 'Cancel' : 'Back' }}</button>
          <button v-if="at !== 'review'" type="button" class="primary" @click="next">Next</button>
          <button v-else type="button" class="primary" :disabled="busy" @click="create">{{ busy ? 'Creating…' : 'Create store' }}</button>
        </template>
        <button v-else type="button" class="primary" @click="emit('close')">{{ props.onboarding ? 'Continue' : 'Done' }}</button>
      </div>
    </template>
  </ModalShell>
</template>

<style scoped>
.wizard { display: flex; flex-direction: column; gap: .9rem; }
.progress { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem .9rem; counter-reset: s; }
.progress li { font-size: .8rem; color: var(--zfy-faint); display: flex; align-items: center; gap: .35rem; }
.progress li::before { counter-increment: s; content: counter(s); display: grid; place-items: center; width: 1.3rem; height: 1.3rem; border-radius: 999px; border: 1px solid var(--zfy-line); font-size: .72rem; }
.progress li.current { color: var(--zfy-ink); font-weight: 600; }
.progress li.current::before { background: var(--zfy-accent); border-color: var(--zfy-accent); color: var(--zfy-on-accent); }
.progress li.done { color: var(--zfy-muted); }
.progress li.done::before { content: '✓'; background: var(--zfy-accent-soft); border-color: var(--zfy-accent-soft); color: var(--zfy-accent-ink); }
.body { display: flex; flex-direction: column; gap: .8rem; }
label { display: flex; flex-direction: column; gap: .2rem; font-size: .85rem; }
label.check, label.radio { flex-direction: row; align-items: flex-start; gap: .5rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.choice { display: flex; flex-direction: column; gap: .5rem; border: 0; padding: 0; margin: 0; }
.choice legend { font-size: .85rem; margin-bottom: .3rem; }
.hint, small { margin: 0; color: var(--zfy-muted); font-size: .82rem; }
.error { margin: 0; color: var(--zfy-danger); font-size: .875rem; }
.review { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; margin: 0; font-size: .875rem; }
.review dt { color: var(--zfy-muted); }
.review dd { margin: 0; }
.done { margin: 0; font-weight: 600; color: var(--zfy-accent-ink); }
.next { margin: 0; padding: 0 0 0 1.3rem; display: flex; flex-direction: column; gap: .8rem; }
.next li { display: grid; grid-template-columns: 1fr auto; gap: .1rem .75rem; align-items: center; }
.next span { grid-column: 1; font-size: .85rem; color: var(--zfy-muted); }
.next button { grid-column: 2; grid-row: 1 / span 2; }
.footer { display: flex; justify-content: space-between; gap: .5rem; width: 100%; }
@media (max-width: 520px) { .two { grid-template-columns: 1fr; } .review { grid-template-columns: 1fr; } }
</style>
