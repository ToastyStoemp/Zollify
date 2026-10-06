<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { Signup, StoreFeature } from '@zollify/shared';
import { addMonths, featureOn, fmtPrice, csvCell } from '@zollify/shared';
import { Icon, ModalShell } from '@zollify/ui';
import {
  addSignup,
  cancelWorkshop,
  consignors,
  deleteFeature,
  deleteWorkshop,
  deliveryText,
  errorText,
  loadProgramme,
  loadSignups,
  newPublicLink,
  publicUrl,
  saveFeature,
  saveWorkshop,
  stores,
  today,
  updateSignup,
  type Programme,
  type WorkshopRow,
} from '../api';
import { sdk } from '../runtime';

/**
 * What happens in the stores besides selling: an artist in the spotlight -
 * with a discount the till applies by itself inside the dates - and
 * workshops people sign up for on a public page.
 */
const emit = defineEmits<{ error: [message: string | null] }>();

const data = ref<Programme | null>(null);
async function refresh(): Promise<void> {
  try {
    data.value = await loadProgramme();
  } catch (err) {
    emit('error', errorText(err, 'Could not load store events.'));
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
const artists = computed(() => consignors.value.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name)));
const nameOf = (id: string | null): string => consignors.value.find((c) => c.id === id)?.name ?? 'Removed artist';
const storeName = (id: string): string => stores.value.find((s) => s.id === id)?.name ?? 'Removed store';
const fmtDay = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// ── The public page ─────────────────────────────────────────────────────────
const pageUrl = computed(() => (data.value ? publicUrl(data.value.publicPath) : ''));
async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(pageUrl.value);
    sdk().ui.toast('Link copied.', { kind: 'success' });
  } catch {
    sdk().ui.toast(pageUrl.value, { timeoutMs: 10_000 });
  }
}
async function rotateLink(): Promise<void> {
  if (!(await sdk().ui.confirm('The current link stops working - anywhere you shared it shows "no longer available". Cancel links already emailed keep working.', 'Make a new link?'))) return;
  await guard(newPublicLink, 'Could not make a new link.');
}

// ── Featured artists ────────────────────────────────────────────────────────
const featureState = (f: StoreFeature): 'running' | 'upcoming' | 'past' => (featureOn(f, now) ? 'running' : f.startDate > now ? 'upcoming' : 'past');
const features = computed(() => (data.value?.features ?? []).filter((f) => featureState(f) !== 'past'));
const pastFeatures = computed(() => (data.value?.features ?? []).filter((f) => featureState(f) === 'past').slice(0, 6));

const featureOpen = ref(false);
const featureId = ref<string | null>(null);
const feature = reactive({ consignorId: '', storeIds: [] as string[], title: '', description: '', startDate: '', endDate: '', discountPct: '0', published: true });
function openFeature(f?: StoreFeature): void {
  featureId.value = f?.id ?? null;
  // A new one defaults to next month, whole.
  const next = addMonths(`${now.slice(0, 7)}-01`, 1);
  const artist = f ? undefined : artists.value[0];
  Object.assign(feature, f
    ? { consignorId: f.consignorId, storeIds: [...f.storeIds], title: f.title, description: f.description, startDate: f.startDate, endDate: f.endDate, discountPct: String(f.discountPct), published: f.published }
    : { consignorId: artist?.id ?? '', storeIds: artist?.storeIds.length ? [...artist.storeIds] : stores.value.map((s) => s.id), title: '', description: '', startDate: next, endDate: addDays(addMonths(next, 1), -1), discountPct: '0', published: true });
  featureOpen.value = true;
}
function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function pickFeatureArtist(): void {
  const a = consignors.value.find((c) => c.id === feature.consignorId);
  if (a?.storeIds.length && !featureId.value) feature.storeIds = [...a.storeIds];
}
async function submitFeature(): Promise<void> {
  if (!feature.consignorId || !feature.storeIds.length) return emit('error', 'Pick an artist and at least one store.');
  let note = '';
  const ok = await guard(async () => {
    const res = await saveFeature(featureId.value ?? crypto.randomUUID(), {
      consignorId: feature.consignorId,
      storeIds: [...feature.storeIds],
      title: feature.title.trim(),
      description: feature.description.trim(),
      startDate: feature.startDate,
      endDate: feature.endDate,
      discountPct: Math.min(90, Math.max(0, parseFloat(feature.discountPct) || 0)),
      published: feature.published,
    });
    note = res.delivery ? deliveryText(nameOf(feature.consignorId), res.delivery) : 'Saved.';
  }, 'Could not save the feature.');
  if (ok) {
    featureOpen.value = false;
    sdk().ui.toast(note, { kind: 'success', timeoutMs: 6000 });
  }
}
async function removeFeature(f: StoreFeature): Promise<void> {
  if (!(await sdk().ui.confirm(`${nameOf(f.consignorId)} is no longer featured${f.discountPct ? ' and their discount stops at the till' : ''}.`, 'Remove feature?'))) return;
  if (await guard(() => deleteFeature(f.id), 'Could not remove the feature.')) featureOpen.value = false;
}

// ── Workshops ───────────────────────────────────────────────────────────────
const upcoming = computed(() => (data.value?.workshops ?? []).filter((w) => w.date >= now && !w.cancelledAt));
const earlier = computed(() => (data.value?.workshops ?? []).filter((w) => w.date < now || w.cancelledAt).reverse().slice(0, 10));

const workshopOpen = ref(false);
const workshopId = ref<string | null>(null);
const workshop = reactive({
  storeId: '',
  title: '',
  description: '',
  date: '',
  time: '18:00',
  durationMin: '120',
  capacity: '8',
  price: '0',
  hostConsignorId: '',
  hostSharePct: '0',
  published: true,
  signupsOpen: true,
  waitlist: true,
});
function openWorkshop(w?: WorkshopRow): void {
  workshopId.value = w?.id ?? null;
  Object.assign(workshop, w
    ? { storeId: w.storeId, title: w.title, description: w.description, date: w.date, time: w.time, durationMin: String(w.durationMin), capacity: String(w.capacity), price: String(w.price), hostConsignorId: w.hostConsignorId ?? '', hostSharePct: String(w.hostSharePct ?? 0), published: w.published, signupsOpen: w.signupsOpen, waitlist: w.waitlist }
    : { storeId: stores.value[0]?.id ?? '', title: '', description: '', date: addDays(now, 14), time: '18:00', durationMin: '120', capacity: '8', price: '0', hostConsignorId: '', hostSharePct: '0', published: true, signupsOpen: true, waitlist: true });
  workshopOpen.value = true;
}
async function submitWorkshop(): Promise<void> {
  if (!workshop.title.trim() || !workshop.storeId) return emit('error', 'A workshop needs a title and a store.');
  const existing = data.value?.workshops.find((w) => w.id === workshopId.value);
  let note = '';
  const ok = await guard(async () => {
    const res = await saveWorkshop(workshopId.value ?? crypto.randomUUID(), {
      storeId: workshop.storeId,
      title: workshop.title.trim(),
      description: workshop.description.trim(),
      date: workshop.date,
      time: workshop.time,
      durationMin: Math.max(10, Math.floor(Number(workshop.durationMin) || 120)),
      capacity: Math.max(1, Math.floor(Number(workshop.capacity) || 1)),
      price: Math.max(0, parseFloat(workshop.price) || 0),
      currency: existing?.currency ?? currency.value,
      hostConsignorId: workshop.hostConsignorId || null,
      hostSharePct: workshop.hostConsignorId ? Math.min(100, Math.max(0, parseFloat(workshop.hostSharePct) || 0)) : 0,
      published: workshop.published,
      signupsOpen: workshop.signupsOpen,
      waitlist: workshop.waitlist,
    });
    const parts = ['Saved.'];
    if (res.promoted) parts.push(`${res.promoted} moved up from the waitlist.`);
    if (res.delivery) parts.push(deliveryText(nameOf(workshop.hostConsignorId || null), res.delivery));
    note = parts.join(' ');
  }, 'Could not save the workshop.');
  if (ok) {
    workshopOpen.value = false;
    sdk().ui.toast(note, { kind: 'success', timeoutMs: 6000 });
  }
}
async function callOff(w: WorkshopRow): Promise<void> {
  const people = w.signups;
  if (!(await sdk().ui.confirm(`${w.title} on ${w.date} is called off.${people ? ` The ${people} sign-up${people === 1 ? '' : 's'} with an email address are told.` : ''}`, 'Cancel workshop?'))) return;
  let told = 0;
  if (await guard(async () => (told = (await cancelWorkshop(w.id)).told), 'Could not cancel the workshop.')) {
    workshopOpen.value = false;
    sdk().ui.toast(people ? `Cancelled - ${told} told by email.` : 'Cancelled.', { kind: 'success' });
  }
}
async function removeWorkshop(w: WorkshopRow): Promise<void> {
  if (!(await sdk().ui.confirm(`${w.title} is deleted.`, 'Delete workshop?'))) return;
  if (await guard(() => deleteWorkshop(w.id), 'Could not delete the workshop.')) workshopOpen.value = false;
}

// ── Sign-ups ────────────────────────────────────────────────────────────────
const listFor = ref<WorkshopRow | null>(null);
const signups = ref<Signup[]>([]);
const walkIn = reactive({ name: '', email: '', seats: '1', note: '', paid: false });
async function openSignups(w: WorkshopRow): Promise<void> {
  listFor.value = w;
  signups.value = [];
  Object.assign(walkIn, { name: '', email: '', seats: '1', note: '', paid: false });
  await guard(async () => (signups.value = await loadSignups(w.id)), 'Could not load sign-ups.');
}
const live = computed(() => signups.value.filter((s) => s.status !== 'cancelled'));
const statusLabel: Record<Signup['status'], string> = { booked: 'booked', waitlist: 'waitlist', cancelled: 'cancelled' };
async function reloadSignups(): Promise<void> {
  if (!listFor.value) return;
  signups.value = await loadSignups(listFor.value.id);
  listFor.value = data.value?.workshops.find((w) => w.id === listFor.value!.id) ?? listFor.value;
}
async function setPaid(s: Signup, paid: boolean): Promise<void> {
  if (await guard(() => updateSignup(s.id, { paid }), 'Could not update.')) await reloadSignups();
}
async function cancelSignup(s: Signup): Promise<void> {
  if (!(await sdk().ui.confirm(`${s.name}'s ${s.seats === 1 ? 'place is' : `${s.seats} places are`} cancelled. Whoever is next on the waitlist moves up and is emailed.`, 'Cancel sign-up?'))) return;
  let promoted = 0;
  if (await guard(async () => (promoted = (await updateSignup(s.id, { status: 'cancelled' })).promoted), 'Could not cancel.')) {
    await reloadSignups();
    if (promoted) sdk().ui.toast(`${promoted} moved up from the waitlist.`, { kind: 'success' });
  }
}
async function bookNow(s: Signup): Promise<void> {
  if (await guard(() => updateSignup(s.id, { status: 'booked' }), 'Could not book them.')) await reloadSignups();
}
async function addWalkIn(): Promise<void> {
  if (!listFor.value || !walkIn.name.trim()) return;
  let emailed = false;
  const ok = await guard(async () => {
    emailed = (await addSignup(listFor.value!.id, { name: walkIn.name.trim(), email: walkIn.email.trim(), seats: Math.max(1, Math.floor(Number(walkIn.seats) || 1)), note: walkIn.note.trim(), paid: walkIn.paid })).emailed;
  }, 'Could not add them.');
  if (ok) {
    Object.assign(walkIn, { name: '', email: '', seats: '1', note: '', paid: false });
    await reloadSignups();
    if (emailed) sdk().ui.toast('Added and emailed their confirmation.', { kind: 'success' });
  }
}
async function exportSignups(): Promise<void> {
  const w = listFor.value!;
  const rows = [['Name', 'Email', 'Places', 'Status', 'Paid', 'Note', 'Signed up'], ...signups.value.map((s) => [s.name, s.email, s.seats, s.status, s.paidAtTill ? 'at till' : s.paid ? 'yes' : '', s.note, new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ')])];
  await sdk().ui.saveFile(`${w.title.replace(/[^\w-]+/g, '-').toLowerCase()}-${w.date}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
}
</script>

<template>
  <div class="tab">
    <p v-if="!stores.length" class="empty">Add a store under Events → New store to plan what happens in it.</p>
    <p v-else-if="!data" class="hint">Loading…</p>
    <template v-else>
      <section class="link">
        <div>
          <strong>Public sign-up page</strong>
          <p class="hint">Featured artists and workshops, with sign-up. Share it, or link to it from your website and socials.</p>
          <code>{{ pageUrl }}</code>
        </div>
        <div class="actions">
          <button type="button" @click="copyLink"><Icon name="copy" :size="14" /> Copy</button>
          <a class="btn" :href="pageUrl" target="_blank" rel="noopener"><Icon name="external-link" :size="14" /> Open</a>
          <button type="button" class="quiet" @click="rotateLink">New link</button>
        </div>
      </section>
      <p v-if="!data.emailEnabled" class="hint">Email is not set up on this server: people who sign up see their confirmation and cancel link on the page only.</p>

      <!-- Featured artists -->
      <section class="block">
        <div class="head">
          <h2>Featured artists</h2>
          <span class="grow" />
          <button type="button" class="primary" :disabled="!artists.length" @click="openFeature()"><Icon name="sparkles" :size="14" /> Feature an artist</button>
        </div>
        <p v-if="!features.length" class="hint">Nobody featured. "Artist of the month" puts one artist in the spotlight at your stores, optionally with a discount the till applies by itself.</p>
        <ul class="rows">
          <li v-for="f in features" :key="f.id">
            <button type="button" class="row" @click="openFeature(f)">
              <span :class="['pill', featureState(f)]">{{ featureState(f) === 'running' ? 'now' : 'upcoming' }}</span>
              <strong>{{ nameOf(f.consignorId) }}</strong>
              <span>{{ f.title || 'Artist of the month' }} · {{ fmtDay(f.startDate) }} - {{ fmtDay(f.endDate) }} · {{ f.storeIds.map(storeName).join(', ') }}</span>
              <span v-if="f.discountPct" class="off">{{ f.discountPct }}% off at the till</span>
              <span v-if="!f.published" class="hint">not on the public page</span>
            </button>
          </li>
        </ul>
        <details v-if="pastFeatures.length">
          <summary>Earlier</summary>
          <ul class="rows">
            <li v-for="f in pastFeatures" :key="f.id" class="past"><span>{{ nameOf(f.consignorId) }} · {{ f.startDate }} - {{ f.endDate }}</span></li>
          </ul>
        </details>
      </section>

      <!-- Workshops -->
      <section class="block">
        <div class="head">
          <h2>Workshops</h2>
          <span class="grow" />
          <button type="button" class="primary" @click="openWorkshop()"><Icon name="plus" :size="14" /> New workshop</button>
        </div>
        <p v-if="!upcoming.length" class="hint">No workshops coming up.</p>
        <div class="cards">
          <article v-for="w in upcoming" :key="w.id" class="card">
            <div class="title">
              <strong>{{ w.title }}</strong>
              <span v-if="!w.published" class="pill">hidden</span>
              <span v-else-if="!w.signupsOpen" class="pill">sign-ups closed</span>
            </div>
            <p class="hint">{{ fmtDay(w.date) }} · {{ w.time }} · {{ storeName(w.storeId) }}<template v-if="w.hostConsignorId"> · with {{ nameOf(w.hostConsignorId) }}</template></p>
            <div class="meter" :title="`${w.booked} of ${w.capacity} places booked`"><i :style="{ width: `${Math.min(100, (w.booked / w.capacity) * 100)}%` }" /></div>
            <p class="count">
              <strong>{{ w.booked }}</strong> of {{ w.capacity }} booked<template v-if="w.waiting"> · {{ w.waiting }} waiting</template>
              · {{ w.price ? `${fmtPrice(w.price, w.currency)} each` : 'free' }}
            </p>
            <div class="actions">
              <button type="button" class="primary" @click="openSignups(w)"><Icon name="users" :size="14" /> Sign-ups</button>
              <button type="button" @click="openWorkshop(w)">Edit</button>
            </div>
          </article>
        </div>
        <details v-if="earlier.length">
          <summary>Earlier and cancelled</summary>
          <ul class="rows">
            <li v-for="w in earlier" :key="w.id" class="past">
              <span>{{ w.date }} · {{ w.title }} · {{ w.booked }} booked<template v-if="w.cancelledAt"> · cancelled</template></span>
              <button type="button" class="quiet" @click="openSignups(w)">Sign-ups</button>
            </li>
          </ul>
        </details>
      </section>
    </template>

    <!-- Feature -->
    <ModalShell v-if="featureOpen" :title="featureId ? 'Featured artist' : 'Feature an artist'" @close="featureOpen = false">
      <div class="form">
        <label><span>Artist</span><select v-model="feature.consignorId" @change="pickFeatureArtist"><option v-for="a in artists" :key="a.id" :value="a.id">{{ a.name }}</option></select></label>
        <label><span>Title</span><input v-model="feature.title" type="text" placeholder="Artist of the month" maxlength="120" /></label>
        <div class="two">
          <label><span>From</span><input v-model="feature.startDate" type="date" /></label>
          <label><span>Until (including)</span><input v-model="feature.endDate" type="date" /></label>
        </div>
        <fieldset>
          <legend>At</legend>
          <label v-for="s in stores" :key="s.id" class="check"><input v-model="feature.storeIds" type="checkbox" :value="s.id" /> {{ s.name }}</label>
        </fieldset>
        <label>
          <span>Discount on their work, %</span>
          <input v-model="feature.discountPct" type="number" min="0" max="90" step="1" inputmode="numeric" />
        </label>
        <p class="hint">
          <template v-if="Number(feature.discountPct) > 0">The till takes {{ feature.discountPct }}% off every item of {{ nameOf(feature.consignorId) }} at these stores, {{ feature.startDate }} to {{ feature.endDate }}, by itself. Their commission is worked out on the discounted price.</template>
          <template v-else>0 = no discount, just the spotlight.</template>
        </p>
        <label><span>About (on the public page)</span><textarea v-model="feature.description" rows="3" /></label>
        <label class="check"><input v-model="feature.published" type="checkbox" /> Show on the public page</label>
      </div>
      <template #footer>
        <div class="footer">
          <button v-if="featureId" type="button" class="quiet danger" @click="removeFeature(data!.features.find((f) => f.id === featureId)!)">Remove</button>
          <span class="grow" />
          <button type="button" @click="featureOpen = false">Cancel</button>
          <button type="button" class="primary" @click="submitFeature">{{ featureId ? 'Save' : 'Feature and notify' }}</button>
        </div>
      </template>
    </ModalShell>

    <!-- Workshop -->
    <ModalShell v-if="workshopOpen" :title="workshopId ? 'Edit workshop' : 'New workshop'" @close="workshopOpen = false">
      <div class="form">
        <label><span>Title</span><input v-model="workshop.title" type="text" placeholder="Linocut for beginners" maxlength="120" /></label>
        <label><span>Store</span><select v-model="workshop.storeId"><option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option></select></label>
        <div class="three">
          <label><span>Date</span><input v-model="workshop.date" type="date" /></label>
          <label><span>Time</span><input v-model="workshop.time" type="time" /></label>
          <label><span>Minutes</span><input v-model="workshop.durationMin" type="number" min="10" step="15" inputmode="numeric" /></label>
        </div>
        <div class="two">
          <label><span>Places</span><input v-model="workshop.capacity" type="number" min="1" step="1" inputmode="numeric" /></label>
          <label><span>Price per place ({{ currency }}, 0 = free)</span><input v-model="workshop.price" type="number" min="0" step="0.5" inputmode="decimal" /></label>
        </div>
        <div :class="workshop.hostConsignorId ? 'two' : ''">
          <label><span>Run by</span>
            <select v-model="workshop.hostConsignorId"><option value="">The store</option><option v-for="a in artists" :key="a.id" :value="a.id">{{ a.name }}</option></select>
          </label>
          <label v-if="workshop.hostConsignorId"><span>Host's share of each place, %</span><input v-model="workshop.hostSharePct" type="number" min="0" max="100" step="5" inputmode="numeric" /></label>
        </div>
        <p v-if="workshop.hostConsignorId" class="hint">
          <template v-if="Number(workshop.hostSharePct) > 0">Of each place paid at the till, {{ nameOf(workshop.hostConsignorId) }} gets {{ workshop.hostSharePct }}% - it goes on their statement like a sale of their work. The store keeps the rest.</template>
          <template v-else>0% = the store keeps all of the ticket money.</template>
        </p>
        <label><span>Description</span><textarea v-model="workshop.description" rows="4" placeholder="What people make, what to bring, who it is for." /></label>
        <label class="check"><input v-model="workshop.published" type="checkbox" /> Show on the public page</label>
        <label class="check"><input v-model="workshop.signupsOpen" type="checkbox" /> Taking sign-ups</label>
        <label class="check"><input v-model="workshop.waitlist" type="checkbox" /> Waitlist when full</label>
        <p class="hint">People pay at the store: take payment from the till (+ Workshop), or tick them paid in the sign-up list. <template v-if="workshopId">Changing the date or time emails everyone signed up.</template></p>
      </div>
      <template #footer>
        <div class="footer">
          <template v-if="workshopId">
            <button v-if="data!.workshops.find((w) => w.id === workshopId)?.signups" type="button" class="quiet danger" @click="callOff(data!.workshops.find((w) => w.id === workshopId)!)">Cancel workshop</button>
            <button v-else type="button" class="quiet danger" @click="removeWorkshop(data!.workshops.find((w) => w.id === workshopId)!)">Delete</button>
          </template>
          <span class="grow" />
          <button type="button" @click="workshopOpen = false">Close</button>
          <button type="button" class="primary" @click="submitWorkshop">Save</button>
        </div>
      </template>
    </ModalShell>

    <!-- Sign-ups -->
    <ModalShell v-if="listFor" :title="listFor.title" @close="listFor = null">
      <div class="form">
        <p class="hint">{{ fmtDay(listFor.date) }} · {{ listFor.time }} · {{ storeName(listFor.storeId) }} · {{ listFor.booked }} of {{ listFor.capacity }} booked<template v-if="listFor.waiting"> · {{ listFor.waiting }} waiting</template><template v-if="listFor.cancelledAt"> · cancelled</template></p>
        <p v-if="!live.length" class="hint">Nobody yet.</p>
        <ul class="people">
          <li v-for="s in signups" :key="s.id" :class="s.status">
            <div class="who">
              <strong>{{ s.name }}</strong><span v-if="s.seats > 1"> × {{ s.seats }}</span>
              <span :class="['pill', s.status]">{{ statusLabel[s.status] }}</span>
              <small v-if="s.email">{{ s.email }}</small>
              <small v-if="s.note" class="note">“{{ s.note }}”</small>
            </div>
            <template v-if="s.status !== 'cancelled' && !listFor.cancelledAt">
              <span v-if="s.status === 'booked' && s.paidAtTill" class="pill booked">paid at till</span>
              <label v-else-if="s.status === 'booked' && listFor.price > 0" class="check"><input type="checkbox" :checked="s.paid" @change="setPaid(s, ($event.target as HTMLInputElement).checked)" /> paid</label>
              <button v-if="s.status === 'waitlist'" type="button" @click="bookNow(s)">Book</button>
              <button type="button" class="quiet" @click="cancelSignup(s)">Cancel</button>
            </template>
          </li>
        </ul>
        <fieldset v-if="!listFor.cancelledAt">
          <legend>Add someone</legend>
          <div class="two">
            <input v-model="walkIn.name" type="text" placeholder="Name" aria-label="Name" />
            <input v-model="walkIn.email" type="email" placeholder="Email (optional)" aria-label="Email" />
          </div>
          <div class="inline">
            <input v-model="walkIn.seats" type="number" min="1" step="1" inputmode="numeric" aria-label="Places" class="seats" />
            <input v-model="walkIn.note" type="text" placeholder="Note" aria-label="Note" class="grow" />
            <label v-if="listFor.price > 0" class="check"><input v-model="walkIn.paid" type="checkbox" /> paid</label>
            <button type="button" :disabled="!walkIn.name.trim()" @click="addWalkIn">Add</button>
          </div>
        </fieldset>
      </div>
      <template #footer>
        <div class="footer">
          <button type="button" :disabled="!signups.length" @click="exportSignups"><Icon name="download" :size="14" /> Export</button>
          <span class="grow" />
          <button type="button" class="primary" @click="listFor = null">Done</button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>

<style scoped>
.tab { display: flex; flex-direction: column; gap: .9rem; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; font-size: .82rem; }
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1.2rem; text-align: center; border: 1px dashed var(--zfy-line, #d6dde4); border-radius: 12px; }
.grow { flex: 1; }
.link { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding: .9rem 1rem; border-radius: 12px; background: var(--zfy-accent-soft, #deeee9); }
.link > div:first-child { flex: 1 1 20rem; display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
.link code { font-size: .8rem; overflow-wrap: anywhere; }
.actions { display: flex; gap: .4rem; flex-wrap: wrap; }
.actions button, .actions .btn { min-height: 2.2rem; padding: .2rem .7rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
.btn { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 8px; background: var(--zfy-surface, #fff); color: var(--zfy-ink, #1a2230); text-decoration: none; font-weight: 500; }
.block { display: flex; flex-direction: column; gap: .6rem; padding: .9rem 1rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); }
.head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.head button { min-height: 2.2rem; font-size: .8rem; display: inline-flex; align-items: center; gap: .3rem; }
h2 { margin: 0; font-size: 1rem; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
.row { width: 100%; display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; text-align: left; padding: .5rem .6rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; background: none; font-weight: 400; min-height: 0; font-size: .86rem; }
.row:hover { background: var(--zfy-bg, #f1f4f6); }
.off { font-weight: 600; color: var(--zfy-accent-ink, #0a5a4a); }
.past { display: flex; align-items: center; gap: .5rem; font-size: .84rem; color: var(--zfy-muted, #5a6472); }
.past button { min-height: 1.8rem; padding: .1rem .5rem; font-size: .76rem; }
.pill { font-size: .64rem; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; border-radius: 999px; padding: .12rem .45rem; background: var(--zfy-bg, #f1f4f6); color: var(--zfy-muted, #5a6472); }
.pill.running, .pill.booked { background: var(--zfy-accent-soft, #deeee9); color: var(--zfy-accent-ink, #0a5a4a); }
.pill.waitlist { background: var(--zfy-signal-soft, #e4ecf6); color: var(--zfy-ink, #1a2230); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: .6rem; }
.card { display: flex; flex-direction: column; gap: .35rem; padding: .8rem .9rem; border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; }
.title { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
.meter { height: .4rem; border-radius: 999px; background: var(--zfy-bg, #f1f4f6); overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--zfy-accent, #0e7c66); }
.count { margin: 0; font-size: .84rem; }
summary { cursor: pointer; font-size: .82rem; font-weight: 600; }
.form { display: flex; flex-direction: column; gap: .7rem; }
.form label { display: flex; flex-direction: column; gap: .25rem; font-size: .875rem; }
.form label.check, label.check { flex-direction: row; align-items: center; gap: .4rem; font-size: .84rem; }
fieldset { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 10px; padding: .6rem .8rem; display: flex; flex-direction: column; gap: .45rem; }
legend { font-size: .8rem; font-weight: 600; padding: 0 .3rem; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.three { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: .6rem; }
.inline { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
.inline .seats { width: 4.5rem; }
.inline button { min-height: 2.2rem; }
.people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.people li { display: flex; align-items: center; gap: .6rem; padding: .45rem 0; border-bottom: 1px solid var(--zfy-line, #d6dde4); flex-wrap: wrap; }
.people li.cancelled { opacity: .55; }
.people .who { flex: 1; display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; font-size: .88rem; }
.people small { color: var(--zfy-muted, #5a6472); font-size: .76rem; }
.people .note { flex-basis: 100%; }
.people button { min-height: 2rem; padding: .1rem .6rem; font-size: .78rem; }
.footer { display: flex; align-items: center; gap: .5rem; }
</style>
