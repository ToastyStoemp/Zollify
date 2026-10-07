<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { editionLabelOf, fmtPrice, type EditionStat } from '@zollify/shared';
import {
  applyPrepPlan,
  currentAccount,
  editionsOf,
  getSalesEvent,
  grantsFor,
  prepPlanFor,
  shellConfirm,
} from '@zollify/platform';

/**
 * Prep planner: before an event, what the earlier editions of the same
 * convention sold, against what they claimed, and a suggested claim. The rule
 * is plain on purpose - the average (or best) of the earlier editions plus a
 * buffer - and an item that sold out is flagged, because what it sold is then
 * only a floor for what it could have sold.
 */
const route = useRoute();
const eventId = computed(() => String(route.params.eventId ?? ''));
const event = computed(() => getSalesEvent(eventId.value));
const canEdit = computed(() => currentAccount.value?.role === 'owner' || currentAccount.value?.role === 'admin');

const bufferPct = ref(10);
const basis = ref<'average' | 'max'>('average');
const error = ref<string | null>(null);
const done = ref<string | null>(null);

const earlier = computed(() => editionsOf(eventId.value).filter((e) => e.id !== eventId.value));
const rows = computed(() => prepPlanFor(eventId.value, { bufferPct: Number(bufferPct.value) || 0, basis: basis.value }));
const grants = computed(() => new Map(grantsFor(rows.value).map((g) => [g.key, g])));
const shortTotal = computed(() => [...grants.value.values()].filter((g) => g.short > 0).length);
/** The editions that actually have sales, as columns. */
const columns = computed(() => {
  const seen = new Map<string, string>();
  for (const r of rows.value) for (const s of r.editions) if (!seen.has(s.eventId)) seen.set(s.eventId, s.label);
  return [...seen].map(([id, label]) => ({ id, label }));
});
const statFor = (editions: EditionStat[], id: string): EditionStat | undefined => editions.find((s) => s.eventId === id);

const money = (n: number): string => fmtPrice(n, event.value?.currency ?? 'CHF');
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const when = (at: number): string => new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

async function apply(): Promise<void> {
  error.value = null;
  done.value = null;
  const ok = await shellConfirm(
    `This sets ${event.value?.name ?? 'the event'}'s claim on ${rows.value.length} item${rows.value.length === 1 ? '' : 's'} to the suggestion, or what is free if that is less. Existing claims on those items are replaced.`,
    'Apply suggested claims?',
  );
  if (!ok) return;
  try {
    const applied = await applyPrepPlan(eventId.value, rows.value);
    const short = applied.filter((g) => g.short > 0).length;
    done.value = `Claimed ${applied.length} item${applied.length === 1 ? '' : 's'}${short ? `, ${short} short of the suggestion` : ''}.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Something went wrong.';
  }
}
</script>

<template>
  <section class="planner">
    <header>
      <h1>Prep planner</h1>
      <router-link :to="{ name: 'events' }" class="btn">Back to events</router-link>
    </header>

    <p v-if="!event" class="empty">That event no longer exists.</p>
    <template v-else>
      <p class="sub"><strong>{{ event.name }}</strong><template v-if="editionLabelOf(event)"> · {{ editionLabelOf(event) }}</template></p>

      <p v-if="!event.seriesId" class="empty">This event is not part of a series yet. Link it to an earlier edition from Events, in the More menu under Editions.</p>
      <p v-else-if="!earlier.length" class="empty">No other editions in this series yet.</p>
      <p v-else-if="!rows.length" class="empty">The earlier editions have no recorded sales to plan from.</p>

      <template v-else>
        <div class="controls">
          <label><span>Based on</span>
            <select v-model="basis"><option value="average">Average of editions</option><option value="max">Best edition</option></select>
          </label>
          <label><span>Buffer %</span><input v-model.number="bufferPct" type="number" min="0" max="500" step="5" inputmode="numeric" /></label>
          <button v-if="canEdit" type="button" class="primary" @click="apply">Apply suggested claims</button>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-if="done" class="ok" role="status">{{ done }}</p>
        <p v-if="shortTotal" class="warn">{{ shortTotal }} item{{ shortTotal === 1 ? '' : 's' }} cannot be fully claimed: not enough free stock after other events' claims. Applying claims what is free.</p>

        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th v-for="c in columns" :key="c.id">{{ c.label }}</th>
                <th class="num">Suggested</th>
                <th class="num">Claimed now</th>
                <th class="num">Free</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.key">
                <td>
                  {{ r.label }}
                  <span v-if="r.underClaimed" class="flag">probably under-claimed</span>
                </td>
                <td v-for="c in columns" :key="c.id" class="cell">
                  <template v-for="s in [statFor(r.editions, c.id)]" :key="c.id">
                    <template v-if="s">
                    <strong>{{ s.units }}</strong> sold · {{ money(s.revenue) }}
                    <div v-if="s.claimed !== null" class="meta">
                      of {{ s.claimed }} claimed · {{ pct(s.sellThrough ?? 0) }}
                      <span v-if="s.soldOut && s.soldOutAt" class="out">sold out {{ when(s.soldOutAt) }}</span>
                    </div>
                    <div v-else class="meta">no claim</div>
                    </template>
                    <span v-else class="meta">-</span>
                  </template>
                </td>
                <td class="num">
                  <strong>{{ r.suggested }}</strong>
                  <div v-if="grants.get(r.key)?.short" class="short">short {{ grants.get(r.key)!.short }}</div>
                </td>
                <td class="num">{{ r.current ?? '-' }}</td>
                <td class="num">{{ r.claimable }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hint">Suggested = {{ basis === 'max' ? 'the best' : 'the average' }} units sold across the earlier editions, plus {{ Number(bufferPct) || 0 }}%, rounded up. An item that sold out only shows a floor for demand.</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.planner { display: flex; flex-direction: column; gap: 1rem; max-width: 72rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
h1 { margin: 0; font-size: 1.35rem; }
.sub { margin: 0; }
.btn { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; padding: .4rem .8rem; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); text-decoration: none; font-size: .85rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); font-size: .85rem; margin: 0; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .75rem; }
.controls label { display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; }
.controls input { width: 6rem; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); vertical-align: top; }
th { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.cell { font-variant-numeric: tabular-nums; }
.meta { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.flag { display: inline-block; margin-left: .4rem; font-size: .68rem; font-weight: 600; border-radius: 999px; padding: .1rem .5rem; background: var(--zfy-warning-soft, #f6e9d6); color: var(--zfy-warning-ink, #8a5a1e); }
.out { color: var(--zfy-warning-ink, #8a5a1e); font-weight: 600; }
.short { color: var(--zfy-danger, #c6512f); font-size: .76rem; }
</style>
