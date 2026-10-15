<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { fmtPrice, localIsoDay, type DayJournal } from '@zollify/shared';
import { bookDay, errorText, freeDay, loadDay, loadDays, loadSettings, type Connection, type DaySummary } from '../api';

/**
 * The last weeks of trading, a day per row: what it takes in, whether it
 * reached e-conomic, and the journal lines it would book. A day books once it
 * is over and nothing is missing.
 */
const days = ref<DaySummary[]>([]);
const conn = ref<Connection | null>(null);
const open = ref<string | null>(null);
const journal = ref<DayJournal | null>(null);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);

const shift = (n: number) => localIsoDay(Date.now() + n * 86_400_000);

async function refresh(): Promise<void> {
  try {
    [days.value, conn.value] = await Promise.all([loadDays(shift(-45), shift(0)).then((r) => r.days), loadSettings()]);
  } catch (err) {
    error.value = errorText(err, 'Could not load the days.');
  }
}
onMounted(refresh);

async function toggle(day: string): Promise<void> {
  if (open.value === day) {
    open.value = null;
    return;
  }
  open.value = day;
  journal.value = null;
  journal.value = (await loadDay(day)).journal;
}

async function book(day: string): Promise<void> {
  error.value = null;
  busy.value = day;
  try {
    await bookDay(day);
  } catch (err) {
    error.value = errorText(err, 'Could not book the day.');
  } finally {
    busy.value = null;
    await refresh();
  }
}

async function free(d: DaySummary): Promise<void> {
  const ask =
    d.booking?.status === 'booked'
      ? `Only do this if voucher ${d.booking.voucherNumber ?? ''} was deleted in e-conomic. Mark ${d.day} as not booked?`
      : `Check the e-conomic journal first: is there no voucher for ${d.day}? Mark it as not booked?`;
  if (!confirm(ask)) return;
  await freeDay(d.day);
  await refresh();
}

const money = (n: number, c: string | null) => (c ? fmtPrice(n, c) : n.toFixed(2));
</script>

<template>
  <section class="days">
    <h1>e-conomic</h1>
    <p class="hint">Each day of sales goes into your e-conomic journal as one voucher, for your accountant to post. e-conomic does the VAT return from it.</p>
    <p v-if="conn && !conn.server" class="error" role="alert">This server is not registered with e-conomic yet - you can preview days, not book them.</p>
    <p v-else-if="conn && !conn.grant" class="error" role="alert">
      Connect your e-conomic agreement under <router-link :to="{ name: 'settings', query: { panel: 'economic.economic' } }">Settings → e-conomic</router-link>.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="!days.length" class="hint">No sales in the last 45 days.</p>

    <ul>
      <li v-for="d in days" :key="d.day">
        <div class="row">
          <button type="button" class="day quiet" :aria-expanded="open === d.day" @click="toggle(d.day)">
            <strong>{{ d.day }}</strong>
            <span>{{ money(d.total, d.currency) }}</span>
            <span class="muted">{{ d.sales }} sales<template v-if="d.reversals">, {{ d.reversals }} reverted</template></span>
          </button>
          <span v-if="d.booking?.status === 'booked'" class="ok">Voucher {{ d.booking.voucherNumber }}</span>
          <span v-else-if="d.booking?.status === 'pending'" class="error">Unknown - check e-conomic</span>
          <span v-else-if="d.open" class="muted">Still trading</span>
          <span v-else-if="d.problems.length" class="error">{{ d.problems.length }} to fix</span>
          <button v-if="!d.booking && !d.open && !d.problems.length" type="button" class="primary" :disabled="busy !== null || !conn?.server || !conn?.grant" @click="book(d.day)">
            {{ busy === d.day ? 'Booking…' : 'Book' }}
          </button>
          <button v-if="d.booking" type="button" class="quiet" @click="free(d)">Not booked</button>
        </div>
        <div v-if="open === d.day" class="detail">
          <p v-if="d.booking?.note" class="error">{{ d.booking.note }}</p>
          <ul v-if="d.problems.length" class="problems"><li v-for="p in d.problems" :key="p">{{ p }}</li></ul>
          <table v-if="journal">
            <thead><tr><th>Account</th><th>Text</th><th>VAT</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
            <tbody>
              <tr v-for="l in journal.lines" :key="l.key + (l.vatCode ?? '')">
                <td>{{ l.account ?? '-' }}</td>
                <td>{{ l.text }}</td>
                <td>{{ l.vatCode ?? '' }}</td>
                <td class="num">{{ l.amount > 0 ? money(l.amount, journal.currency) : '' }}</td>
                <td class="num">{{ l.amount < 0 ? money(-l.amount, journal.currency) : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.days { display: flex; flex-direction: column; gap: .7rem; max-width: 46rem; }
h1 { margin: 0; font-size: 1.2rem; }
.hint, .muted { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .85rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .85rem; }
.ok { color: var(--zfy-accent-ink, #0a5a4a); font-size: .85rem; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
.day { display: flex; gap: .8rem; align-items: baseline; flex: 1; text-align: left; }
.detail { padding: .4rem 0 .6rem; overflow-x: auto; }
.problems { list-style: disc; padding-left: 1.2rem; color: var(--zfy-danger, #c6512f); font-size: .85rem; }
table { border-collapse: collapse; font-size: .85rem; width: 100%; }
th, td { padding: .25rem .5rem; border-bottom: 1px solid var(--zfy-line, #e2e5ea); text-align: left; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
