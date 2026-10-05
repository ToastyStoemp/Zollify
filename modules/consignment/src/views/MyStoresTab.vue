<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ArtistConsignment } from '@zollify/shared';
import { commissionFor, fmtPrice } from '@zollify/shared';
import { Icon } from '@zollify/ui';
import { acceptCode, errorText, leaveStore, myLinks } from '../api';
import { sdk } from '../runtime';

/**
 * The artist's side: stores that sell this account's work. The same account
 * keeps running its own events; linking only lets it see, read-only, what a
 * store owner records about its items there.
 */
const emit = defineEmits<{ error: [message: string | null] }>();

const links = ref<ArtistConsignment[] | null>(null);
const code = ref('');
const busy = ref(false);
async function refresh(): Promise<void> {
  try {
    links.value = await myLinks();
  } catch (err) {
    emit('error', errorText(err, 'Could not load your stores.'));
  }
}
onMounted(refresh);

async function link(): Promise<void> {
  if (!code.value.trim()) return;
  emit('error', null);
  busy.value = true;
  try {
    const res = await acceptCode(code.value.trim());
    code.value = '';
    sdk().ui.toast(`Linked to ${res.storeAccountName} as ${res.consignorName}.`, { kind: 'success' });
    await refresh();
  } catch (err) {
    emit('error', errorText(err, 'Could not link with that code.'));
  } finally {
    busy.value = false;
  }
}
async function leave(l: ArtistConsignment): Promise<void> {
  const ok = await sdk().ui.confirm(`You stop seeing your sales and payouts at ${l.storeAccountName}. They keep selling your items until you agree otherwise; they can send you a new code.`, 'Unlink store?');
  if (!ok) return;
  try {
    await leaveStore(l.storeAccountId, l.consignorId);
    await refresh();
  } catch (err) {
    emit('error', errorText(err, 'Could not unlink.'));
  }
}

const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString();
const fmtPct = (n: number): string => `${Number(n.toFixed(2))}%`;
const venueName = (l: ArtistConsignment, id: string): string => l.venues.find((v) => v.id === id)?.name ?? 'Removed event';
function commissionLine(l: ArtistConsignment): string {
  const stores = l.venues.filter((v) => v.kind === 'store');
  const differs = stores.filter((v) => commissionFor(l, v.id) !== l.commissionPct);
  return [`${fmtPct(l.commissionPct)} commission`, ...differs.map((v) => `${fmtPct(commissionFor(l, v.id))} at ${v.name}`)].join(' · ');
}
</script>

<template>
  <div class="tab">
    <form class="link" @submit.prevent="link">
      <label>
        <span>Consign with a store</span>
        <input v-model="code" type="text" placeholder="Code from the store, e.g. 3F9A2-C71BE" autocomplete="off" autocapitalize="characters" />
      </label>
      <button type="submit" class="primary" :disabled="busy || !code.trim()"><Icon name="check" :size="14" /> Link</button>
      <p class="hint">A store that sells your work can give you a code. Linking shows you your items, sales and payouts there, and lets the store import items from your catalogue. Your own events and sales are not shared.</p>
    </form>

    <p v-if="!links" class="hint">Loading…</p>
    <p v-else-if="!links.length" class="empty">You are not linked to any store yet.</p>

    <article v-for="l in links ?? []" :key="`${l.storeAccountId}:${l.consignorId}`" class="card">
      <header>
        <div>
          <strong>{{ l.storeAccountName }}</strong>
          <p class="hint">As “{{ l.consignorName }}” · {{ commissionLine(l) }}</p>
        </div>
        <span class="grow" />
        <button type="button" class="quiet" @click="leave(l)">Unlink</button>
      </header>

      <p v-if="l.paused" class="warn">This store has switched consignment off, so nothing is shared right now.</p>
      <template v-else>
        <p v-if="l.venues.length" class="venues"><Icon name="store" :size="13" /> {{ l.venues.map((v) => (v.city ? `${v.name} (${v.city})` : v.name)).join(', ') }}</p>

        <div v-for="t in l.statement.totals" :key="t.currency" class="totals">
          <div><span>Sold</span><strong>{{ t.units }}</strong></div>
          <div><span>Your share</span><strong>{{ fmtPrice(t.artistShare, t.currency) }}</strong></div>
          <div><span>Paid to you</span><strong>{{ fmtPrice(t.paid, t.currency) }}</strong></div>
          <div :class="['owed', { due: t.balance > 0 }]"><span>{{ t.balance >= 0 ? 'Still owed' : 'Paid ahead' }}</span><strong>{{ fmtPrice(Math.abs(t.balance), t.currency) }}</strong></div>
        </div>

        <details v-if="l.items.length" open>
          <summary>Your items there ({{ l.items.length }})</summary>
          <table>
            <thead><tr><th>Item</th><th class="num">Price</th><th class="num">Sold</th><th class="num">Left</th></tr></thead>
            <tbody>
              <tr v-for="i in l.items" :key="`${i.productId}:${i.variantId}`">
                <td>{{ i.title }}<template v-if="i.variantLabel"> · {{ i.variantLabel }}</template><span v-if="i.sku" class="hint"> · {{ i.sku }}</span></td>
                <td class="num">{{ fmtPrice(i.price, l.currency) }}</td>
                <td class="num">{{ i.sold }}</td>
                <td class="num" :title="i.remaining == null ? 'The store has not counted this item' : ''">{{ i.remaining ?? '-' }}</td>
              </tr>
            </tbody>
          </table>
        </details>

        <details v-if="l.statement.byStore.length">
          <summary>Per store</summary>
          <table>
            <tbody>
              <tr v-for="r in l.statement.byStore" :key="`${r.storeId}|${r.currency}`">
                <td>{{ venueName(l, r.storeId) }}</td>
                <td class="num">{{ r.units }} sold</td>
                <td class="num">{{ fmtPrice(r.artistShare, r.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </details>

        <details v-if="l.lines.length">
          <summary>Sales ({{ l.lines.length }})</summary>
          <table>
            <tbody>
              <tr v-for="s in l.lines" :key="`${s.txId}:${s.productId}:${s.variantId}`">
                <td>{{ fmtDate(s.at) }}</td>
                <td>{{ s.title }}<template v-if="s.variantLabel"> · {{ s.variantLabel }}</template><template v-if="s.qty > 1"> × {{ s.qty }}</template></td>
                <td class="hint">{{ venueName(l, s.storeId) }}</td>
                <td class="num">{{ fmtPrice(s.artistShare, s.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </details>

        <details v-if="l.payouts.length">
          <summary>Payouts ({{ l.payouts.length }})</summary>
          <table>
            <tbody>
              <tr v-for="p in l.payouts" :key="p.id">
                <td>{{ p.date }}</td>
                <td class="num">{{ fmtPrice(p.amount, p.currency) }}</td>
                <td class="hint">{{ p.storeId ? venueName(l, p.storeId) : 'All stores' }}<template v-if="p.note"> · {{ p.note }}</template></td>
              </tr>
            </tbody>
          </table>
        </details>
      </template>
    </article>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .8rem; }
.link { display: flex; align-items: flex-end; gap: .6rem; flex-wrap: wrap; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.link label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; flex: 1 1 16rem; }
.link input { text-transform: uppercase; letter-spacing: .06em; }
.link button { min-height: 2.4rem; display: inline-flex; align-items: center; gap: .35rem; }
.link .hint { flex-basis: 100%; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); font-size: .85rem; margin: 0; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.5rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.card { display: flex; flex-direction: column; gap: .6rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.card header { display: flex; align-items: flex-start; gap: .6rem; }
.card header button { min-height: 2.2rem; font-size: .8rem; }
.grow { flex: 1; }
.venues { margin: 0; font-size: .82rem; color: var(--zfy-muted, #5a6472); display: flex; align-items: center; gap: .3rem; }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: .5rem; }
.totals div { display: flex; flex-direction: column; gap: .1rem; padding: .45rem .6rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); }
.totals span { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); }
.totals strong { font-variant-numeric: tabular-nums; }
.totals .owed.due { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
summary { cursor: pointer; font-size: .85rem; font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; margin-top: .3rem; }
th, td { padding: .35rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); text-align: left; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--zfy-muted, #5a6472); font-weight: 600; }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
