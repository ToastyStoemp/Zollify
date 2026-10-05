<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ArtistConsignment, ConsignmentFee } from '@zollify/shared';
import type { SetupMoment } from '@zollify/shared';
import { FEE_REASONS, commissionFor, fmtPrice, rentalEnd, rentalStatus } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import ShareItems from './ShareItems.vue';
import StockDialog from './StockDialog.vue';
import { acceptCode, disputeFee, errorText, leaveStore, myLinks, respondToSetup, today } from '../api';
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
/** Restocking or announcing a package for one store. */
const stocking = ref<{ link: ArtistConsignment; mode: 'restock' | 'package' } | null>(null);
function stockDone(message: string): void {
  sdk().ui.toast(message, { kind: 'success', timeoutMs: 6000 });
  void refresh();
}
const sentCount = (l: ArtistConsignment): number => (l.shipments ?? []).filter((s) => s.status === 'sent').length;

/** The store whose sharing is open, if any. */
const sharing = ref<ArtistConsignment | null>(null);
const sharingChanged = ref(false);
function closeSharing(): void {
  sharing.value = null;
  if (sharingChanged.value) void refresh();
  sharingChanged.value = false;
}
const now = today();
const fmtDay = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const upcomingSetups = (l: ArtistConsignment): SetupMoment[] => l.setups.filter((s) => s.date >= now);
const currentRentals = (l: ArtistConsignment) => l.rentals.filter((r) => rentalStatus(r, now) !== 'ended');

/** Answering a setup: a reason is only asked for when saying no. */
const replying = ref<string | null>(null);
const reply = ref('');
async function answer(l: ArtistConsignment, s: SetupMoment, status: 'confirmed' | 'declined'): Promise<void> {
  emit('error', null);
  try {
    await respondToSetup(l.storeAccountId, l.consignorId, s.id, status, status === 'declined' ? reply.value.trim() : '');
    replying.value = null;
    reply.value = '';
    sdk().ui.toast(status === 'confirmed' ? `Confirmed - ${l.storeAccountName} has been told.` : `${l.storeAccountName} has been told you can't make it.`, { kind: 'success' });
    await refresh();
  } catch (err) {
    emit('error', errorText(err, 'Could not send your answer.'));
  }
}
/** Objecting to a fee: the store owner gets the reason by notification and email. */
const objecting = ref<{ link: ArtistConsignment; fee: ConsignmentFee } | null>(null);
const objection = ref('');
async function object(): Promise<void> {
  const o = objecting.value!;
  if (!objection.value.trim()) return;
  try {
    await disputeFee(o.link.storeAccountId, o.link.consignorId, o.fee.id, objection.value.trim());
    objecting.value = null;
    objection.value = '';
    sdk().ui.toast(`${o.link.storeAccountName} has your objection.`, { kind: 'success' });
    await refresh();
  } catch (err) {
    emit('error', errorText(err, 'Could not send that.'));
  }
}
const openFees = (l: ArtistConsignment): number => (l.fees ?? []).filter((f) => f.status === 'charged').length;

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
        <button v-if="!l.paused" type="button" @click="sharing = l"><Icon name="tag" :size="14" /> Share items</button>
        <button v-if="!l.paused && l.items.length" type="button" @click="stocking = { link: l, mode: 'restock' }"><Icon name="layers" :size="14" /> Restock</button>
        <button v-if="!l.paused && l.items.length" type="button" @click="stocking = { link: l, mode: 'package' }"><Icon name="truck" :size="14" /> Send a package<em v-if="sentCount(l)" class="badge">{{ sentCount(l) }}</em></button>
        <button type="button" class="quiet" @click="leave(l)">Unlink</button>
      </header>

      <p v-if="l.paused" class="warn">This store has switched consignment off, so nothing is shared right now.</p>
      <template v-else>
        <p v-if="l.venues.length" class="venues"><Icon name="store" :size="13" /> {{ l.venues.map((v) => (v.city ? `${v.name} (${v.city})` : v.name)).join(', ') }}</p>

        <section v-if="upcomingSetups(l).length" class="setups">
          <h3>Setups</h3>
          <div v-for="s in upcomingSetups(l)" :key="s.id" :class="['setup', s.status]">
            <div class="line">
              <strong>{{ fmtDay(s.date) }} · {{ s.time }}</strong>
              <span class="hint">{{ s.durationMin }} min · {{ venueName(l, s.storeId) }}</span>
              <span :class="['pill', s.status]">{{ { scheduled: 'please reply', confirmed: 'confirmed', declined: "you can't make it", cancelled: 'cancelled by the store' }[s.status] }}</span>
            </div>
            <p v-if="s.note" class="note">{{ s.note }}</p>
            <template v-if="s.status !== 'cancelled'">
              <div v-if="replying === s.id" class="reply">
                <input v-model="reply" type="text" placeholder="Optional - suggest another time" maxlength="500" />
                <button type="button" @click="answer(l, s, 'declined')">Send</button>
                <button type="button" class="quiet" @click="replying = null">Back</button>
              </div>
              <div v-else class="reply">
                <button v-if="s.status !== 'confirmed'" type="button" class="primary" @click="answer(l, s, 'confirmed')"><Icon name="check" :size="14" /> I'll be there</button>
                <button v-if="s.status !== 'declined'" type="button" @click="replying = s.id; reply = ''">Can't make it</button>
              </div>
            </template>
          </div>
        </section>

        <p v-for="f in l.features" :key="f.id" class="featured">
          <Icon name="sparkles" :size="14" />
          <span><strong>{{ f.title || 'Artist of the month' }}</strong> · {{ f.startDate }} to {{ f.endDate }} at {{ f.storeIds.map((id) => venueName(l, id)).join(', ') }}<template v-if="f.discountPct"> · your work is {{ f.discountPct }}% off at the till</template></span>
        </p>
        <p v-for="w in l.workshops" :key="w.id" class="rental">
          <Icon name="calendar" :size="13" />
          <span><strong>{{ w.title }}</strong> - you're hosting · {{ fmtDay(w.date) }} {{ w.time }} at {{ venueName(l, w.storeId) }} · <template v-if="w.cancelled">cancelled</template><template v-else>{{ w.booked }} of {{ w.capacity }} booked</template></span>
        </p>
        <p v-for="r in currentRentals(l)" :key="r.id" class="rental">
          <Icon name="layers" :size="13" />
          <span><strong>{{ r.spaceName }}</strong> at {{ venueName(l, r.storeId) }} · {{ r.startDate }} to {{ rentalEnd(r) }} · {{ fmtPrice(r.monthlyFee, r.currency) }}/month{{ r.deductFromSales ? ', taken off your sales' : '' }}<template v-if="rentalStatus(r, now) === 'upcoming'"> · starts {{ r.startDate }}</template></span>
        </p>

        <div v-for="t in l.statement.totals" :key="t.currency" class="totals">
          <div><span>Sold</span><strong>{{ t.units }}</strong></div>
          <div><span>Your share</span><strong>{{ fmtPrice(t.artistShare, t.currency) }}</strong></div>
          <div v-if="t.cardFees"><span>Card costs</span><strong>{{ fmtPrice(t.cardFees, t.currency) }}</strong></div>
          <div v-if="t.rent"><span>Space rent</span><strong>{{ fmtPrice(t.rent, t.currency) }}</strong></div>
          <div v-if="t.fees"><span>Fees</span><strong>{{ fmtPrice(t.fees, t.currency) }}</strong></div>
          <div><span>Paid to you</span><strong>{{ fmtPrice(t.paid, t.currency) }}</strong></div>
          <div :class="['owed', { due: t.balance > 0 }]"><span>{{ t.balance >= 0 ? 'Still owed' : 'You owe' }}</span><strong>{{ fmtPrice(Math.abs(t.balance), t.currency) }}</strong></div>
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

        <details v-if="(l.fees ?? []).length" :open="openFees(l) > 0">
          <summary>Fees ({{ l.fees.length }})</summary>
          <ul class="fees">
            <li v-for="f in l.fees" :key="f.id" :class="{ waived: f.status === 'waived' }">
              <span>{{ f.date }}</span>
              <strong>{{ fmtPrice(f.amount, f.currency) }}</strong>
              <span class="hint grow">{{ FEE_REASONS[f.reason] }}<template v-if="f.note"> · {{ f.note }}</template><template v-if="f.status === 'waived'"> · waived<template v-if="f.waiveNote"> - {{ f.waiveNote }}</template></template></span>
              <span v-if="f.dispute && f.status === 'charged'" class="hint">You objected</span>
              <button v-else-if="f.status === 'charged'" type="button" class="quiet" @click="objecting = { link: l, fee: f }; objection = ''">Object</button>
            </li>
          </ul>
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
    <ModalShell v-if="objecting" :title="`Object to a fee of ${fmtPrice(objecting.fee.amount, objecting.fee.currency)}`" @close="objecting = null">
      <div class="object">
        <p class="hint">{{ objecting.link.storeAccountName }} charged it for “{{ FEE_REASONS[objecting.fee.reason] }}”<template v-if="objecting.fee.note"> ({{ objecting.fee.note }})</template>. Say why you think it is wrong - they get it by notification and email, and can waive it.</p>
        <textarea v-model="objection" rows="3" placeholder="I was there at 10, but the shop was closed." aria-label="Your objection" />
      </div>
      <template #footer><div class="foot"><button type="button" @click="objecting = null">Cancel</button><button type="button" class="primary" :disabled="!objection.trim()" @click="object">Send</button></div></template>
    </ModalShell>

    <ModalShell v-if="stocking" :title="stocking.mode === 'restock' ? `Restock at ${stocking.link.storeAccountName}` : `Package for ${stocking.link.storeAccountName}`" @close="stocking = null">
      <StockDialog :link="stocking.link" :mode="stocking.mode" @done="stockDone" @close="stocking = null" />
    </ModalShell>

    <ModalShell v-if="sharing" :title="`Share with ${sharing.storeAccountName}`" @close="closeSharing">
      <ShareItems :store-account-id="sharing.storeAccountId" :consignor-id="sharing.consignorId" :store-name="sharing.storeAccountName" @changed="sharingChanged = true" />
      <template #footer><div class="foot"><button type="button" class="primary" @click="closeSharing">Done</button></div></template>
    </ModalShell>
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
.card header button { min-height: 2.2rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.foot { display: flex; justify-content: flex-end; gap: .5rem; }
.badge { font-style: normal; font-size: .66rem; padding: 0 .35rem; border-radius: 999px; background: var(--zfy-signal-soft, #e4ecf6); }
.card header { flex-wrap: wrap; }
.grow { flex: 1; }
.setups { display: flex; flex-direction: column; gap: .5rem; padding: .7rem .8rem; border-radius: 10px; background: var(--zfy-signal-soft, #e4ecf6); }
.setups h3 { margin: 0; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; }
.setup { display: flex; flex-direction: column; gap: .35rem; }
.setup + .setup { border-top: 1px solid var(--zfy-line, #d6dde4); padding-top: .5rem; }
.setup.cancelled strong { text-decoration: line-through; color: var(--zfy-muted, #5a6472); }
.setup .line { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .88rem; }
.setup .note { margin: 0; font-size: .85rem; }
.reply { display: flex; gap: .4rem; flex-wrap: wrap; }
.reply input { flex: 1 1 14rem; }
.reply button { min-height: 2.2rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.pill { font-size: .64rem; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; border-radius: 999px; padding: .12rem .45rem; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); }
.pill.confirmed { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.pill.scheduled { background: var(--zfy-warning, #e0a63a); color: #1a2230; }
.featured { margin: 0; font-size: .86rem; display: flex; align-items: center; gap: .4rem; padding: .5rem .7rem; border-radius: 10px; background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.rental { margin: 0; font-size: .84rem; display: flex; align-items: center; gap: .35rem; }
.venues { margin: 0; font-size: .82rem; color: var(--zfy-muted, #5a6472); display: flex; align-items: center; gap: .3rem; }
.fees { list-style: none; margin: .4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.fees li { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; font-size: .85rem; }
.fees li.waived strong { text-decoration: line-through; color: var(--zfy-muted, #5a6472); }
.fees button { min-height: 2rem; padding: .1rem .6rem; font-size: .78rem; }
.object { display: flex; flex-direction: column; gap: .6rem; }
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
