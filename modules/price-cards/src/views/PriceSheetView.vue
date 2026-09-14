<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Icon, typeColor } from '@zollify/ui';
import { fmtPrice } from '@zollify/shared';
import { buildPriceGroups, buildPriceSheetHtml, type PriceGroup } from '../price-sheet';
import { sdk } from '../runtime';

/**
 * The merged price sheet — ZollTool's. Sizes shared across prints collapse
 * into one line, a design range at one price becomes "any design", and deals
 * hang off the lines they touch. Untick what is not on the table; the order
 * of the sections is remembered on this device.
 */

const ORDER_KEY = 'zollify.priceSheet.groupOrder';
const groups = ref<PriceGroup[]>([]);
const order = ref<string[]>([]);
const excluded = ref<Set<string>>(new Set());
const notice = ref<string | null>(null);

const currency = computed(() => sdk().data.events.active()?.currency ?? sdk().account()?.profile.defaultCurrency ?? 'CHF');

function inStock(units: { pid: string; vid: string }[]): boolean {
  const ev = sdk().data.events.active();
  if (!ev) return true;
  const avail = sdk().data.inventory.availability(ev.id);
  return units.some((u) => (avail.find((a) => a.productId === u.pid && a.variantId === (u.vid || ''))?.available ?? 0) > 0);
}

onMounted(() => {
  groups.value = buildPriceGroups(sdk().data.products.list(), sdk().data.discounts.active(), currency.value);
  const types = groups.value.map((g) => g.type);
  let saved: string[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as string[];
  } catch {
    /* no storage */
  }
  order.value = [...saved.filter((t) => types.includes(t)), ...types.filter((t) => !saved.includes(t))];
  // With an event active, start with anything not in stock there unticked.
  const ex = new Set<string>();
  if (sdk().data.events.active()) for (const g of groups.value) for (const l of g.lines) if (!inStock(l.units)) ex.add(l.id);
  excluded.value = ex;
});

const ordered = computed(() => order.value.map((t) => groups.value.find((g) => g.type === t)).filter((g): g is PriceGroup => !!g));
const included = computed(() => ordered.value.map((g) => ({ type: g.type, lines: g.lines.filter((l) => !excluded.value.has(l.id)) })).filter((g) => g.lines.length));
const totalLines = computed(() => groups.value.reduce((n, g) => n + g.lines.length, 0));
const shownLines = computed(() => included.value.reduce((n, g) => n + g.lines.length, 0));

function toggle(id: string): void {
  const s = new Set(excluded.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  excluded.value = s;
}
function toggleGroup(g: PriceGroup, on: boolean): void {
  const s = new Set(excluded.value);
  for (const l of g.lines) if (on) s.delete(l.id);
  else s.add(l.id);
  excluded.value = s;
}
function move(type: string, dir: -1 | 1): void {
  const arr = [...order.value];
  const i = arr.indexOf(type);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  order.value = arr;
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(arr));
  } catch {
    /* no storage */
  }
}

function open(): void {
  if (!included.value.length) {
    notice.value = 'Pick at least one line.';
    return;
  }
  notice.value = null;
  const artist = sdk().account()?.profile.artist;
  const brand = (artist?.companyName || artist?.fullName || '').trim();
  const eventName = sdk().data.events.active()?.name;
  const html = buildPriceSheetHtml(included.value, {
    title: brand || (eventName ? `Price List — ${eventName}` : 'Price List'),
    subtitle: brand ? ['Price list', eventName].filter(Boolean).join(' · ') + ` · prices in ${currency.value}` : `${shownLines.value} lines · prices in ${currency.value}`,
    currency: currency.value,
  });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
</script>

<template>
  <section class="sheet">
    <header>
      <div>
        <h1>Price sheet</h1>
        <p class="hint">A merged, print-ready list from the catalogue and its deals. {{ shownLines }} of {{ totalLines }} lines included.</p>
      </div>
      <button type="button" class="primary" :disabled="!shownLines" @click="open"><Icon name="printer" :size="16" /> Open price sheet</button>
    </header>
    <p v-if="notice" class="error" role="alert">{{ notice }}</p>
    <p v-if="!groups.length" class="empty">No products for sale yet.</p>

    <article v-for="(g, i) in ordered" :key="g.type" class="group">
      <div class="head">
        <span class="swatch" :style="{ background: typeColor(g.type) }"></span>
        <h2 :style="{ color: typeColor(g.type) }">{{ g.type }}</h2>
        <small>{{ g.lines.filter((l) => !excluded.has(l.id)).length }} / {{ g.lines.length }}</small>
        <span class="spacer"></span>
        <button type="button" class="quiet" @click="toggleGroup(g, true)">All</button>
        <button type="button" class="quiet" @click="toggleGroup(g, false)">None</button>
        <button type="button" class="quiet" :disabled="i === 0" aria-label="Move up" @click="move(g.type, -1)"><Icon name="arrow-up" :size="14" /></button>
        <button type="button" class="quiet" :disabled="i === ordered.length - 1" aria-label="Move down" @click="move(g.type, 1)"><Icon name="arrow-down" :size="14" /></button>
      </div>
      <ul>
        <li v-for="l in g.lines" :key="l.id" :class="{ off: excluded.has(l.id) }">
          <label>
            <input type="checkbox" :checked="!excluded.has(l.id)" @change="toggle(l.id)" />
            <span class="name">{{ l.label }} <em v-if="l.qual">{{ l.qual }}</em></span>
            <span class="deals"><span v-for="d in l.deals" :key="d" class="tag">{{ d }}</span></span>
            <strong>{{ fmtPrice(l.price, currency) }}</strong>
          </label>
        </li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.sheet { display: flex; flex-direction: column; gap: 1rem; max-width: 56rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
header .primary { display: inline-flex; align-items: center; gap: .4rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.group { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); overflow: hidden; }
.head { display: flex; align-items: center; gap: .5rem; padding: .5rem .8rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.head h2 { margin: 0; font-size: .95rem; }
.head small { color: var(--zfy-muted, #5a6472); }
.spacer { flex: 1; }
.head .quiet { min-height: 1.8rem; padding: .1rem .5rem; font-size: .78rem; }
.swatch { width: .35rem; height: 1rem; border-radius: 999px; }
ul { list-style: none; margin: 0; padding: 0; }
li + li { border-top: 1px solid var(--zfy-line, #d6dde4); }
li.off { opacity: .45; }
label { display: flex; align-items: center; gap: .6rem; padding: .45rem .8rem; font-size: .875rem; cursor: pointer; }
.name { flex: 1; min-width: 0; }
.name em { font-style: normal; color: var(--zfy-muted, #5a6472); font-size: .8em; }
.deals { display: flex; gap: .3rem; flex-wrap: wrap; }
.tag { font-size: .68rem; font-weight: 600; color: var(--zfy-accent-ink, #0a5a4a); background: var(--zfy-accent-soft, #deeee9); border-radius: 999px; padding: .05rem .5rem; }
strong { font-variant-numeric: tabular-nums; }
</style>
