<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { ConsignmentRental, ConsignmentSpace, SetupMoment } from '@zollify/shared';
import { addMonths, fmtPrice, nextPeriodStart, occupancy, rentalEnd, rentalStatus } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import {
  bookRental,
  cancelSetup,
  consignors,
  deleteRental,
  deleteSpace,
  deliveryText,
  editRental,
  endRental,
  errorText,
  loadPlanner,
  moveSetup,
  plannerStoreId as storeId,
  saveSpace,
  scheduleSetup,
  stores,
  today,
  upgradeRental,
  type Planner,
} from '../api';
import { sdk } from '../runtime';

/**
 * The planner, per store: the spaces it rents to artists, who has which one
 * month by month, and when artists come in to set up. Booking a setup tells
 * the artist in Zollify and by email; their answer comes back to the bell.
 */
const emit = defineEmits<{ error: [message: string | null] }>();

const data = ref<Planner | null>(null);
watch(
  stores,
  (list) => {
    if (!list.some((s) => s.id === storeId.value)) storeId.value = list[0]?.id ?? '';
  },
  { immediate: true },
);

async function refresh(): Promise<void> {
  try {
    data.value = await loadPlanner();
  } catch (err) {
    emit('error', errorText(err, 'Could not load the planner.'));
  }
}
onMounted(refresh);

async function guard(work: () => Promise<unknown>, fallback: string): Promise<boolean> {
  emit('error', null);
  try {
    await work();
    await refresh();
    return true;
  } catch (err) {
    emit('error', errorText(err, fallback));
    return false;
  }
}

const now = today();
const currency = computed(() => sdk().account()?.profile.defaultCurrency ?? 'CHF');
const nameOf = (id: string): string => consignors.value.find((c) => c.id === id)?.name ?? 'Removed artist';
const activeArtists = computed(() =>
  consignors.value.filter((c) => !c.archived && (c.storeIds.includes(storeId.value) || !c.storeIds.length)).sort((a, b) => a.name.localeCompare(b.name)),
);
const spaces = computed(() => (data.value?.spaces ?? []).filter((s) => s.storeId === storeId.value && !s.archived));
const allSpaces = computed(() => (data.value?.spaces ?? []).filter((s) => s.storeId === storeId.value));
const spaceName = (id: string): string => data.value?.spaces.find((s) => s.id === id)?.name ?? 'Space';
const rentals = computed(() =>
  (data.value?.rentals ?? [])
    .filter((r) => r.storeId === storeId.value)
    .sort((a, b) => nameOf(a.consignorId).localeCompare(nameOf(b.consignorId)) || a.startDate.localeCompare(b.startDate)),
);
const usedNow = computed(() => occupancy(rentals.value, now));

// ── Timeline ────────────────────────────────────────────────────────────────
const offset = ref(-2);
const months = computed(() => Array.from({ length: 12 }, (_, i) => addMonths(`${now.slice(0, 7)}-01`, offset.value + i)));
const monthLabel = (m: string): string => new Date(`${m}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
/** Rentals that touch the window, so the timeline does not list years of history. */
const visibleRentals = computed(() => {
  const first = months.value[0]!;
  const after = addMonths(months.value[months.value.length - 1]!, 1);
  return rentals.value.filter((r) => r.startDate < after && rentalEnd(r) > first);
});
const covers = (r: ConsignmentRental, month: string): boolean => r.startDate < addMonths(month, 1) && rentalEnd(r) > month;
const daysLeft = (r: ConsignmentRental): number => Math.round((Date.parse(rentalEnd(r)) - Date.parse(now)) / 86_400_000);
/** Running out soon and not followed by another rental of the same artist. */
const endingSoon = (r: ConsignmentRental): boolean =>
  rentalStatus(r, now) === 'active' &&
  daysLeft(r) <= 45 &&
  !rentals.value.some((o) => o.consignorId === r.consignorId && o.id !== r.id && o.startDate === rentalEnd(r));

// ── Spaces ──────────────────────────────────────────────────────────────────
const spacesOpen = ref(false);
const spaceForm = reactive({ id: '', name: '', monthlyFee: '', count: '1', note: '' });
function editSpace(s?: ConsignmentSpace): void {
  Object.assign(spaceForm, s
    ? { id: s.id, name: s.name, monthlyFee: String(s.monthlyFee), count: String(s.count), note: s.note }
    : { id: '', name: '', monthlyFee: '', count: '1', note: '' });
}
async function submitSpace(): Promise<void> {
  const fee = parseFloat(spaceForm.monthlyFee);
  if (!spaceForm.name.trim() || !(fee >= 0)) return emit('error', 'A space needs a name and a monthly fee.');
  const existing = data.value?.spaces.find((s) => s.id === spaceForm.id);
  const ok = await guard(
    () =>
      saveSpace(spaceForm.id || crypto.randomUUID(), {
        storeId: storeId.value,
        name: spaceForm.name.trim(),
        monthlyFee: fee,
        currency: existing?.currency ?? currency.value,
        count: Math.max(1, Math.floor(Number(spaceForm.count) || 1)),
        note: spaceForm.note.trim(),
        archived: existing?.archived ?? false,
      }),
    'Could not save the space.',
  );
  if (ok) editSpace();
}
async function archiveSpace(s: ConsignmentSpace): Promise<void> {
  await guard(async () => {
    try {
      await deleteSpace(s.id);
    } catch {
      // Rented before: keep it on record, out of the pickers.
      await saveSpace(s.id, { ...s, archived: !s.archived });
    }
  }, 'Could not remove the space.');
}

// ── Booking and changing rentals ────────────────────────────────────────────
const booking = ref(false);
const book = reactive({ consignorId: '', spaceId: '', startDate: now, months: '3', monthlyFee: '', deductFromSales: true, note: '' });
function openBooking(): void {
  Object.assign(book, { consignorId: activeArtists.value[0]?.id ?? '', spaceId: spaces.value[0]?.id ?? '', startDate: `${addMonths(`${now.slice(0, 7)}-01`, 1)}`, months: '3', note: '', deductFromSales: true });
  book.monthlyFee = String(spaces.value[0]?.monthlyFee ?? '');
  booking.value = true;
}
watch(() => book.spaceId, (id) => {
  const s = data.value?.spaces.find((x) => x.id === id);
  if (s && booking.value) book.monthlyFee = String(s.monthlyFee);
});
async function submitBooking(): Promise<void> {
  const space = data.value?.spaces.find((s) => s.id === book.spaceId);
  if (!space || !book.consignorId) return emit('error', 'Pick an artist and a space.');
  let note = '';
  const ok = await guard(async () => {
    const res = await bookRental({
      consignorId: book.consignorId,
      storeId: storeId.value,
      spaceId: space.id,
      startDate: book.startDate,
      months: Math.max(1, Math.floor(Number(book.months) || 1)),
      monthlyFee: parseFloat(book.monthlyFee) || 0,
      currency: space.currency,
      deductFromSales: book.deductFromSales,
      note: book.note.trim(),
    });
    note = deliveryText(nameOf(book.consignorId), res.delivery);
  }, 'Could not book the space.');
  if (ok) {
    booking.value = false;
    sdk().ui.toast(note, { kind: 'success', timeoutMs: 6000 });
  }
}

const open = ref<ConsignmentRental | null>(null);
const change = reactive({ months: '', monthlyFee: '', note: '', deductFromSales: true, upSpace: '', upFrom: '', upMonths: '3', upFee: '', endOn: '' });
function openRental(r: ConsignmentRental): void {
  open.value = r;
  // The next size up: the cheapest space dearer than this one, else whatever else there is.
  const others = spaces.value.filter((s) => s.id !== r.spaceId).sort((a, b) => a.monthlyFee - b.monthlyFee);
  const bigger = others.find((s) => s.monthlyFee > r.monthlyFee) ?? others[others.length - 1];
  Object.assign(change, {
    months: String(r.months),
    monthlyFee: String(r.monthlyFee),
    note: r.note,
    deductFromSales: r.deductFromSales,
    upSpace: bigger?.id ?? '',
    upFrom: nextPeriodStart(r, now),
    upMonths: String(r.months),
    upFee: String(bigger?.monthlyFee ?? ''),
    endOn: nextPeriodStart(r, now),
  });
}
watch(() => change.upSpace, (id) => {
  const s = data.value?.spaces.find((x) => x.id === id);
  if (s && open.value) change.upFee = String(s.monthlyFee);
});
async function saveRental(): Promise<void> {
  const r = open.value!;
  const ok = await guard(
    () =>
      editRental(r.id, {
        consignorId: r.consignorId,
        storeId: r.storeId,
        spaceId: r.spaceId,
        startDate: r.startDate,
        months: Math.max(1, Math.floor(Number(change.months) || r.months)),
        monthlyFee: parseFloat(change.monthlyFee) || 0,
        currency: r.currency,
        deductFromSales: change.deductFromSales,
        note: change.note.trim(),
      }),
    'Could not save the rental.',
  );
  if (ok) open.value = null;
}
async function upgrade(): Promise<void> {
  const r = open.value!;
  let note = '';
  const ok = await guard(async () => {
    const res = await upgradeRental(r.id, {
      spaceId: change.upSpace,
      from: change.upFrom,
      months: Math.max(1, Math.floor(Number(change.upMonths) || 1)),
      monthlyFee: parseFloat(change.upFee) || 0,
    });
    note = deliveryText(nameOf(r.consignorId), res.delivery);
  }, 'Could not upgrade the rental.');
  if (ok) {
    open.value = null;
    sdk().ui.toast(`Moved to ${spaceName(change.upSpace)} from ${change.upFrom}. ${note}`, { kind: 'success', timeoutMs: 6000 });
  }
}
async function endEarly(): Promise<void> {
  const r = open.value!;
  if (await guard(() => endRental(r.id, change.endOn), 'Could not end the rental.')) open.value = null;
}
async function removeRental(): Promise<void> {
  const r = open.value!;
  if (!(await sdk().ui.confirm('The rental is removed, and so is the rent it charged. To stop a rental that really ran, end it instead.', 'Delete rental?'))) return;
  if (await guard(() => deleteRental(r.id), 'Could not delete the rental.')) open.value = null;
}

// ── Setup moments ───────────────────────────────────────────────────────────
const upcoming = computed(() => (data.value?.setups ?? []).filter((s) => s.storeId === storeId.value && s.date >= now));
const past = computed(() => (data.value?.setups ?? []).filter((s) => s.storeId === storeId.value && s.date < now).reverse().slice(0, 5));
const statusLabel: Record<SetupMoment['status'], string> = { scheduled: 'waiting for reply', confirmed: 'confirmed', declined: "can't make it", cancelled: 'cancelled' };

const setupOpen = ref(false);
const setupId = ref<string | null>(null);
const setup = reactive({ consignorId: '', date: now, time: '10:00', durationMin: '30', note: '' });
function openSetup(s?: SetupMoment, consignorId?: string): void {
  setupId.value = s?.id ?? null;
  Object.assign(setup, s
    ? { consignorId: s.consignorId, date: s.date, time: s.time, durationMin: String(s.durationMin), note: s.note }
    : { consignorId: consignorId ?? activeArtists.value[0]?.id ?? '', date: now, time: '10:00', durationMin: '30', note: '' });
  setupOpen.value = true;
}
async function submitSetup(): Promise<void> {
  if (!setup.consignorId) return emit('error', 'Pick an artist.');
  const input = {
    consignorId: setup.consignorId,
    storeId: storeId.value,
    date: setup.date,
    time: setup.time,
    durationMin: Math.max(5, Math.floor(Number(setup.durationMin) || 30)),
    note: setup.note.trim(),
  };
  let note = '';
  const ok = await guard(async () => {
    const res = setupId.value ? await moveSetup(setupId.value, input) : await scheduleSetup(input);
    note = deliveryText(nameOf(input.consignorId), res.delivery);
  }, 'Could not save the setup.');
  if (ok) {
    setupOpen.value = false;
    sdk().ui.toast(note, { kind: 'success', timeoutMs: 7000 });
  }
}
async function cancel(s: SetupMoment): Promise<void> {
  if (!(await sdk().ui.confirm(`${nameOf(s.consignorId)} is told the setup on ${s.date} at ${s.time} is off.`, 'Cancel setup?'))) return;
  let note = '';
  const ok = await guard(async () => {
    note = deliveryText(nameOf(s.consignorId), (await cancelSetup(s.id)).delivery);
  }, 'Could not cancel the setup.');
  if (ok) sdk().ui.toast(note, { kind: 'success', timeoutMs: 6000 });
}
const fmtDay = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
</script>

<template>
  <div class="tab">
    <p v-if="!stores.length" class="empty">Add a store under Events → New store to plan its space.</p>
    <template v-else>
      <div class="bar">
        <label class="pick">
          <span>Store</span>
          <select v-model="storeId"><option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        </label>
        <span class="grow" />
        <button type="button" @click="spacesOpen = true; editSpace()"><Icon name="layers" :size="14" /> Spaces</button>
        <button type="button" :disabled="!spaces.length || !activeArtists.length" @click="openBooking"><Icon name="plus" :size="14" /> Rent space</button>
        <button type="button" class="primary" :disabled="!activeArtists.length" @click="openSetup()"><Icon name="calendar" :size="14" /> Schedule setup</button>
      </div>
      <p v-if="data && !data.emailEnabled" class="hint">Email is not set up on this server, so artists are told in Zollify only - and only once they have linked their account.</p>

      <p v-if="!data" class="hint">Loading…</p>
      <template v-else>
        <!-- What is on the shelves this month -->
        <div v-if="spaces.length" class="spaces">
          <div v-for="s in spaces" :key="s.id" class="space">
            <strong>{{ s.name }}</strong>
            <span>{{ fmtPrice(s.monthlyFee, s.currency) }}/month</span>
            <span :class="{ full: (usedNow.get(s.id) ?? 0) >= s.count }">{{ usedNow.get(s.id) ?? 0 }} of {{ s.count }} rented now</span>
          </div>
        </div>
        <p v-else class="empty">No spaces yet. Add what this store rents out - a small shelf, a large one, a window spot - under <strong>Spaces</strong>.</p>

        <!-- Setup moments -->
        <section class="block">
          <h2>Setups</h2>
          <p v-if="!upcoming.length" class="hint">Nothing scheduled.</p>
          <ul class="setups">
            <li v-for="s in upcoming" :key="s.id" :class="s.status">
              <span class="when">{{ fmtDay(s.date) }} · {{ s.time }}<small> · {{ s.durationMin }} min</small></span>
              <strong>{{ nameOf(s.consignorId) }}</strong>
              <span :class="['pill', s.status]">{{ statusLabel[s.status] }}</span>
              <span v-if="s.artistNote" class="hint">“{{ s.artistNote }}”</span>
              <span class="grow" />
              <template v-if="s.status !== 'cancelled'">
                <button type="button" @click="openSetup(s)">Move</button>
                <button type="button" class="quiet" @click="cancel(s)">Cancel</button>
              </template>
            </li>
          </ul>
          <details v-if="past.length">
            <summary>Earlier</summary>
            <ul class="setups">
              <li v-for="s in past" :key="s.id" class="past">
                <span class="when">{{ fmtDay(s.date) }} · {{ s.time }}</span><strong>{{ nameOf(s.consignorId) }}</strong><span :class="['pill', s.status]">{{ statusLabel[s.status] }}</span>
              </li>
            </ul>
          </details>
        </section>

        <!-- Rentals month by month -->
        <section class="block">
          <div class="head">
            <h2>Rentals</h2>
            <span class="grow" />
            <button type="button" class="quiet" aria-label="Earlier months" @click="offset -= 3"><Icon name="chevron-left" :size="16" /></button>
            <button type="button" class="quiet" @click="offset = -2">Today</button>
            <button type="button" class="quiet" aria-label="Later months" @click="offset += 3"><Icon name="chevron-right" :size="16" /></button>
          </div>
          <p v-if="!visibleRentals.length" class="hint">No rentals in these months.</p>
          <div v-else class="timeline" :style="{ '--cols': months.length }">
            <div class="row header">
              <span class="who" />
              <span v-for="m in months" :key="m" :class="['month', { now: m === `${now.slice(0, 7)}-01` }]">{{ monthLabel(m) }}</span>
            </div>
            <button v-for="r in visibleRentals" :key="r.id" type="button" class="row" @click="openRental(r)">
              <span class="who">
                <strong>{{ nameOf(r.consignorId) }}</strong>
                <small>{{ spaceName(r.spaceId) }} · {{ fmtPrice(r.monthlyFee, r.currency) }}</small>
                <small v-if="endingSoon(r)" class="soon">ends in {{ daysLeft(r) }} days</small>
              </span>
              <span v-for="m in months" :key="m" :class="['cell', { on: covers(r, m), upgrade: covers(r, m) && r.upgradedFromId, now: m === `${now.slice(0, 7)}-01` }]" />
            </button>
          </div>
        </section>
      </template>
    </template>

    <!-- Spaces -->
    <ModalShell v-if="spacesOpen" title="Spaces at this store" @close="spacesOpen = false">
      <div class="form">
        <ul class="space-list">
          <li v-for="s in allSpaces" :key="s.id" :class="{ archived: s.archived }">
            <span><strong>{{ s.name }}</strong> · {{ fmtPrice(s.monthlyFee, s.currency) }}/month · {{ s.count }}×<template v-if="s.archived"> · archived</template></span>
            <button type="button" @click="editSpace(s)">Edit</button>
            <button type="button" class="quiet" @click="archiveSpace(s)">{{ s.archived ? 'Restore' : 'Remove' }}</button>
          </li>
        </ul>
        <fieldset>
          <legend>{{ spaceForm.id ? 'Edit space' : 'New space' }}</legend>
          <label><span>Name</span><input v-model="spaceForm.name" type="text" placeholder="Small shelf" /></label>
          <div class="two">
            <label><span>Monthly fee ({{ data?.spaces.find((s) => s.id === spaceForm.id)?.currency ?? currency }})</span><input v-model="spaceForm.monthlyFee" type="number" min="0" step="0.5" inputmode="decimal" /></label>
            <label><span>How many</span><input v-model="spaceForm.count" type="number" min="1" step="1" inputmode="numeric" /></label>
          </div>
          <label><span>Note</span><input v-model="spaceForm.note" type="text" placeholder="40 × 30 cm, by the window…" /></label>
          <div class="footer">
            <button v-if="spaceForm.id" type="button" @click="editSpace()">New instead</button>
            <button type="button" class="primary" @click="submitSpace">{{ spaceForm.id ? 'Save' : 'Add space' }}</button>
          </div>
        </fieldset>
        <p class="hint">Changing a fee only affects new rentals - running ones keep the price they were booked at.</p>
      </div>
    </ModalShell>

    <!-- Book -->
    <ModalShell v-if="booking" title="Rent space" @close="booking = false">
      <div class="form">
        <label><span>Artist</span><select v-model="book.consignorId"><option v-for="c in activeArtists" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
        <label><span>Space</span><select v-model="book.spaceId"><option v-for="s in spaces" :key="s.id" :value="s.id">{{ s.name }} ({{ usedNow.get(s.id) ?? 0 }}/{{ s.count }} rented)</option></select></label>
        <div class="three">
          <label><span>From</span><input v-model="book.startDate" type="date" /></label>
          <label><span>Months</span><input v-model="book.months" type="number" min="1" max="120" step="1" inputmode="numeric" /></label>
          <label><span>Per month</span><input v-model="book.monthlyFee" type="number" min="0" step="0.5" inputmode="decimal" /></label>
        </div>
        <label class="check"><input v-model="book.deductFromSales" type="checkbox" /> Take the rent off their sales in the statement</label>
        <label><span>Note</span><input v-model="book.note" type="text" /></label>
        <p class="hint">Runs {{ book.startDate }} to {{ addMonths(book.startDate || now, Math.max(1, Number(book.months) || 1)) }}. A month is charged once it has started.</p>
      </div>
      <template #footer><div class="footer"><button type="button" @click="booking = false">Cancel</button><button type="button" class="primary" @click="submitBooking">Book</button></div></template>
    </ModalShell>

    <!-- One rental -->
    <ModalShell v-if="open" :title="`${nameOf(open.consignorId)} · ${spaceName(open.spaceId)}`" @close="open = null">
      <div class="form">
        <p class="hint">
          {{ open.startDate }} to {{ rentalEnd(open) }} · {{ rentalStatus(open, now) }}
          <template v-if="open.endedOn"> · stopped early</template>
          <template v-if="open.upgradedFromId"> · upgraded from an earlier rental</template>
        </p>
        <fieldset>
          <legend>Change or extend</legend>
          <div class="two">
            <label><span>Months</span><input v-model="change.months" type="number" min="1" max="120" step="1" inputmode="numeric" /></label>
            <label><span>Per month ({{ open.currency }})</span><input v-model="change.monthlyFee" type="number" min="0" step="0.5" inputmode="decimal" /></label>
          </div>
          <label class="check"><input v-model="change.deductFromSales" type="checkbox" /> Take the rent off their sales</label>
          <label><span>Note</span><input v-model="change.note" type="text" /></label>
          <div class="footer"><button type="button" class="primary" @click="saveRental">Save</button></div>
        </fieldset>
        <fieldset v-if="rentalStatus(open, now) !== 'ended'">
          <legend>Upgrade to another space</legend>
          <label><span>Space</span><select v-model="change.upSpace"><option v-for="s in spaces.filter((x) => x.id !== open!.spaceId)" :key="s.id" :value="s.id">{{ s.name }} · {{ fmtPrice(s.monthlyFee, s.currency) }}/month</option></select></label>
          <div class="three">
            <label><span>From</span><input v-model="change.upFrom" type="date" /></label>
            <label><span>Months</span><input v-model="change.upMonths" type="number" min="1" max="120" step="1" inputmode="numeric" /></label>
            <label><span>Per month</span><input v-model="change.upFee" type="number" min="0" step="0.5" inputmode="decimal" /></label>
          </div>
          <p class="hint">The current rental stops on that date and the new one starts. Starting it at the next period ({{ nextPeriodStart(open, now) }}) bills no month twice.</p>
          <div class="footer"><button type="button" class="primary" :disabled="!change.upSpace" @click="upgrade">Upgrade</button></div>
        </fieldset>
        <fieldset v-if="rentalStatus(open, now) !== 'ended'">
          <legend>End early</legend>
          <div class="inline"><input v-model="change.endOn" type="date" aria-label="Last day plus one" /><button type="button" @click="endEarly">End on this date</button></div>
          <p class="hint">Months starting on or after this date are not charged.</p>
        </fieldset>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" class="quiet danger" @click="removeRental">Delete</button>
          <span class="grow" />
          <button type="button" @click="openSetup(undefined, open.consignorId); open = null"><Icon name="calendar" :size="14" /> Schedule setup</button>
          <button type="button" @click="open = null">Close</button>
        </div>
      </template>
    </ModalShell>

    <!-- Setup -->
    <ModalShell v-if="setupOpen" :title="setupId ? 'Move setup' : 'Schedule setup'" @close="setupOpen = false">
      <div class="form">
        <label><span>Artist</span>
          <select v-model="setup.consignorId" :disabled="!!setupId"><option v-for="c in activeArtists" :key="c.id" :value="c.id">{{ c.name }}{{ c.linked ? '' : ' (not linked)' }}</option></select>
        </label>
        <div class="three">
          <label><span>Date</span><input v-model="setup.date" type="date" /></label>
          <label><span>Time</span><input v-model="setup.time" type="time" /></label>
          <label><span>Minutes</span><input v-model="setup.durationMin" type="number" min="5" max="720" step="5" inputmode="numeric" /></label>
        </div>
        <label><span>Note for the artist</span><textarea v-model="setup.note" rows="2" placeholder="Bring the new prints; use the back door." /></label>
        <p class="hint">
          {{ nameOf(setup.consignorId) }} gets a notification in Zollify<template v-if="!consignors.find((c) => c.id === setup.consignorId)?.linked"> once they link their account</template>
          and an email with a calendar invite<template v-if="data && !data.emailEnabled"> (email is not set up on this server)</template>.
          <template v-if="setupId"> Moving it asks them to confirm again.</template>
        </p>
      </div>
      <template #footer><div class="footer"><button type="button" @click="setupOpen = false">Cancel</button><button type="button" class="primary" @click="submitSetup">{{ setupId ? 'Move and notify' : 'Schedule and notify' }}</button></div></template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .9rem; }
.bar { display: flex; align-items: flex-end; gap: .5rem; flex-wrap: wrap; }
.bar button { min-height: 2.4rem; display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; }
.pick { display: flex; flex-direction: column; gap: .25rem; font-size: .82rem; min-width: 14rem; }
.grow { flex: 1; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.2rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.spaces { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .5rem; }
.space { display: flex; flex-direction: column; gap: .1rem; padding: .6rem .8rem; border-radius: 10px; background: var(--zfy-surface, #fff); border: 1px solid var(--zfy-line, #d6dde4); font-size: .82rem; }
.space strong { font-size: .9rem; }
.space .full { color: var(--zfy-warning-ink, #8a5a1e); font-weight: 600; }
.block { display: flex; flex-direction: column; gap: .5rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
h2 { margin: 0; font-size: 1rem; }
.head { display: flex; align-items: center; gap: .3rem; }
.head button { min-height: 2rem; padding: .1rem .5rem; font-size: .8rem; }
.setups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.setups li { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; font-size: .86rem; padding: .35rem 0; border-bottom: 1px solid var(--zfy-line, #d6dde4); }
.setups li:last-child { border-bottom: 0; }
.setups li.cancelled strong, .setups li.cancelled .when { text-decoration: line-through; color: var(--zfy-muted, #5a6472); }
.setups button { min-height: 2rem; padding: .1rem .6rem; font-size: .78rem; }
.when { font-variant-numeric: tabular-nums; min-width: 9.5rem; }
.when small { color: var(--zfy-muted, #5a6472); }
.pill { font-size: .64rem; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; border-radius: 999px; padding: .12rem .45rem; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); }
.pill.confirmed { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.pill.declined { background: var(--zfy-danger-soft, #f7e1da); color: var(--zfy-danger, #c6512f); }
summary { cursor: pointer; font-size: .82rem; font-weight: 600; }
.timeline { display: flex; flex-direction: column; overflow-x: auto; }
.row { display: grid; grid-template-columns: minmax(10rem, 13rem) repeat(var(--cols), minmax(2.6rem, 1fr)); align-items: stretch; gap: 2px; width: 100%; padding: 2px 0; border: 0; background: none; text-align: left; font-weight: 400; min-height: 0; border-radius: 0; }
button.row:hover .who strong { text-decoration: underline; }
.row.header .month { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; color: var(--zfy-muted, #5a6472); text-align: center; padding-bottom: .25rem; }
.row.header .month.now { color: var(--zfy-accent-ink, #0a5a4a); font-weight: 700; }
.who { display: flex; flex-direction: column; justify-content: center; padding-right: .5rem; font-size: .84rem; }
.who small { color: var(--zfy-muted, #5a6472); font-size: .74rem; }
.who .soon { color: var(--zfy-warning-ink, #8a5a1e); font-weight: 600; }
.cell { min-height: 2.2rem; border-radius: 4px; background: var(--zfy-bg, #f1f4f6); }
.cell.now { box-shadow: inset 0 0 0 1px var(--zfy-accent, #0e7c66); }
.cell.on { background: var(--zfy-accent, #0e7c66); opacity: .8; }
.cell.on.upgrade { background: var(--zfy-signal, #3b6fb6); }
.form { display: flex; flex-direction: column; gap: .7rem; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.form label.check { flex-direction: row; align-items: center; gap: .4rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .55rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: .6rem; }
.inline { display: flex; gap: .5rem; flex-wrap: wrap; }
.space-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.space-list li { display: flex; align-items: center; gap: .5rem; font-size: .86rem; }
.space-list li span { flex: 1; }
.space-list li.archived { opacity: .6; }
.space-list button { min-height: 2rem; padding: .1rem .6rem; font-size: .78rem; }
.footer { display: flex; align-items: center; justify-content: flex-end; gap: .5rem; }
</style>
