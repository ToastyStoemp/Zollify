<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { fmtPrice, round2, toLocalPrice } from '@zollify/shared';
import { Icon, typeColor } from '@zollify/ui';
import { activeEvent, allDiscounts, allProducts, getSalesEvent, stockKey, upsertSalesEvent } from '@zollify/platform';

/**
 * Local prices for an event abroad - ZollTool's Price compare. Every
 * catalogue price is shown converted, auto-rounded, and back-converted so
 * a price that rounded away too much value stands out; an override pins a
 * specific local price, and the till charges exactly that.
 */

const route = useRoute();
const event = computed(() => getSalesEvent(String(route.params.eventId ?? '')) ?? activeEvent.value ?? null);
const hasLocal = computed(() => !!event.value?.localCurrency && (event.value?.exchangeRate ?? 0) > 0);
const error = ref<string | null>(null);

interface Row {
  key: string;
  /** Every stock key an override on this row applies to - more than one for a collapsed same-price group. */
  memberKeys: string[];
  pid: string;
  type: string;
  title: string;
  showToggle: boolean;
  expanded: boolean;
  variantCount: number;
  base: number;
  converted: number;
  autoRounded: number;
  effective: number;
  backConverted: number;
  drift: number;
}
interface TierRow {
  key: string;
  ruleId: string;
  ruleName: string;
  label: string;
  base: number;
  converted: number;
  autoRounded: number;
  effective: number;
  backConverted: number;
  drift: number;
}

const expanded = ref<Set<string>>(new Set());
function toggle(pid: string): void {
  const next = new Set(expanded.value);
  if (next.has(pid)) next.delete(pid);
  else next.add(pid);
  expanded.value = next;
}

function figures(base: number, override: number | undefined) {
  const rate = event.value!.exchangeRate!;
  const converted = round2(base * rate);
  const autoRounded = toLocalPrice(base, rate, event.value!.roundingIncrement ?? 0);
  const effective = override ?? autoRounded;
  const backConverted = round2(effective / rate);
  return { converted, autoRounded, effective, backConverted, drift: round2(backConverted - base) };
}

const productRows = computed<Row[]>(() => {
  const ev = event.value;
  if (!ev || !hasLocal.value) return [];
  const overrides = ev.localPriceOverrides ?? {};
  const rows: Row[] = [];
  const toRow = (pid: string, type: string, title: string, base: number, memberKeys: string[], variantCount: number, showToggle: boolean, isExpanded: boolean): Row => {
    // A collapsed group only has one price when every member shares the same override (or none).
    const memberOverrides = memberKeys.map((k) => overrides[k]);
    const override = memberOverrides.every((o) => o === memberOverrides[0]) ? memberOverrides[0] : undefined;
    return { key: memberKeys[0]!, memberKeys, pid, type, title, showToggle, expanded: isExpanded, variantCount, base, ...figures(base, override) };
  };
  for (const p of allProducts.value) {
    const type = p.type?.trim() || 'Other';
    if (p.variants.length) {
      const prices = p.variants.map((v) => v.price ?? p.price);
      const same = prices.every((pr) => pr === prices[0]);
      if (same && !expanded.value.has(p.id)) {
        rows.push(toRow(p.id, type, p.title, prices[0]!, p.variants.map((v) => stockKey(p.id, v.id)), p.variants.length, true, false));
      } else {
        p.variants.forEach((v, i) => rows.push(toRow(p.id, type, v.name ? `${p.title} · ${v.name}` : p.title, v.price ?? p.price, [stockKey(p.id, v.id)], p.variants.length, same && i === 0, true)));
      }
    } else {
      rows.push(toRow(p.id, type, p.title, p.price, [stockKey(p.id, null)], 1, false, false));
    }
  }
  return rows;
});

const search = ref('');
const sortByDrift = ref(true);
const groups = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const map = new Map<string, Row[]>();
  for (const r of productRows.value) {
    if (needle && !r.title.toLowerCase().includes(needle)) continue;
    (map.get(r.type) ?? map.set(r.type, []).get(r.type)!).push(r);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, rows]) => ({ type, rows: [...rows].sort((a, b) => (sortByDrift.value ? Math.abs(b.drift) - Math.abs(a.drift) : a.title.localeCompare(b.title))) }));
});

/** Tiered bundle totals ("3 for 10") and combo discounts convert and round like prices. */
const tierRows = computed<TierRow[]>(() => {
  const ev = event.value;
  if (!ev || !hasLocal.value) return [];
  const overrides = ev.localTierOverrides ?? {};
  const rows: TierRow[] = [];
  for (const rule of allDiscounts.value) {
    if (rule.type === 'tiered' && rule.tiers?.length) {
      rule.tiers.forEach((t, i) => rows.push({ key: `${rule.id}:${i}`, ruleId: rule.id, ruleName: rule.name, label: `${t.qty}×`, base: t.total, ...figures(t.total, overrides[`${rule.id}:${i}`]) }));
    } else if (rule.type === 'combo' && rule.comboDiscountAmount) {
      const key = `${rule.id}:combo`;
      rows.push({ key, ruleId: rule.id, ruleName: rule.name, label: 'bundle discount', base: rule.comboDiscountAmount, ...figures(rule.comboDiscountAmount, overrides[key]) });
    }
  }
  return rows;
});
const ruleGroups = computed(() => {
  const map = new Map<string, TierRow[]>();
  for (const r of tierRows.value) (map.get(r.ruleId) ?? map.set(r.ruleId, []).get(r.ruleId)!).push(r);
  return [...map.values()].map((rows) => ({ ruleId: rows[0]!.ruleId, ruleName: rows[0]!.ruleName, rows }));
});

// ── Editable override drafts, one input per row ─────────────────────────────
const drafts = reactive<Record<string, string>>({});
const tierDrafts = reactive<Record<string, string>>({});
watch(
  () => event.value?.id,
  () => {
    for (const k of Object.keys(drafts)) delete drafts[k];
    for (const [k, v] of Object.entries(event.value?.localPriceOverrides ?? {})) drafts[k] = String(v);
    for (const k of Object.keys(tierDrafts)) delete tierDrafts[k];
    for (const [k, v] of Object.entries(event.value?.localTierOverrides ?? {})) tierDrafts[k] = String(v);
  },
  { immediate: true },
);

function parse(raw: string): number | null | false {
  if (!raw.trim()) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : false;
}
async function saveOverride(row: Row): Promise<void> {
  const ev = event.value;
  if (!ev) return;
  const n = parse(drafts[row.key] ?? '');
  if (n === false) {
    error.value = 'Enter a positive price, or leave blank to use the auto-rounded price.';
    drafts[row.key] = ev.localPriceOverrides?.[row.key] != null ? String(ev.localPriceOverrides[row.key]) : '';
    return;
  }
  error.value = null;
  const overrides = { ...(ev.localPriceOverrides ?? {}) };
  for (const k of row.memberKeys) {
    if (n === null) delete overrides[k];
    else overrides[k] = n;
  }
  await upsertSalesEvent({ ...ev, localPriceOverrides: overrides });
}
async function saveTierOverride(row: TierRow): Promise<void> {
  const ev = event.value;
  if (!ev) return;
  const n = parse(tierDrafts[row.key] ?? '');
  if (n === false) {
    error.value = 'Enter a positive price, or leave blank to use the auto-rounded price.';
    tierDrafts[row.key] = ev.localTierOverrides?.[row.key] != null ? String(ev.localTierOverrides[row.key]) : '';
    return;
  }
  error.value = null;
  const overrides = { ...(ev.localTierOverrides ?? {}) };
  if (n === null) delete overrides[row.key];
  else overrides[row.key] = n;
  await upsertSalesEvent({ ...ev, localTierOverrides: overrides });
}
const driftClass = (d: number): string => (Math.abs(d) < 0.005 ? 'faint' : Math.abs(d) < 0.5 ? 'warn' : 'bad');
</script>

<template>
  <section class="prices">
    <header>
      <router-link :to="{ name: 'events' }" class="back"><Icon name="arrow-left" :size="14" /> Events</router-link>
      <h1>Local prices</h1>
      <span v-if="event" class="muted">{{ event.name }}</span>
    </header>

    <p v-if="!event" class="empty">Event not found - open Prices from an event card under Events.</p>
    <p v-else-if="!hasLocal" class="empty">This event has no local currency set - edit the event to set a currency and rate first.</p>

    <template v-else>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="tools">
        <input v-model="search" type="search" placeholder="Search products…" aria-label="Search products" />
        <button type="button" @click="sortByDrift = !sortByDrift">Sort: {{ sortByDrift ? 'biggest rounding drift' : 'A-Z' }}</button>
      </div>

      <section v-for="g in groups" :key="g.type" class="group">
        <h2><span class="swatch" :style="{ background: typeColor(g.type) }"></span><span :style="{ color: typeColor(g.type) }">{{ g.type }}</span></h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th>Product</th><th>Base ({{ event.currency }})</th><th>Converted</th><th>Auto-rounded ({{ event.localCurrency }})</th><th>Override</th><th>Back to {{ event.currency }}</th><th>Drift</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in g.rows" :key="r.key" :class="{ set: drafts[r.key] }">
                <td class="name">
                  <button v-if="r.showToggle" type="button" class="quiet toggle" :aria-expanded="r.expanded" @click="toggle(r.pid)">
                    <Icon :name="r.expanded ? 'chevron-down' : 'chevron-right'" :size="14" /> {{ r.title }} <small>{{ r.expanded ? 'collapse' : `(${r.variantCount} variants)` }}</small>
                  </button>
                  <span v-else>{{ r.title }}</span>
                </td>
                <td class="muted">{{ fmtPrice(r.base, event.currency) }}</td>
                <td class="faint">{{ fmtPrice(r.converted, event.localCurrency!) }}</td>
                <td>{{ fmtPrice(r.autoRounded, event.localCurrency!) }}</td>
                <td class="ovr">
                  <input v-model="drafts[r.key]" type="text" inputmode="decimal" :placeholder="String(r.autoRounded)" aria-label="Override" @change="saveOverride(r)" />
                  <button v-if="drafts[r.key]" type="button" class="quiet" aria-label="Clear override" @click="drafts[r.key] = ''; saveOverride(r)"><Icon name="x" :size="12" /></button>
                </td>
                <td class="muted">{{ fmtPrice(r.backConverted, event.currency) }}</td>
                <td :class="driftClass(r.drift)"><strong>{{ r.drift > 0 ? '+' : '' }}{{ fmtPrice(r.drift, event.currency) }}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p v-if="!groups.length" class="empty">No products match.</p>
      <p class="hint">"Converted" is the raw exchange-rate conversion before rounding. "Auto-rounded" is what the till charges by default. Set an override to charge a specific {{ event.localCurrency }} price instead - "Back to {{ event.currency }}" and "Drift" show what that is worth in your books, so a price that rounded away too much value stands out.</p>

      <template v-if="ruleGroups.length">
        <h2 class="sub">Bundle prices</h2>
        <section v-for="g in ruleGroups" :key="g.ruleId" class="group">
          <h3>{{ g.ruleName }}</h3>
          <div class="table-scroll">
            <table>
              <thead>
                <tr><th>Bundle</th><th>Base ({{ event.currency }})</th><th>Converted</th><th>Auto-rounded ({{ event.localCurrency }})</th><th>Override</th><th>Back to {{ event.currency }}</th><th>Drift</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in g.rows" :key="r.key" :class="{ set: tierDrafts[r.key] }">
                  <td class="name">{{ r.label }}</td>
                  <td class="muted">{{ fmtPrice(r.base, event.currency) }}</td>
                  <td class="faint">{{ fmtPrice(r.converted, event.localCurrency!) }}</td>
                  <td>{{ fmtPrice(r.autoRounded, event.localCurrency!) }}</td>
                  <td class="ovr">
                    <input v-model="tierDrafts[r.key]" type="text" inputmode="decimal" :placeholder="String(r.autoRounded)" aria-label="Override" @change="saveTierOverride(r)" />
                    <button v-if="tierDrafts[r.key]" type="button" class="quiet" aria-label="Clear override" @click="tierDrafts[r.key] = ''; saveTierOverride(r)"><Icon name="x" :size="12" /></button>
                  </td>
                  <td class="muted">{{ fmtPrice(r.backConverted, event.currency) }}</td>
                  <td :class="driftClass(r.drift)"><strong>{{ r.drift > 0 ? '+' : '' }}{{ fmtPrice(r.drift, event.currency) }}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <p class="hint">Bundle totals convert and round the same way as prices. The discount charged at the till is computed against this local bundle total, so an override here lands exactly at checkout.</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.prices { display: flex; flex-direction: column; gap: 1rem; max-width: 64rem; }
header { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.back { display: inline-flex; align-items: center; gap: .25rem; color: var(--zfy-muted, #5a6472); text-decoration: none; font-size: .875rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2.sub { margin: .5rem 0 0; font-size: 1rem; }
.muted { color: var(--zfy-muted, #5a6472); }
.faint { color: var(--zfy-faint, #8a94a0); }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
.bad { color: var(--zfy-danger, #c6512f); }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .8rem; max-width: 60ch; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.tools { display: flex; gap: .5rem; flex-wrap: wrap; }
.tools input { flex: 1; min-width: 12rem; }
.group { display: flex; flex-direction: column; gap: .4rem; }
.group h2 { margin: 0; display: flex; align-items: center; gap: .5rem; font-size: .9rem; }
.group h3 { margin: 0; font-size: .82rem; color: var(--zfy-muted, #5a6472); }
.swatch { width: .35rem; height: 1rem; border-radius: 999px; }
.table-scroll { overflow-x: auto; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
table { width: 100%; min-width: 50rem; border-collapse: collapse; font-size: .85rem; font-variant-numeric: tabular-nums; }
th { text-align: right; font-weight: 500; font-size: .72rem; color: var(--zfy-muted, #5a6472); padding: .5rem .7rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); white-space: nowrap; }
td { text-align: right; padding: .4rem .7rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
tr:last-child td { border-bottom: 0; }
th:first-child, td.name { text-align: left; }
tr.set td { background: var(--zfy-accent-soft, #deeee9); }
.toggle { display: inline-flex; align-items: center; gap: .3rem; min-height: 2.2rem; padding: 0 .2rem; font-weight: 400; }
.toggle small { color: var(--zfy-muted, #5a6472); }
.ovr { white-space: nowrap; }
.ovr input { width: 6rem; min-height: 2.2rem; padding: .1rem .4rem; text-align: right; }
.ovr .quiet { min-height: 2.2rem; padding: 0 .3rem; }
</style>
