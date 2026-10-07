<script setup lang="ts">
import { Icon } from '@zollify/ui';
import type { MatchKind, ProductMatch, SavedProductMatch, ZtProduct } from '@zollify/shared';
import { computed, onMounted, ref } from 'vue';
import { sdk } from '../runtime';

const matches = ref<ProductMatch[]>([]);
const connected = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const ran = ref(false);
const confirmingId = ref<string | null>(null);

/** A product's kind is its strongest variant match: one SKU hit outranks the fuzzy rest. */
const RANK: Record<MatchKind, number> = { none: 0, fuzzy: 1, manual: 2, sku: 3 };
function kindOf(m: ProductMatch): MatchKind {
  return m.variants.reduce<MatchKind>((best, v) => (RANK[v.kind] > RANK[best] ? v.kind : best), 'none');
}
/** The weakest matched variant is what needs a look. */
function scoreOf(m: ProductMatch): number | undefined {
  const scores = m.variants.filter((v) => v.shop).map((v) => v.score);
  return scores.length ? Math.min(...scores) : undefined;
}
function shopTitle(m: ProductMatch): string | undefined {
  return (m.variants.find((v) => v.shop?.productId === m.shopProductId) ?? m.variants.find((v) => v.shop))?.shop?.productTitle;
}
/** "Red → Red · Blue → no match", only for products that have variants. */
function variantsLine(m: ProductMatch): string {
  if (!m.zt.variants.length) return '';
  return m.variants.map((v) => `${v.ztVariantName} → ${v.shop?.variantTitle ?? 'no match'}`).join(' · ');
}

const grouped = computed(() => {
  const by: Record<MatchKind, ProductMatch[]> = { sku: [], manual: [], fuzzy: [], none: [] };
  for (const m of matches.value) by[kindOf(m)].push(m);
  return by;
});

onMounted(async () => {
  try {
    const state = await sdk().http.get<{ connected: boolean }>('connection');
    connected.value = state.connected;
  } catch {
    connected.value = false;
  }
});

/**
 * Matching is a read-only proposal. Nothing is written to the storefront here -
 * a fuzzy match applied automatically would rewrite live prices on a guess.
 */
async function run(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const saved = await sdk().http.get<{ saved: Record<string, unknown> }>('matches');
    // Only what the matcher reads; the rest of the product stays on the device.
    const products: ZtProduct[] = sdk().data.products.list().map((p) => ({
      id: p.id,
      title: p.title,
      sku: p.sku,
      type: p.type,
      price: p.price,
      variants: p.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku, price: v.price })),
      updatedAt: p.updatedAt,
    }));

    const res = await sdk().http.post<{ matches: ProductMatch[] }>('match', {
      products,
      saved: saved.saved,
    });
    matches.value = res.matches;
    ran.value = true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Matching did not complete.';
  } finally {
    busy.value = false;
  }
}

/** Saves the proposed mapping as-is: every variant's suggestion becomes the chosen one. */
async function confirm(match: ProductMatch): Promise<void> {
  confirmingId.value = match.zt.id;
  try {
    const entry: SavedProductMatch = {
      shopProductId: match.shopProductId,
      variants: Object.fromEntries(match.variants.map((v) => [v.ztVariantId, v.shop ? { productId: v.shop.productId, variantId: v.shop.variantId } : null])),
    };
    await sdk().http.post('matches/save', { matches: { [match.zt.id]: entry } });
    for (const v of match.variants) {
      if (v.shop) {
        v.kind = 'manual';
        v.score = 1;
      }
    }
    sdk().ui.toast(`Match confirmed for ${match.zt.title}.`, { kind: 'success' });
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save that match.';
  } finally {
    confirmingId.value = null;
  }
}

function pct(score: number | undefined): string {
  return score === undefined ? '-' : `${Math.round(score * 100)}%`;
}
</script>

<template>
  <section class="page shopify">
    <header>
      <h1>Shopify</h1>
      <div class="tools">
        <button type="button" class="primary" :disabled="busy || !connected" @click="run">
          <Icon name="refresh-cw" :size="16" /> {{ busy ? 'Matching…' : 'Match catalogue' }}
        </button>
      </div>
    </header>

    <p v-if="!connected" class="empty">
      No Shopify store connected. Add one under Settings → Shopify connection.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <template v-if="ran">
      <p class="summary">
        {{ grouped.sku.length }} matched by SKU ·
        {{ grouped.manual.length }} confirmed ·
        {{ grouped.fuzzy.length }} need review ·
        {{ grouped.none.length }} unmatched
      </p>

      <template v-if="grouped.fuzzy.length">
        <h2>Needs review</h2>
        <p class="hint">Suggested by title similarity. Confirm before anything is written back.</p>
        <ul class="list">
          <li v-for="match in grouped.fuzzy" :key="match.zt.id">
            <div class="meta">
              <strong>{{ match.zt.title }}</strong>
              <span>→ {{ shopTitle(match) ?? 'no candidate' }} · {{ pct(scoreOf(match)) }}</span>
              <span v-if="variantsLine(match)">{{ variantsLine(match) }}</span>
            </div>
            <button type="button" :disabled="!match.shopProductId || confirmingId === match.zt.id" @click="confirm(match)">
              {{ confirmingId === match.zt.id ? 'Confirming…' : 'Confirm' }}
            </button>
          </li>
        </ul>
      </template>

      <template v-if="grouped.sku.length">
        <h2>Matched by SKU</h2>
        <ul class="list muted">
          <li v-for="match in grouped.sku" :key="match.zt.id">
            <div class="meta">
              <strong>{{ match.zt.title }}</strong>
              <span>→ {{ shopTitle(match) }}</span>
              <span v-if="variantsLine(match)">{{ variantsLine(match) }}</span>
            </div>
          </li>
        </ul>
      </template>

      <template v-if="grouped.manual.length">
        <h2>Confirmed</h2>
        <ul class="list muted">
          <li v-for="match in grouped.manual" :key="match.zt.id">
            <div class="meta">
              <strong>{{ match.zt.title }}</strong>
              <span>→ {{ shopTitle(match) }}</span>
              <span v-if="variantsLine(match)">{{ variantsLine(match) }}</span>
            </div>
          </li>
        </ul>
      </template>

      <template v-if="grouped.none.length">
        <h2>Unmatched</h2>
        <ul class="list muted">
          <li v-for="match in grouped.none" :key="match.zt.id">
            <div class="meta"><strong>{{ match.zt.title }}</strong><span>No candidate found</span></div>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
h2 { margin: .5rem 0 0; font-size: 1.05rem; }
.summary { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; background: var(--zfy-surface, #fff); }
.meta { display: flex; flex-direction: column; gap: .1rem; font-size: .9rem; }
.meta span { color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.muted li { opacity: .75; }
</style>
