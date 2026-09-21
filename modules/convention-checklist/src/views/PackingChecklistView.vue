<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  DEFAULT_TEMPLATE,
  TEMPLATE_KEY,
  groupItems,
  progress,
  stateKey,
  type ChecklistItem,
  type ChecklistState,
} from '../engine/checklist';
import { sdk } from '../runtime';

/**
 * One shared packing template (booth supplies + product categories),
 * checked off fresh per convention. "Product" items are checked against a
 * whole catalog `type` category rather than one SKU - see checklist.ts.
 */

const template = ref<ChecklistItem[]>([]);
const state = ref<ChecklistState>({});
const events = computed(() => sdk().data.events.list());
const selectedEventId = ref<string | null>(null);
const selectedEvent = computed(() => events.value.find((e) => e.id === selectedEventId.value) ?? null);

const groups = computed(() => groupItems(template.value));
const overall = computed(() => progress(template.value, state.value));

onMounted(async () => {
  const stored = await sdk().data.settings.get<ChecklistItem[]>(TEMPLATE_KEY);
  if (stored?.length) {
    template.value = stored;
  } else {
    // First-ever load for this account - seed once and publish it, so every
    // device and every future event starts from the same list.
    template.value = DEFAULT_TEMPLATE;
    await sdk().data.settings.set(TEMPLATE_KEY, DEFAULT_TEMPLATE);
  }
  selectedEventId.value = sdk().data.events.active()?.id ?? events.value[0]?.id ?? null;
});

watch(selectedEventId, async (eventId) => {
  state.value = (eventId && (await sdk().data.settings.get<ChecklistState>(stateKey(eventId)))) || {};
}, { immediate: true });

async function toggle(item: ChecklistItem): Promise<void> {
  if (!selectedEventId.value) return;
  state.value = { ...state.value, [item.id]: !state.value[item.id] };
  await sdk().data.settings.set(stateKey(selectedEventId.value), state.value);
}

async function resetChecklist(): Promise<void> {
  if (!selectedEventId.value) return;
  state.value = {};
  await sdk().data.settings.set(stateKey(selectedEventId.value), {});
}

// ── Product-linked items: aggregate stock/claim by catalog `type`, not one SKU ──
const productTypes = computed(() => {
  const types = new Set<string>();
  for (const p of sdk().data.products.list()) if (p.type) types.add(p.type);
  return [...types].sort();
});

const stockByType = computed(() => {
  const totals = new Map<string, number>();
  if (!selectedEvent.value) return totals;
  const byId = new Map(sdk().data.products.list().map((p) => [p.id, p]));
  for (const a of sdk().data.inventory.availability(selectedEvent.value.id)) {
    const type = byId.get(a.productId)?.type;
    if (!type) continue;
    totals.set(type, (totals.get(type) ?? 0) + (a.claimed ?? a.onHand));
  }
  return totals;
});

// ── Editing the shared template ─────────────────────────────────────────────
const editing = ref(false);
const newLabel = ref('');
const newGroup = ref('');
const newKind = ref<'supply' | 'product'>('supply');
const newProductType = ref('');

async function saveTemplate(): Promise<void> {
  await sdk().data.settings.set(TEMPLATE_KEY, template.value);
}

async function addItem(): Promise<void> {
  const label = newLabel.value.trim();
  if (!label) return;
  if (newKind.value === 'product' && !newProductType.value) return;
  const group = newGroup.value.trim() || undefined;
  const item: ChecklistItem =
    newKind.value === 'product'
      ? { id: crypto.randomUUID(), kind: 'product', label, group, productType: newProductType.value }
      : { id: crypto.randomUUID(), kind: 'supply', label, group };
  template.value = [...template.value, item];
  await saveTemplate();
  newLabel.value = '';
  newProductType.value = '';
}

async function removeItem(id: string): Promise<void> {
  template.value = template.value.filter((i) => i.id !== id);
  await saveTemplate();
}

async function moveItem(id: string, dir: -1 | 1): Promise<void> {
  const items = [...template.value];
  const i = items.findIndex((it) => it.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j]!, items[i]!];
  template.value = items;
  await saveTemplate();
}
</script>

<template>
  <section class="page checklist">
    <header>
      <h1>Packing checklist</h1>
      <label class="event-picker">
        <span>Convention</span>
        <select v-model="selectedEventId">
          <option v-for="e in events" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </label>
    </header>

    <p v-if="!events.length" class="empty">No sales events yet - create one to start a checklist against it.</p>

    <template v-else>
      <div class="toolbar">
        <span class="progress">{{ overall.done }} / {{ overall.total }} packed</span>
        <button type="button" class="quiet" @click="resetChecklist">Uncheck all</button>
        <button type="button" class="quiet" @click="editing = !editing">{{ editing ? 'Done editing' : 'Edit list' }}</button>
      </div>

      <div v-for="g in groups" :key="g.group ?? '__top'" class="group">
        <h2 v-if="g.group">{{ g.group }}</h2>
        <ul class="items">
          <li v-for="item in g.items" :key="item.id" class="item">
            <label>
              <input type="checkbox" :checked="!!state[item.id]" @change="toggle(item)" />
              <span :class="{ done: state[item.id] }">{{ item.label }}</span>
              <span v-if="item.kind === 'product'" class="hint">
                {{ item.productType }} · {{ selectedEvent ? (stockByType.get(item.productType) ?? 0) : '?' }} on hand
              </span>
            </label>
            <span v-if="editing" class="edit-controls">
              <button type="button" class="quiet" @click="moveItem(item.id, -1)" aria-label="Move up">↑</button>
              <button type="button" class="quiet" @click="moveItem(item.id, 1)" aria-label="Move down">↓</button>
              <button type="button" class="quiet danger" @click="removeItem(item.id)" aria-label="Remove">✕</button>
            </span>
          </li>
        </ul>
      </div>

      <div v-if="editing" class="card add-item">
        <h2>Add item</h2>
        <div class="row">
          <label class="kind"><input type="radio" value="supply" v-model="newKind" /> Supply (freeform)</label>
          <label class="kind"><input type="radio" value="product" v-model="newKind" /> Product category</label>
        </div>
        <div class="row">
          <input v-model="newLabel" type="text" placeholder="Label, e.g. Hats" />
          <input v-model="newGroup" type="text" placeholder="Group (optional), e.g. Merch" />
        </div>
        <select v-if="newKind === 'product'" v-model="newProductType">
          <option value="" disabled>Choose a product type…</option>
          <option v-for="t in productTypes" :key="t" :value="t">{{ t }}</option>
        </select>
        <p v-if="newKind === 'product' && !productTypes.length" class="hint">No products have a "type" set yet - set one under Products first.</p>
        <button type="button" class="primary" @click="addItem">Add</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.checklist { display: flex; flex-direction: column; gap: 1rem; max-width: 44rem; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: .95rem; color: var(--zfy-muted, #5a6472); }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.event-picker { display: flex; align-items: center; gap: .5rem; font-size: .85rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; }

.toolbar { display: flex; align-items: center; gap: .6rem; }
.toolbar .progress { font-weight: 600; margin-right: auto; }

.group { display: flex; flex-direction: column; gap: .35rem; }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
.item { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .3rem .4rem; border-radius: 8px; }
.item:hover { background: var(--zfy-bg, #f1f4f6); }
.item label { display: flex; align-items: baseline; gap: .5rem; flex: 1; min-width: 0; cursor: pointer; }
.item .done { text-decoration: line-through; color: var(--zfy-muted, #5a6472); }
.item .hint { font-size: .75rem; color: var(--zfy-muted, #5a6472); white-space: nowrap; }
.edit-controls { display: flex; gap: .2rem; flex: none; }

.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: .9rem 1rem; display: flex; flex-direction: column; gap: .6rem; }
.add-item .row { display: flex; gap: .6rem; flex-wrap: wrap; }
.add-item .kind { display: flex; align-items: center; gap: .35rem; font-size: .85rem; }
.add-item input[type='text'] { flex: 1; min-width: 10rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.danger { color: var(--zfy-danger, #c6512f); }
</style>
