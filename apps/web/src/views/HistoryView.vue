<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  activeEventId,
  csvFilename,
  transactionsToCsv,
  currentAccount,
  getSalesEvent,
  pendingConfirm,
  recentTransactions,
  revertTransaction,
  totalsFor,
  visibleEvents,
} from '@boothly/platform';

const account = currentAccount;
const scope = ref<string>('all');
const error = ref<string | null>(null);
const expanded = ref<Set<string>>(new Set());

const canRevert = computed(
  () => account.value?.role === 'owner' || account.value?.role === 'admin',
);

const filtered = computed(() => {
  if (scope.value === 'all') return recentTransactions.value;
  return recentTransactions.value.filter((tx) => tx.eventId === scope.value);
});

const totals = computed(() => totalsFor(scope.value === 'all' ? null : scope.value));

function eventName(id: string): string {
  if (!id) return 'No event';
  return getSalesEvent(id)?.name ?? 'Removed event';
}

/**
 * Exports what the current filter shows, so the file matches the screen the
 * user is looking at rather than silently exporting everything.
 */
function exportCsv(): void {
  const csv = transactionsToCsv(filtered.value);
  const name = scope.value === 'all' ? null : eventName(scope.value);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = csvFilename(name);
  link.click();
  URL.revokeObjectURL(url);
}

function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

async function revert(id: string, total: number, currency: string): Promise<void> {
  error.value = null;
  const ok = await new Promise<boolean>((resolve) => {
    pendingConfirm.current = {
      title: 'Revert this sale',
      message:
        `Revert ${currency} ${total.toFixed(2)}? The sale stays in the history marked as ` +
        'reverted — a till record is never deleted.',
      resolve(answer) {
        pendingConfirm.current = null;
        resolve(answer);
      },
    };
  });
  if (!ok) return;

  try {
    await revertTransaction(id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not revert that sale.';
  }
}
</script>

<template>
  <section class="history">
    <header>
      <h1>History</h1>
      <button type="button" :disabled="!filtered.length" @click="exportCsv">Export CSV</button>
      <label class="scope">
        <span>Event</span>
        <select v-model="scope">
          <option value="all">All events</option>
          <option v-for="event in visibleEvents" :key="event.id" :value="event.id">
            {{ event.name }}{{ event.id === activeEventId ? ' (active)' : '' }}
          </option>
        </select>
      </label>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <ul v-if="totals.length" class="totals">
      <li v-for="total in totals" :key="total.currency">
        <span class="label">{{ total.currency }}</span>
        <strong>{{ total.gross.toFixed(2) }}</strong>
        <span class="sub">{{ total.sales }} sale{{ total.sales === 1 ? '' : 's' }}</span>
        <!-- Shown separately rather than netted off: at cash-up you need both
             what was taken and what was handed back. -->
        <span v-if="total.reverted > 0" class="sub reverted">
          −{{ total.reverted.toFixed(2) }} reverted
        </span>
      </li>
    </ul>

    <p v-if="!filtered.length" class="empty">
      No sales recorded yet{{ scope === 'all' ? '' : ' for that event' }}.
    </p>

    <ul v-else class="txs">
      <li v-for="tx in filtered" :key="tx.id" :class="{ reverted: tx.revertedAt }">
        <button type="button" class="row" @click="toggle(tx.id)">
          <span class="when">{{ when(tx.timestamp) }}</span>
          <span class="event">{{ eventName(tx.eventId) }}</span>
          <span class="method">{{ tx.method }}</span>
          <span class="amount">{{ tx.currency }} {{ tx.total.toFixed(2) }}</span>
          <span v-if="tx.revertedAt" class="badge">reverted</span>
        </button>

        <div v-if="expanded.has(tx.id)" class="detail">
          <ul class="items">
            <li v-for="(item, i) in tx.items" :key="i">
              <span>{{ item.qty }} × {{ item.title }}</span>
              <span class="line">{{ item.lineTotal.toFixed(2) }}</span>
            </li>
          </ul>
          <p class="ref">
            <span v-for="(leg, i) in tx.payments" :key="i">
              {{ leg.provider ?? leg.kind }}{{ leg.cardBrand ? ` · ${leg.cardBrand}` : '' }}
              {{ leg.txRef ? ` · ${leg.txRef}` : '' }}
            </span>
          </p>
          <button
            v-if="canRevert && !tx.revertedAt"
            type="button"
            @click="revert(tx.id, tx.total, tx.currency)"
          >
            Revert sale
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.history { display: flex; flex-direction: column; gap: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
h1 { margin: 0; font-size: 1.35rem; }
.scope { display: flex; align-items: center; gap: .5rem; font-size: .875rem; }
.empty { color: var(--bly-muted, #5a6472); margin: 0; }
.error { color: var(--bly-danger, #c6512f); margin: 0; }
.totals { list-style: none; margin: 0; padding: 0; display: flex; gap: .75rem; flex-wrap: wrap; }
.totals li { border: 1px solid var(--bly-line, #d6dde4); border-radius: 10px; padding: .6rem .9rem; background: var(--bly-surface, #fff); display: flex; flex-direction: column; gap: .1rem; min-width: 9rem; }
.totals .label { font-size: .75rem; letter-spacing: .06em; color: var(--bly-muted, #5a6472); }
.totals strong { font-size: 1.25rem; font-variant-numeric: tabular-nums; }
.totals .sub { font-size: .78rem; color: var(--bly-muted, #5a6472); }
.totals .sub.reverted { color: var(--bly-danger, #c6512f); }
.txs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
.txs li { border: 1px solid var(--bly-line, #d6dde4); border-radius: 10px; background: var(--bly-surface, #fff); overflow: hidden; }
.txs li.reverted .row { opacity: .6; }
.row { display: grid; grid-template-columns: 12rem 1fr 5rem 7rem auto; gap: .75rem; align-items: center; width: 100%; text-align: left; border: 0; background: transparent; padding: .6rem .85rem; font-size: .9rem; }
.row:hover { background: var(--bly-surface-2, #e9edf1); }
.when { font-variant-numeric: tabular-nums; color: var(--bly-muted, #5a6472); }
.amount { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.badge { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--bly-danger, #c6512f); }
.detail { border-top: 1px solid var(--bly-line, #d6dde4); padding: .75rem .85rem; display: flex; flex-direction: column; gap: .5rem; align-items: flex-start; }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .2rem; width: 100%; font-size: .85rem; }
.items li { display: flex; justify-content: space-between; }
.line { font-variant-numeric: tabular-nums; }
.ref { margin: 0; font-size: .78rem; color: var(--bly-muted, #5a6472); display: flex; gap: .75rem; flex-wrap: wrap; }
@media (max-width: 760px) { .row { grid-template-columns: 1fr auto; } .event, .method { display: none; } }
</style>
