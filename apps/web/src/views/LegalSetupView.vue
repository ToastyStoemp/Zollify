<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { isStore, legalChecklist, openLegalSteps, type CountryChecklist, type LegalFacts, type LegalStep } from '@zollify/shared';
import { allClosings, authFetch, currentAccount, getSyncedSetting, readModuleConfig, setSyncedSetting, tseMode, tseState, visibleEvents } from '@zollify/platform';

/**
 * Settings → Legal setup: what the law asks of a till in each country the
 * business sells in, and how far along the account is. Zollify reads what it
 * can (profile, VAT, TSE, modules, connections) and asks the owner to confirm
 * what happens outside it (a filing, a signed agreement). The rules live in
 * @zollify/shared (legal-checklist.ts); this screen gathers the facts.
 */

const router = useRouter();
const ACK_KEY = 'legal.confirmed';
const DOCS = 'https://github.com/ToastyStoemp/Zollify/blob/master/docs/';

const lists = ref<CountryChecklist[] | null>(null);
const confirmed = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const loading = ref(false);
const opened = ref<string | null>(null);

async function quiet<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch {
    return undefined;
  }
}

async function gather(): Promise<LegalFacts> {
  const account = currentAccount.value;
  const profile = account?.profile;
  const artist = profile?.artist;
  const live = visibleEvents.value.filter((e) => e.status !== 'closed');
  const modules = ((await quiet(authFetch('/modules/available'))) as { modules: { moduleId: string; enabled: boolean }[] } | undefined)?.modules.filter((m) => m.enabled).map((m) => m.moduleId) ?? [];
  const [economic, consignors, customMethods] = await Promise.all([
    modules.includes('economic') ? quiet(authFetch('/m/economic/settings') as Promise<{ server: boolean; grant: boolean }>) : undefined,
    modules.includes('consignment') ? quiet(authFetch('/m/consignment/consignors') as Promise<{ consignors: LegalFacts['consignors'] }>) : undefined,
    quiet(readModuleConfig<string[]>('pos', 'customMethods')),
  ]);
  confirmed.value = ((await quiet(getSyncedSetting<Record<string, string>>(ACK_KEY))) as Record<string, string> | undefined) ?? {};
  return {
    homeCountry: artist?.countryOfOrigin ?? '',
    businessName: artist?.companyName || artist?.fullName || account?.accountName || '',
    address: [artist?.street, artist?.postCodeCity].filter(Boolean).join(' '),
    vatId: artist?.vatId ?? '',
    enterpriseNumber: artist?.enterpriseNumber,
    exemptCountries: profile?.vat?.exemptCountries ?? [],
    exNumber: profile?.vat?.exNumber ?? '',
    imprintUrl: profile?.links?.imprintUrl,
    privacyUrl: profile?.links?.privacyUrl,
    eventCountries: live.filter((e) => !isStore(e)).map((e) => e.venue?.country ?? ''),
    storeCountries: live.filter((e) => isStore(e)).map((e) => e.venue?.country ?? ''),
    modules,
    kassensichv: tseState.feature,
    tseMode: tseMode(),
    tseCertified: tseState.info ? tseState.info.certified : tseMode() === 'none' ? null : tseState.error ? false : null,
    tseError: tseState.error,
    closings: allClosings().length,
    economic: economic ? { server: economic.server, grant: economic.grant } : undefined,
    consignors: consignors?.consignors,
    customMethods: customMethods ?? [],
    confirmed: confirmed.value,
  };
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    lists.value = legalChecklist(await gather());
    opened.value ??= lists.value.find((l) => l.summary !== 'All set')?.code ?? lists.value[0]?.code ?? null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);

const open = computed(() => (lists.value ? openLegalSteps(lists.value) : 0));
const today = (): string => new Date().toISOString().slice(0, 10);

async function confirm(step: LegalStep, on: boolean): Promise<void> {
  const next = { ...confirmed.value };
  if (on) next[step.id] = today();
  else delete next[step.id];
  try {
    await setSyncedSetting(ACK_KEY, next);
    confirmed.value = next;
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function go(step: LegalStep): void {
  if (step.panel) void router.push({ name: 'settings', query: { panel: step.panel } });
  else if (step.path) void router.push(step.path);
}

const badge = (s: LegalStep): { cls: string; text: string } => {
  if (s.status === 'done') return { cls: 'done', text: 'Done' };
  if (s.status === 'todo') return { cls: 'todo', text: 'To do' };
  if (s.status === 'blocked') return { cls: 'blocked', text: 'Not possible' };
  if (s.status === 'manual') return s.confirmedOn ? { cls: 'done', text: `Confirmed ${s.confirmedOn}` } : { cls: 'manual', text: 'You confirm' };
  return { cls: 'info', text: 'How it works' };
};
const reasonText = (l: CountryChecklist): string => (l.reason === 'home' ? 'your business is here' : l.reason === 'stores' ? 'you have a store here' : 'you sell at events here');
</script>

<template>
  <section class="legal">
    <h2>Legal setup</h2>
    <p class="hint">
      What the law asks of a till in each country you sell in - worked out from your business profile, your events and stores
      and what is already set up. Zollify ticks off what it can see; you confirm what happens outside it. Not legal advice:
      the notes under <a :href="DOCS" target="_blank" rel="noopener">docs/</a> give the sources, and your accountant has the last word.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="loading && !lists" class="hint">Checking…</p>

    <template v-if="lists">
      <p v-if="!lists.length" class="hint">Set your business country under Business profile, or add an event, and the checklist for it appears here.</p>
      <p v-else class="overall" :class="{ ok: open === 0 }">
        {{ open === 0 ? 'Everything Zollify can check is in place.' : `${open} step${open === 1 ? '' : 's'} still open.` }}
        <button type="button" class="quiet" :disabled="loading" @click="refresh">Re-check</button>
      </p>

      <details v-for="l in lists" :key="l.code" class="country" :open="opened === l.code" @toggle="($event.target as HTMLDetailsElement).open && (opened = l.code)">
        <summary>
          <strong>{{ l.name }}</strong>
          <span class="why">{{ reasonText(l) }}</span>
          <span class="sum" :class="{ ok: l.summary === 'All set', blocked: l.summary.includes('cannot') }">{{ l.summary }}</span>
        </summary>
        <ol class="steps">
          <li v-for="s in l.steps" :key="s.id" :class="s.status">
            <div class="head">
              <span class="badge" :class="badge(s).cls">{{ badge(s).text }}</span>
              <strong>{{ s.title }}</strong>
            </div>
            <p>{{ s.text }}</p>
            <p v-if="s.law" class="law">{{ s.law }}</p>
            <div class="actions">
              <button v-if="s.panel || s.path" type="button" @click="go(s)">Open</button>
              <a v-if="s.doc" :href="DOCS + s.doc" target="_blank" rel="noopener" class="btn">Read the notes</a>
              <label v-if="s.status === 'manual'" class="check">
                <input type="checkbox" :checked="!!s.confirmedOn" @change="confirm(s, ($event.target as HTMLInputElement).checked)" />
                <span>{{ s.confirmedOn ? 'Done' : 'Mark as done' }}</span>
              </label>
            </div>
          </li>
        </ol>
      </details>
    </template>
  </section>
</template>

<style scoped>
.legal { display: flex; flex-direction: column; gap: .75rem; max-width: 44rem; }
h2 { margin: 0; font-size: 1.1rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .875rem; }
.hint a { color: inherit; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .875rem; }
.overall { margin: 0; display: flex; align-items: center; gap: .75rem; font-weight: 600; color: var(--zfy-warning-ink, #8a5a1e); }
.overall.ok { color: var(--zfy-accent-ink, #0a5a4a); }
.country { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.country summary { display: flex; align-items: center; gap: .6rem; padding: .75rem 1rem; cursor: pointer; flex-wrap: wrap; }
.country summary strong { font-size: 1rem; }
.why { color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.sum { margin-left: auto; font-size: .8rem; font-weight: 600; color: var(--zfy-warning-ink, #8a5a1e); }
.sum.ok { color: var(--zfy-accent-ink, #0a5a4a); }
.sum.blocked { color: var(--zfy-danger, #c6512f); }
.steps { list-style: none; margin: 0; padding: 0 1rem 1rem; display: flex; flex-direction: column; gap: .75rem; }
.steps li { border-top: 1px solid var(--zfy-line, #d6dde4); padding-top: .75rem; display: flex; flex-direction: column; gap: .3rem; }
.steps li.info { opacity: .85; }
.head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.steps p { margin: 0; font-size: .875rem; }
.law { color: var(--zfy-muted, #5a6472); font-size: .75rem; }
.badge { font-size: .7rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: .1rem .5rem; border-radius: 999px; background: var(--zfy-line, #d6dde4); }
.badge.done { background: var(--zfy-accent-soft, #d9f2ea); color: var(--zfy-accent-ink, #0a5a4a); }
.badge.todo { background: var(--zfy-warning-soft, #fbe8c9); color: var(--zfy-warning-ink, #8a5a1e); }
.badge.manual { background: var(--zfy-warning-soft, #fbe8c9); color: var(--zfy-warning-ink, #8a5a1e); }
.badge.blocked { background: var(--zfy-danger-soft, #f8dcd3); color: var(--zfy-danger, #c6512f); }
.actions { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.btn { font-size: .875rem; }
.check { display: flex; align-items: center; gap: .4rem; font-size: .875rem; }
</style>
