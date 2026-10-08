<script setup lang="ts">
import { Icon } from '@zollify/ui';
import type { MatchKind, ProductMatch, SavedProductMatch, ZtProduct } from '@zollify/shared';
import { computed, onMounted, ref } from 'vue';
import { sdk } from '../runtime';

/**
 * Match the catalogue against Odoo's products, confirm the fuzzy ones, and
 * run a sync. Matching is a proposal: nothing moves until a match is
 * confirmed, and only confirmed or SKU-exact items are synced.
 */
interface Status {
  matched: number;
  levels: number;
  lastSyncAt: number | null;
  invoices: number;
  creditNotes: number;
  log: { at: number; kind: string; message: string }[];
}

const matches = ref<ProductMatch[]>([]);
const connected = ref(false);
const status = ref<Status | null>(null);
const busy = ref(false);
const syncing = ref(false);
const error = ref<string | null>(null);
const ran = ref(false);
const confirmingId = ref<string | null>(null);

const RANK: Record<MatchKind, number> = { none: 0, fuzzy: 1, manual: 2, sku: 3 };
const kindOf = (m: ProductMatch): MatchKind => m.variants.reduce<MatchKind>((best, v) => (RANK[v.kind] > RANK[best] ? v.kind : best), 'none');
const scoreOf = (m: ProductMatch): number | undefined => {
  const scores = m.variants.filter((v) => v.shop).map((v) => v.score);
  return scores.length ? Math.min(...scores) : undefined;
};
const odooTitle = (m: ProductMatch): string | undefined => (m.variants.find((v) => v.shop?.productId === m.shopProductId) ?? m.variants.find((v) => v.shop))?.shop?.productTitle;
const variantsLine = (m: ProductMatch): string => (m.zt.variants.length ? m.variants.map((v) => `${v.ztVariantName} → ${v.shop?.variantTitle ?? 'no match'}`).join(' · ') : '');
const grouped = computed(() => {
  const by: Record<MatchKind, ProductMatch[]> = { sku: [], manual: [], fuzzy: [], none: [] };
  for (const m of matches.value) by[kindOf(m)].push(m);
  return by;
});
const pct = (score: number | undefined): string => (score === undefined ? '-' : `${Math.round(score * 100)}%`);
const when = (ts: number | null): string => (ts ? new Date(ts).toLocaleString() : 'never');

async function loadStatus(): Promise<void> {
  status.value = await sdk().http.get<Status>('status').catch(() => null);
}
onMounted(async () => {
  try {
    connected.value = (await sdk().http.get<{ connected: boolean }>('connection')).connected;
  } catch {
    connected.value = false;
  }
  if (connected.value) await loadStatus();
});

async function run(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const saved = await sdk().http.get<{ saved: Record<string, unknown> }>('matches');
    const products: ZtProduct[] = sdk().data.products.list().map((p) => ({ id: p.id, title: p.title, sku: p.sku, type: p.type, price: p.price, variants: p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, price: v.price })), updatedAt: p.updatedAt }));
    const res = await sdk().http.post<{ matches: ProductMatch[] }>('match', { products, saved: saved.saved });
    matches.value = res.matches;
    ran.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Matching did not complete.';
  } finally {
    busy.value = false;
  }
}

/** SKU-exact matches are trusted as they are; confirming saves one so it stays even when the SKU changes. */
async function confirm(match: ProductMatch): Promise<void> {
  confirmingId.value = match.zt.id;
  try {
    const entry: SavedProductMatch = { shopProductId: match.shopProductId, variants: Object.fromEntries(match.variants.map((v) => [v.ztVariantId, v.shop ? { productId: v.shop.productId, variantId: v.shop.variantId } : null])) };
    await sdk().http.post('matches/save', { matches: { [match.zt.id]: entry } });
    for (const v of match.variants) if (v.shop) Object.assign(v, { kind: 'manual', score: 1 });
    sdk().ui.toast(`Matched ${match.zt.title}.`, { kind: 'success' });
    await loadStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that match.';
  } finally {
    confirmingId.value = null;
  }
}

/** Every SKU-exact match in one go - the usual case for a catalogue that already carries Odoo's references. */
async function confirmSku(): Promise<void> {
  const entries: Record<string, SavedProductMatch> = {};
  for (const m of grouped.value.sku) entries[m.zt.id] = { shopProductId: m.shopProductId, variants: Object.fromEntries(m.variants.map((v) => [v.ztVariantId, v.shop ? { productId: v.shop.productId, variantId: v.shop.variantId } : null])) };
  if (!Object.keys(entries).length) return;
  busy.value = true;
  try {
    await sdk().http.post('matches/save', { matches: entries });
    for (const m of grouped.value.sku) for (const v of m.variants) if (v.shop) Object.assign(v, { kind: 'manual', score: 1 });
    sdk().ui.toast(`${Object.keys(entries).length} SKU matches saved.`, { kind: 'success' });
    await loadStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save the matches.';
  } finally {
    busy.value = false;
  }
}

async function sync(): Promise<void> {
  syncing.value = true;
  error.value = null;
  try {
    const r = await sdk().http.post<{ pushed: number; pulled: number }>('sync', {});
    sdk().ui.toast(`${r.pushed} level${r.pushed === 1 ? '' : 's'} sent to Odoo, ${r.pulled} taken from it.`, { kind: 'success' });
    await loadStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Sync did not complete.';
  } finally {
    syncing.value = false;
  }
}
</script>

<template>
  <section class="page odoo">
    <header>
      <h1>Odoo</h1>
      <div class="tools">
        <button type="button" :disabled="syncing || !connected" @click="sync"><Icon name="refresh-cw" :size="16" /> {{ syncing ? 'Syncing…' : 'Sync now' }}</button>
        <button type="button" class="primary" :disabled="busy || !connected" @click="run"><Icon name="search" :size="16" /> {{ busy ? 'Matching…' : 'Match catalogue' }}</button>
      </div>
    </header>

    <p v-if="!connected" class="empty">No Odoo connected. Add one under Settings → Odoo connection.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <section v-if="status" class="card">
      <div class="tiles">
        <div><span>Matched</span><strong>{{ status.matched }}</strong><small>products</small></div>
        <div><span>In step</span><strong>{{ status.levels }}</strong><small>stock levels</small></div>
        <div><span>Last sync</span><strong>{{ when(status.lastSyncAt) }}</strong></div>
        <div><span>Invoices</span><strong>{{ status.invoices }}</strong><small v-if="status.creditNotes">{{ status.creditNotes }} credited</small></div>
      </div>
      <ul v-if="status.log.length" class="log">
        <li v-for="(l, i) in status.log" :key="i" :class="l.kind"><small>{{ when(l.at) }}</small> {{ l.message }}</li>
      </ul>
      <p v-else class="hint">Nothing synced yet. Match the catalogue, confirm, then Sync now.</p>
    </section>

    <template v-if="ran">
      <p class="summary">{{ grouped.sku.length }} matched by SKU · {{ grouped.manual.length }} confirmed · {{ grouped.fuzzy.length }} need review · {{ grouped.none.length }} unmatched</p>

      <template v-if="grouped.fuzzy.length">
        <h2>Needs review</h2>
        <p class="hint">Suggested by title similarity. Confirm before anything moves.</p>
        <ul class="list">
          <li v-for="match in grouped.fuzzy" :key="match.zt.id">
            <div class="meta"><strong>{{ match.zt.title }}</strong><span>→ {{ odooTitle(match) ?? 'no candidate' }} · {{ pct(scoreOf(match)) }}</span><span v-if="variantsLine(match)">{{ variantsLine(match) }}</span></div>
            <button type="button" :disabled="!match.shopProductId || confirmingId === match.zt.id" @click="confirm(match)">{{ confirmingId === match.zt.id ? 'Confirming…' : 'Confirm' }}</button>
          </li>
        </ul>
      </template>

      <template v-if="grouped.sku.length">
        <div class="head"><h2>Matched by SKU</h2><span class="grow" /><button type="button" :disabled="busy" @click="confirmSku">Save all</button></div>
        <ul class="list muted">
          <li v-for="match in grouped.sku" :key="match.zt.id"><div class="meta"><strong>{{ match.zt.title }}</strong><span>→ {{ odooTitle(match) }}</span><span v-if="variantsLine(match)">{{ variantsLine(match) }}</span></div></li>
        </ul>
      </template>

      <template v-if="grouped.manual.length">
        <h2>Confirmed</h2>
        <ul class="list muted">
          <li v-for="match in grouped.manual" :key="match.zt.id"><div class="meta"><strong>{{ match.zt.title }}</strong><span>→ {{ odooTitle(match) }}</span><span v-if="variantsLine(match)">{{ variantsLine(match) }}</span></div></li>
        </ul>
      </template>

      <template v-if="grouped.none.length">
        <h2>Unmatched</h2>
        <ul class="list muted">
          <li v-for="match in grouped.none" :key="match.zt.id"><div class="meta"><strong>{{ match.zt.title }}</strong><span>No candidate found - these stay out of the sync</span></div></li>
        </ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
h2 { margin: .5rem 0 0; font-size: 1.05rem; }
.head { display: flex; align-items: center; gap: .6rem; }
.grow { flex: 1; }
.summary, .hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; }
.card { display: flex; flex-direction: column; gap: .6rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .5rem; }
.tiles div { display: flex; flex-direction: column; gap: .1rem; padding: .5rem .65rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.tiles span { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.tiles strong { font-size: 1rem; }
.tiles small { font-size: .74rem; color: var(--zfy-muted, #5a6472); }
.log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; font-size: .82rem; max-height: 14rem; overflow: auto; }
.log small { color: var(--zfy-muted, #5a6472); margin-right: .4rem; }
.log .error { color: var(--zfy-danger, #c6512f); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; background: var(--zfy-surface, #fff); }
.meta { display: flex; flex-direction: column; gap: .1rem; font-size: .9rem; }
.meta span { color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.muted li { opacity: .75; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
</style>
