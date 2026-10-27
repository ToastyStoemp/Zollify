<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { loyaltyUnit, rewardLabel, fmtPrice, type LoyaltySettings } from '@zollify/shared';
import { Icon, QrCode } from '@zollify/ui';
import { api, errorText, type LedgerRow, type MemberView } from '../api';
import { sdk } from '../runtime';

/**
 * The members: who has a card, where they stand, when they last earned.
 * Stamps given or taken by hand, a member erased on request, the ledger
 * recounted from the sales, and the join QR to print for the table.
 */
const members = ref<MemberView[]>([]);
const settings = ref<LoyaltySettings | null>(null);
const joinUrl = ref('');
const currency = ref('EUR');
const query = ref('');
const open = ref<{ member: MemberView; ledger: LedgerRow[] } | null>(null);
const adjust = ref({ delta: '1', note: '' });
/** A hand entry being changed: its id, and the amount and note as typed. */
const editing = ref<{ id: string; amount: string; note: string } | null>(null);
const error = ref<string | null>(null);
const loaded = ref(false);
const showQr = ref(false);

async function load(): Promise<void> {
  try {
    const [s, m] = await Promise.all([api.settings(), api.members()]);
    settings.value = s.settings;
    joinUrl.value = s.joinUrl;
    currency.value = s.currency;
    members.value = m.members;
  } catch (err) {
    error.value = errorText(err, 'Could not load the members - this needs a connection.');
  } finally {
    loaded.value = true;
  }
}
onMounted(load);

const money = (n: number) => fmtPrice(n, currency.value);
const unit = (n: number) => (settings.value ? loyaltyUnit(settings.value, n) : 'stamps');
const list = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? members.value.filter((m) => `${m.name} ${m.email} ${m.code}`.toLowerCase().includes(q)) : members.value;
});
const totals = computed(() => ({ members: members.value.length, balance: members.value.reduce((s, m) => s + m.standing.balance, 0), rewards: members.value.reduce((s, m) => s + m.standing.rewards, 0) }));
const when = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'never');

async function show(m: MemberView): Promise<void> {
  try {
    open.value = await api.member(m.id);
    adjust.value = { delta: '1', note: '' };
  } catch (err) {
    error.value = errorText(err, 'Could not load that member.');
  }
}
async function giveOrTake(sign: 1 | -1): Promise<void> {
  if (!open.value) return;
  const n = Math.round(Number(adjust.value.delta)) * sign;
  if (!n) return void (error.value = 'How many?');
  try {
    const res = await api.adjust(open.value.member.id, n, adjust.value.note.trim());
    members.value = members.value.map((m) => (m.id === res.member.id ? res.member : m));
    await show(res.member);
    sdk().ui.toast(`${Math.abs(n)} ${unit(Math.abs(n))} ${n > 0 ? 'given' : 'taken'}.`, { kind: 'success' });
  } catch (err) {
    error.value = errorText(err, 'Could not change that.');
  }
}
const byText = (l: LedgerRow): string => (l.by ? (l.by.email ?? 'a removed user').split('@')[0]! : '');
async function saveEntry(): Promise<void> {
  if (!open.value || !editing.value) return;
  const amount = Math.round(Number(editing.value.amount));
  if (!amount) return void (error.value = 'An entry needs an amount other than zero - remove it instead.');
  try {
    const res = await api.editLedger(editing.value.id, amount, editing.value.note.trim());
    open.value = { member: { ...open.value.member, standing: res.standing }, ledger: res.ledger };
    members.value = members.value.map((m) => (m.id === open.value!.member.id ? open.value!.member : m));
    editing.value = null;
  } catch (err) {
    error.value = errorText(err, 'Could not change that entry.');
  }
}
async function removeEntry(l: LedgerRow): Promise<void> {
  if (!open.value) return;
  if (!(await sdk().ui.confirm(`${l.amount > 0 ? '+' : ''}${l.amount} ${l.note ? `(${l.note})` : ''} is taken out of the card's count.`, 'Remove this entry?', { confirm: 'Remove' }))) return;
  try {
    const res = await api.removeLedger(l.id);
    open.value = { member: { ...open.value.member, standing: res.standing }, ledger: res.ledger };
    members.value = members.value.map((m) => (m.id === open.value!.member.id ? open.value!.member : m));
  } catch (err) {
    error.value = errorText(err, 'Could not remove that entry.');
  }
}
async function erase(m: MemberView): Promise<void> {
  if (!(await sdk().ui.confirm(`${m.name || m.email}'s card, email and ${unit(2)} are deleted. Their past sales stay as sales.`, 'Erase this member?', { confirm: 'Erase' }))) return;
  try {
    await api.erase(m.id);
    members.value = members.value.filter((x) => x.id !== m.id);
    if (open.value?.member.id === m.id) open.value = null;
  } catch (err) {
    error.value = errorText(err, 'Could not erase that member.');
  }
}
async function recount(): Promise<void> {
  if (!(await sdk().ui.confirm('Every member\'s stamps are counted again from the sales on record, with the rules as they are now. Stamps given by hand stay.', 'Recount from the sales?', { confirm: 'Recount' }))) return;
  try {
    const res = await api.recount();
    sdk().ui.toast(`Recounted ${res.members} member${res.members === 1 ? '' : 's'}.`, { kind: 'success' });
    await load();
    if (open.value) await show(open.value.member);
  } catch (err) {
    error.value = errorText(err, 'Could not recount.');
  }
}
function printQr(): void {
  const w = window.open('', '_blank', 'width=480,height=640');
  if (!w) return;
  const img = document.querySelector<HTMLImageElement>('.joinqr img');
  const title = settings.value?.programme || 'Loyalty card';
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  w.document.write(`<!doctype html><title>${esc(title)}</title><body style="font-family:system-ui;text-align:center;padding:24px"><h1 style="font-size:1.6rem">${esc(title)}</h1><p>${esc(settings.value ? rewardLabel(settings.value, money) : '')}</p>${img ? `<img src="${img.src}" style="width:260px;height:260px">` : ''}<p style="font-size:.9rem;color:#555">Scan to get your card</p></body>`);
  w.document.close();
  w.focus();
  w.print();
}
</script>

<template>
  <section class="members">
    <header class="top">
      <div>
        <h1>Loyalty</h1>
        <p class="lede">Who has a card and where they stand. <template v-if="settings">{{ rewardLabel(settings, money) }}.</template> The programme itself is under Settings → Loyalty card.</p>
      </div>
      <div class="acts">
        <button type="button" @click="showQr = !showQr"><Icon name="scan" :size="14" /> Join QR</button>
        <button type="button" class="quiet" @click="recount">Recount from sales</button>
      </div>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <article v-if="showQr && joinUrl" class="card joinqr">
      <h2>Join from the table</h2>
      <p class="hint">Customers scan this, enter their email, and get their card. Print it for the booth.</p>
      <QrCode :value="joinUrl" :size="220" label="Join QR code" />
      <p class="url">{{ joinUrl }}</p>
      <div class="acts"><button type="button" @click="printQr">Print</button></div>
    </article>

    <ul v-if="loaded" class="tiles">
      <li><span class="label">Members</span><strong>{{ totals.members }}</strong></li>
      <li><span class="label">{{ unit(2) }} out there</span><strong>{{ totals.balance }}</strong></li>
      <li><span class="label">Rewards owed</span><strong>{{ totals.rewards }}</strong></li>
    </ul>

    <div class="two">
      <article class="card">
        <div class="bar">
          <input v-model="query" type="search" placeholder="Name, email or code" aria-label="Search members" />
        </div>
        <p v-if="loaded && !members.length" class="hint">No members yet. Put the join QR on the table.</p>
        <div v-else-if="list.length" class="table-scroll">
          <table>
            <thead><tr><th>Member</th><th class="num">{{ unit(2) }}</th><th class="num">Rewards</th><th>Last earned</th><th></th></tr></thead>
            <tbody>
              <tr v-for="m in list" :key="m.id" :class="{ on: open?.member.id === m.id }" @click="show(m)">
                <td><strong>{{ m.name || m.email }}</strong><span v-if="m.name" class="sub"> · {{ m.email }}</span></td>
                <td class="num">{{ m.standing.balance }}</td>
                <td class="num">{{ m.standing.rewards || '-' }}</td>
                <td class="sub">{{ when(m.lastEarnedAt) }}</td>
                <td class="num"><button type="button" class="quiet danger" aria-label="Erase member" @click.stop="erase(m)"><Icon name="trash" :size="13" /></button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article v-if="open" class="card">
        <h2>{{ open.member.name || open.member.email }}</h2>
        <p class="hint">{{ open.member.email }} · {{ open.member.code }} · joined {{ when(open.member.joinedAt) }}</p>
        <p class="big">{{ open.member.standing.balance }} <small>{{ unit(open.member.standing.balance) }}</small> <span v-if="open.member.standing.rewards" class="sub">· {{ open.member.standing.rewards }} reward{{ open.member.standing.rewards === 1 ? '' : 's' }} to use</span></p>
        <div class="adjust">
          <input v-model="adjust.delta" type="number" min="1" step="1" aria-label="How many" />
          <input v-model="adjust.note" type="text" maxlength="200" placeholder="Why (optional)" aria-label="Why" />
          <button type="button" @click="giveOrTake(1)">Give</button>
          <button type="button" class="quiet" @click="giveOrTake(-1)">Take</button>
        </div>
        <ul class="ledger">
          <li v-for="l in open.ledger" :key="l.id">
            <template v-if="editing?.id === l.id">
              <form class="editrow" @submit.prevent="saveEntry">
                <input v-model="editing.amount" type="number" step="1" aria-label="Amount" />
                <input v-model="editing.note" type="text" maxlength="200" aria-label="Note" />
                <button type="submit" class="primary">Save</button>
                <button type="button" class="quiet" @click="editing = null">Cancel</button>
              </form>
            </template>
            <template v-else>
              <span>{{ when(l.at) }}</span>
              <span class="sub">{{ l.saleId ? (l.amount < 0 ? 'reward used' : 'sale') : l.note || 'by hand' }}<template v-if="byText(l)"> · {{ byText(l) }}</template></span>
              <strong :class="l.amount < 0 ? 'bad' : 'good'">{{ l.amount > 0 ? '+' : '' }}{{ l.amount }}</strong>
              <span v-if="!l.saleId" class="rowacts">
                <button type="button" class="quiet" aria-label="Change entry" @click="editing = { id: l.id, amount: String(l.amount), note: l.note }">Edit</button>
                <button type="button" class="quiet danger" aria-label="Remove entry" @click="removeEntry(l)"><Icon name="x" :size="12" /></button>
              </span>
            </template>
          </li>
        </ul>
      </article>
    </div>
  </section>
</template>

<style scoped>
.members { display: flex; flex-direction: column; gap: 1rem; }
.top { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
h1 { margin: 0; font-size: 1.35rem; }
h2 { margin: 0; font-size: 1.05rem; }
.lede, .hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .9rem; max-width: 70ch; }
.error { color: var(--zfy-danger, #c6512f); margin: 0; }
.acts { display: flex; gap: .4rem; flex-wrap: wrap; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; padding: 1rem; background: var(--zfy-surface, #fff); display: flex; flex-direction: column; gap: .75rem; min-width: 0; }
.joinqr { align-items: center; text-align: center; }
.url { margin: 0; font-size: .78rem; color: var(--zfy-muted, #5a6472); word-break: break-all; }
.tiles { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .6rem; }
.tiles li { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.tiles .label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
.tiles strong { font-size: 1.3rem; }
.two { display: grid; grid-template-columns: 3fr 2fr; gap: 1rem; align-items: start; }
.bar input { width: 100%; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); font-size: .9rem; white-space: nowrap; }
td:first-child { white-space: normal; }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); }
tbody tr { cursor: pointer; }
tbody tr.on td { background: var(--zfy-accent-soft, #e6f3f0); }
tbody tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.sub { color: var(--zfy-muted, #5a6472); font-size: .82rem; }
.big { margin: 0; font-size: 1.8rem; font-weight: 800; color: var(--zfy-accent-ink, #0a5a4a); }
.big small { font-size: .95rem; font-weight: 600; }
.adjust { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) auto auto; gap: .4rem; align-items: center; }
.adjust input { min-width: 0; }
.ledger { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; font-size: .875rem; }
.ledger li { display: grid; grid-template-columns: auto 1fr auto auto; gap: .6rem; align-items: center; }
.ledger li:has(> form) { grid-template-columns: 1fr; }
.editrow { display: grid; grid-template-columns: 5rem minmax(0, 1fr) auto auto; gap: .4rem; align-items: center; }
.rowacts { display: flex; gap: .2rem; }
.rowacts .quiet { min-height: 1.8rem; padding: 0 .4rem; font-size: .78rem; }
.good { color: var(--zfy-accent-ink, #0a5a4a); }
.bad { color: var(--zfy-danger, #c6512f); }
@media (max-width: 800px) { .two { grid-template-columns: 1fr; } .adjust { grid-template-columns: 4rem 1fr; } }
</style>
