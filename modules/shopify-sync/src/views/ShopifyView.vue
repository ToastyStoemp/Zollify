<script setup lang="ts">
import { Icon } from '@zollify/ui';
import { computed, onMounted, ref } from 'vue';
import { sdk } from '../runtime';

interface MatchedVariant {
  kind: 'sku' | 'fuzzy' | 'manual' | 'none';
  score?: number;
  shopVariantId?: string;
  shopTitle?: string;
}

interface ProductMatch {
  ztProductId: string;
  ztTitle: string;
  kind: 'sku' | 'fuzzy' | 'manual' | 'none';
  score?: number;
  shopProductId?: string;
  shopTitle?: string;
  variants?: MatchedVariant[];
}

const matches = ref<ProductMatch[]>([]);
const connected = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const ran = ref(false);
const confirmingId = ref<string | null>(null);

const grouped = computed(() => ({
  sku: matches.value.filter((m) => m.kind === 'sku'),
  fuzzy: matches.value.filter((m) => m.kind === 'fuzzy'),
  none: matches.value.filter((m) => m.kind === 'none'),
}));

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
    const products = sdk().data.products.list().map((p) => ({
      id: p.id,
      title: p.title,
      sku: p.sku ?? null,
      price: p.price,
      variants: [],
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

async function confirm(match: ProductMatch): Promise<void> {
  confirmingId.value = match.ztProductId;
  try {
    await sdk().http.post('matches/save', {
      matches: { [match.ztProductId]: { shopProductId: match.shopProductId, kind: 'manual' } },
    });
    match.kind = 'manual';
    sdk().ui.toast(`Match confirmed for ${match.ztTitle}.`, { kind: 'success' });
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
        {{ grouped.fuzzy.length }} need review ·
        {{ grouped.none.length }} unmatched
      </p>

      <template v-if="grouped.fuzzy.length">
        <h2>Needs review</h2>
        <p class="hint">Suggested by title similarity. Confirm before anything is written back.</p>
        <ul class="list">
          <li v-for="match in grouped.fuzzy" :key="match.ztProductId">
            <div class="meta">
              <strong>{{ match.ztTitle }}</strong>
              <span>→ {{ match.shopTitle ?? 'no candidate' }} · {{ pct(match.score) }}</span>
            </div>
            <button type="button" :disabled="!match.shopProductId || confirmingId === match.ztProductId" @click="confirm(match)">
              {{ confirmingId === match.ztProductId ? 'Confirming…' : 'Confirm' }}
            </button>
          </li>
        </ul>
      </template>

      <template v-if="grouped.none.length">
        <h2>Unmatched</h2>
        <ul class="list muted">
          <li v-for="match in grouped.none" :key="match.ztProductId">
            <div class="meta"><strong>{{ match.ztTitle }}</strong><span>No candidate found</span></div>
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
