<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ACTION_LABELS, daysBetween, dueIn, leadLabel, localIsoDay, normalizeLeadDays, type TaxDeadline } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { doneSet, loadState, offline, setDone, state } from '../api';
import { groupDeadlines } from '../list';

/**
 * Every filing and payment deadline ahead, worked out from the tax setup.
 * Ticking one off as filed stops its reminders; missed ones stay on top until
 * they are. The setup itself lives in one place, Settings → Tax deadlines,
 * and this page only links there.
 */
const SETUP = { name: 'settings', query: { panel: 'tax-deadlines.setup' } };
const error = ref('');
const busy = ref<string | null>(null);
const showDone = ref(false);
const open = ref<string | null>(null);
const today = localIsoDay();

// The SME scheme report's figures come from the SME scheme module, when it is on. Linked by
// route name, as modules never import one another; "Q3 2026" opens that quarter there.
const router = useRouter();
const SME_REPORT = 'sme-scheme:index';
function smeReportLink(d: TaxDeadline): { name: string; query: Record<string, string> } | null {
  if (d.ruleId !== 'eu.sme-report' || !router.hasRoute(SME_REPORT)) return null;
  const m = /^Q([1-4]) (\d{4})$/.exec(d.period ?? '');
  return { name: SME_REPORT, query: m ? { year: m[2]!, quarter: m[1]! } : {} };
}

onMounted(async () => {
  try {
    await loadState(true);
  } catch {
    error.value = 'Could not load your deadlines.';
  }
});

const settings = computed(() => state.value?.settings ?? null);
const groups = computed(() => (settings.value?.configured ? groupDeadlines(settings.value, doneSet(state.value), today) : null));
const reminderLine = computed(() => {
  const r = settings.value?.reminders;
  if (!r) return '';
  const leads = normalizeLeadDays(r.leadDays);
  if (!leads.length) return 'No reminders set.';
  return `Reminders ${leads.map((d) => leadLabel(d).toLowerCase()).join(', ')}${r.email ? ', in the app and by email' : ', in the app'}.`;
});

const fmtDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });

async function tick(d: TaxDeadline, done: boolean): Promise<void> {
  busy.value = d.id;
  error.value = '';
  try {
    await setDone(d.id, done);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that.';
  } finally {
    busy.value = null;
  }
}

const sections = computed(() =>
  groups.value
    ? [
        { key: 'overdue', title: 'Missed', items: groups.value.overdue },
        { key: 'soon', title: 'Next 30 days', items: groups.value.soon },
        { key: 'later', title: 'Later', items: groups.value.later },
      ].filter((s) => s.items.length)
    : [],
);
</script>

<template>
  <section class="deadlines">
    <header>
      <div>
        <h1>Tax deadlines</h1>
        <p class="hint">When to file and pay, worked out from your tax setup. {{ settings?.configured ? reminderLine : '' }}</p>
      </div>
      <router-link v-if="settings?.configured" :to="SETUP" class="secondary setup"><Icon name="settings" :size="14" /> Change setup</router-link>
    </header>

    <p v-if="offline" class="note"><Icon name="alert-triangle" :size="14" /> Offline: showing what this device last saw. Ticking off needs a connection.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <article v-if="settings && !settings.configured" class="card">
      <p class="intro">Tell Zollify how your business is set up for tax, and pick how early you want to be reminded. It takes a minute and you can change it any time.</p>
      <router-link :to="SETUP" class="primary setup">Set up tax deadlines</router-link>
    </article>

    <template v-else-if="groups">
      <p v-if="!sections.length" class="hint">Nothing open in the next year. Your own deadlines can be added under <router-link :to="SETUP">Change setup</router-link>.</p>
      <article v-for="s in sections" :key="s.key" :class="['card', s.key]">
        <h2>{{ s.title }}</h2>
        <ul class="list">
          <li v-for="d in s.items" :key="d.id">
            <label class="tick" :title="`Tick off ${d.title} as filed`">
              <input type="checkbox" :disabled="busy === d.id || offline" :aria-label="`Mark ${d.title} filed`" @change="tick(d, true)" />
              <span>Filed</span>
            </label>
            <button type="button" class="row" :aria-expanded="open === d.id" @click="open = open === d.id ? null : d.id">
              <span class="when">
                <strong>{{ fmtDay(d.due) }}</strong>
                <small :class="{ bad: d.due < today, warn: d.due >= today && daysBetween(today, d.due) <= 3 }">{{ dueIn(d.due, today) }}</small>
              </span>
              <span class="what">
                <span class="title">{{ d.title }}</span>
                <small>{{ ACTION_LABELS[d.action] }}<template v-if="d.where"> · {{ d.where }}</template><template v-if="d.custom"> · your own</template></small>
              </span>
              <Icon :name="open === d.id ? 'chevron-up' : 'chevron-down'" :size="14" />
            </button>
            <div v-if="open === d.id" class="detail">
              <p v-if="d.detail">{{ d.detail }}</p>
              <router-link v-if="smeReportLink(d)" :to="smeReportLink(d)!" class="figures">Open the figures for {{ d.period }}</router-link>
              <p v-if="d.statutory !== d.due" class="hint">The law says {{ fmtDay(d.statutory) }}; that is not a working day, so it moves to {{ fmtDay(d.due) }}.</p>
            </div>
          </li>
        </ul>
      </article>

      <article v-if="groups.done.length" class="card">
        <button type="button" class="quiet toggle" @click="showDone = !showDone">
          Show done ({{ groups.done.length }}) <Icon :name="showDone ? 'chevron-up' : 'chevron-down'" :size="14" />
        </button>
        <ul v-if="showDone" class="list done">
          <li v-for="d in groups.done" :key="d.id">
            <label class="tick" :title="`Untick ${d.title}: not filed after all`">
              <input type="checkbox" checked :disabled="busy === d.id || offline" :aria-label="`Mark ${d.title} not filed`" @change="tick(d, false)" />
              <span>Filed</span>
            </label>
            <span class="row static">
              <span class="when"><strong>{{ fmtDay(d.due) }}</strong></span>
              <span class="what"><span class="title">{{ d.title }}</span></span>
            </span>
          </li>
        </ul>
      </article>

      <p class="hint small">Worked out from the rules in law, not tax advice. Your tax office or advisor has the final word on your dates.</p>
    </template>
    <p v-else-if="!error" class="hint">Loading…</p>
  </section>
</template>

<style scoped>
.deadlines { display: flex; flex-direction: column; gap: 1rem; max-width: 46rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: .95rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.hint.small { font-size: .75rem; }
.intro { margin: 0; font-size: .9rem; }
.setup { display: inline-flex; align-items: center; gap: .35rem; align-self: flex-start; text-decoration: none; border-radius: 8px; padding: .5rem .9rem; font-weight: 600; font-size: .875rem; min-height: 2.5rem; }
.setup.secondary { border: 1px solid var(--zfy-line, #d6dde4); color: inherit; }
.setup.secondary:hover { border-color: var(--zfy-accent, #0e7c66); }
.setup.primary { background: var(--zfy-accent, #0e7c66); color: var(--zfy-on-accent, #fff); }
.setup.primary:hover { background: var(--zfy-accent-ink, #0a5a4a); }
.tick { display: inline-flex; flex-direction: column; align-items: center; gap: .1rem; font-size: .68rem; color: var(--zfy-muted, #5a6472); cursor: pointer; min-width: 2.4rem; }
.tick input { margin: 0; }
.done .tick { color: var(--zfy-accent-ink, #0a5a4a); }
.note { margin: 0; display: flex; gap: .4rem; align-items: center; font-size: .82rem; color: var(--zfy-warning-ink, #8a5a1e); }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .8rem 1rem; display: flex; flex-direction: column; gap: .5rem; }
.card.overdue { border-color: var(--zfy-danger, #c6512f); }
.card.overdue h2 { color: var(--zfy-danger, #c6512f); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.list li { display: grid; grid-template-columns: auto 1fr; align-items: center; column-gap: .6rem; padding: .35rem 0; border-top: 1px solid var(--zfy-line, #d6dde4); }
.list li:first-child { border-top: 0; }
.row { display: flex; align-items: center; gap: .8rem; text-align: left; padding: .3rem .2rem; border: 0; background: none; font-weight: 400; min-width: 0; }
.row.static { padding: .3rem .2rem; }
.when { display: flex; flex-direction: column; width: 6.5rem; flex: none; }
.when strong { font-size: .85rem; font-variant-numeric: tabular-nums; }
.when small { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.when small.bad { color: var(--zfy-danger, #c6512f); font-weight: 600; }
.when small.warn { color: var(--zfy-warning-ink, #8a5a1e); font-weight: 600; }
.what { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.what .title { font-size: .9rem; }
.what small { font-size: .75rem; color: var(--zfy-muted, #5a6472); }
.detail { grid-column: 2; display: flex; flex-direction: column; gap: .3rem; padding: 0 .2rem .4rem; font-size: .82rem; }
.detail p { margin: 0; }
.figures { font-weight: 600; color: var(--zfy-accent-ink); }
.done .title { color: var(--zfy-muted, #5a6472); text-decoration: line-through; }
.toggle { align-self: flex-start; display: inline-flex; align-items: center; gap: .3rem; padding-left: 0; font-weight: 600; }
@media (max-width: 560px) {
  .when { width: 5.2rem; }
}
</style>
