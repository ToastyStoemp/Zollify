<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { Signup, Workshop } from '@zollify/shared';
import { SIGNUP_REF_KIND, fmtPrice, isStore, workshopLineSplit } from '@zollify/shared';
import { addSignup, errorText, tillWorkshops, today } from '../api';
import { sdk } from '../runtime';

/**
 * Over the till: take payment for a workshop. Pick someone who is booked and
 * has not paid, or sell a place to someone at the counter; their places go
 * in the cart like any item, and once the sale is through the sign-up list
 * shows them paid. A refund at the till un-pays them again.
 */
const emit = defineEmits<{ close: [] }>();

type Row = Workshop & { booked: number; unpaid: Signup[] };
const store = computed(() => sdk().data.events.active());
const rows = ref<Row[] | null>(null);
const error = ref<string | null>(null);

/** Paid on this device but maybe not synced yet - never offered twice. */
const paidHere = computed(() => {
  const ids = new Set<string>();
  for (const tx of sdk().data.transactions.recent()) {
    if (tx.revertedAt) continue;
    for (const item of tx.items) if (item.ref?.kind === SIGNUP_REF_KIND) ids.add(item.ref.id);
  }
  return ids;
});

async function refresh(): Promise<void> {
  if (!store.value || !isStore(store.value)) return;
  try {
    rows.value = await tillWorkshops(store.value.id);
  } catch (err) {
    error.value = errorText(err, 'Could not load workshops - this needs a connection.');
  }
}
onMounted(refresh);

const now = today();
const fmtDay = (d: string): string => (d === now ? 'Today' : new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }));
const unpaid = (w: Row): Signup[] => w.unpaid.filter((s) => !paidHere.value.has(s.id));

function charge(w: Row, s: Signup): void {
  const added = sdk().till.addLine({
    key: `signup:${s.id}`,
    name: `${w.title} · ${s.name}`,
    qty: s.seats,
    unitPrice: w.price,
    ...workshopLineSplit(w),
    ref: { kind: SIGNUP_REF_KIND, id: s.id },
  });
  if (added) emit('close');
}

// ── Someone at the counter ──────────────────────────────────────────────────
const walkInFor = ref<string | null>(null);
const walkIn = reactive({ name: '', email: '', seats: '1' });
const busy = ref(false);
async function sellPlace(w: Row): Promise<void> {
  if (!walkIn.name.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    // Booked first, so the place is really theirs - then charged.
    const { signup } = await addSignup(w.id, { name: walkIn.name.trim(), email: walkIn.email.trim(), seats: Math.max(1, Math.floor(Number(walkIn.seats) || 1)), note: '', paid: false });
    if (signup.status !== 'booked') {
      error.value = `${signup.name} is on the waitlist - the workshop is full, so there is nothing to charge yet.`;
      await refresh();
      return;
    }
    charge(w, signup);
  } catch (err) {
    error.value = errorText(err, 'Could not book the place.');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="till-workshops">
    <p v-if="!store || !isStore(store)" class="hint">Open a store's till to take payment for its workshops.</p>
    <template v-else>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="!rows && !error" class="hint">Loading…</p>
      <p v-else-if="rows && !rows.length" class="hint">No workshops at {{ store.name }}.</p>
      <article v-for="w in rows ?? []" :key="w.id" class="ws">
        <header>
          <strong>{{ w.title }}</strong>
          <span class="hint">{{ fmtDay(w.date) }} · {{ w.time }} · {{ w.price ? `${fmtPrice(w.price, w.currency)} a place` : 'free' }} · {{ w.booked }}/{{ w.capacity }}</span>
        </header>
        <template v-if="w.price > 0">
          <p v-if="!unpaid(w).length" class="hint">Everyone booked has paid.</p>
          <button v-for="s in unpaid(w)" :key="s.id" type="button" class="person" @click="charge(w, s)">
            <span>{{ s.name }}<template v-if="s.seats > 1"> × {{ s.seats }}</template></span>
            <strong>{{ fmtPrice(w.price * s.seats, w.currency) }}</strong>
          </button>
          <div v-if="walkInFor === w.id" class="walkin">
            <input v-model="walkIn.name" type="text" placeholder="Name" aria-label="Name" />
            <input v-model="walkIn.email" type="email" placeholder="Email (optional)" aria-label="Email" />
            <input v-model="walkIn.seats" type="number" min="1" step="1" inputmode="numeric" aria-label="Places" class="seats" />
            <button type="button" class="primary" :disabled="busy || !walkIn.name.trim()" @click="sellPlace(w)">Book and charge</button>
          </div>
          <button v-else-if="w.booked < w.capacity" type="button" class="quiet" @click="walkInFor = w.id; Object.assign(walkIn, { name: '', email: '', seats: '1' })">+ Sell a place to someone here</button>
          <p v-else class="hint">Full.</p>
        </template>
      </article>
    </template>
  </div>
</template>

<style scoped>
.till-workshops { display: flex; flex-direction: column; gap: .8rem; }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .84rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); }
.ws { display: flex; flex-direction: column; gap: .4rem; padding-bottom: .7rem; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.ws:last-child { border-bottom: 0; }
.ws header { display: flex; flex-direction: column; gap: .1rem; }
.person { display: flex; justify-content: space-between; align-items: center; gap: .6rem; width: 100%; min-height: 2.8rem; padding: .4rem .8rem; text-align: left; font-weight: 400; }
.walkin { display: flex; gap: .4rem; flex-wrap: wrap; }
.walkin input { flex: 1 1 8rem; }
.walkin .seats { flex: 0 0 4.5rem; }
</style>
