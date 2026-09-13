<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ArtistDetails } from '@zollify/shared';
import { authFetch, currentAccount, updateProfile } from '@zollify/platform';
import ArtistForm from '../components/ArtistForm.vue';
import { loadEnabledModules, unloadModule } from '../boot';

/**
 * First-run setup. Three short steps: who the booth is, which modules to
 * switch on, and where to go next. Every step can be skipped — skipping still
 * marks setup as done so the wizard never nags, and it can be re-run from
 * Settings → Booth profile.
 */

interface AvailableModule {
  moduleId: string;
  version: string;
  title: string;
  description?: string;
  enabled: boolean;
}

/**
 * A sentence per module in the seller's words, plus whether a new booth
 * usually wants it. The module's own description says what it does; this says
 * who it is for.
 */
const GUIDE: Record<string, { forWhom: string; recommended: boolean }> = {
  pos: { forWhom: 'The till. You need this to sell anything at all.', recommended: true },
  customs: {
    forWhom: 'For selling across a border — Swiss EDEC, forms 1174/1187, proforma invoice and goods lists from your claimed stock.',
    recommended: true,
  },
  'price-cards': { forWhom: 'Printable price tags straight from the catalogue. Handy at any table.', recommended: true },
  'public-events': {
    forWhom: 'A public "where to find us" page, a widget for your shop, a calendar feed and an Instagram bio — all from your events.',
    recommended: true,
  },
  sourcing: { forWhom: 'Keep suppliers and draft reorders when stock runs low.', recommended: false },
  'shopify-sync': { forWhom: 'Only if you also run a Shopify store and want the catalogue matched against it.', recommended: false },
  migration: { forWhom: 'Only if you are moving from ZollTool. Import the backup once, then switch it off.', recommended: false },
};

const router = useRouter();
const account = currentAccount;
const canRename = computed(() => account.value?.role === 'owner');

const step = ref<1 | 2 | 3>(1);
const busy = ref(false);
const error = ref<string | null>(null);

// ── Step 1: who ──────────────────────────────────────────────────────────────
const name = ref(account.value?.accountName ?? '');
const artist = ref<ArtistDetails>({ ...(account.value?.profile.artist ?? blankArtist()) });

function blankArtist(): ArtistDetails {
  return { companyName: '', fullName: '', street: '', postCodeCity: '', countryOfOrigin: '', phone: '', email: '' };
}

async function saveWho(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({
      artist: artist.value,
      ...(canRename.value && name.value.trim() ? { name: name.value.trim() } : {}),
    });
    step.value = 2;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not save those details.';
  } finally {
    busy.value = false;
  }
}

// ── Step 2: modules ──────────────────────────────────────────────────────────
const modules = ref<AvailableModule[]>([]);
const wanted = ref<Set<string>>(new Set());

onMounted(async () => {
  try {
    const res = (await authFetch('/modules/available')) as { modules: AvailableModule[] };
    // Recommended first, the till at the very top: the order a new booth
    // should read them in, not the alphabet.
    modules.value = [...res.modules].sort(
      (a, b) =>
        Number(b.moduleId === 'pos') - Number(a.moduleId === 'pos') ||
        Number(guideFor(b).recommended) - Number(guideFor(a).recommended) ||
        a.title.localeCompare(b.title),
    );
    // Start from what is already on; a brand-new account has the seeded
    // defaults, which match the recommendations.
    wanted.value = new Set(res.modules.filter((m) => m.enabled).map((m) => m.moduleId));
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not load the module list.';
  }
});

function guideFor(mod: AvailableModule) {
  return GUIDE[mod.moduleId] ?? { forWhom: mod.description ?? '', recommended: false };
}

function toggleWanted(id: string): void {
  const next = new Set(wanted.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  wanted.value = next;
}

/**
 * Applies only what changed. Server first, then the running shell, so a
 * refused toggle leaves the UI honest — the same order the Modules screen uses.
 */
async function saveModules(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const changed = modules.value.filter((m) => m.enabled !== wanted.value.has(m.moduleId));
    for (const mod of changed) {
      await authFetch('/modules/toggle', {
        method: 'POST',
        body: JSON.stringify({ moduleId: mod.moduleId, enabled: !mod.enabled }),
      });
      if (mod.enabled) await unloadModule(router, mod.moduleId);
      mod.enabled = !mod.enabled;
    }
    if (changed.some((m) => m.enabled)) await loadEnabledModules(router);
    step.value = 3;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not change those modules.';
  } finally {
    busy.value = false;
  }
}

// ── Step 3: next ─────────────────────────────────────────────────────────────
const sellingOn = computed(() => wanted.value.has('pos'));

async function finish(to: { name: string; query?: Record<string, string> } = { name: 'home' }): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await updateProfile({ setupCompleted: true });
    await router.replace(to);
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not finish setup.';
    busy.value = false;
  }
}
</script>

<template>
  <section class="welcome">
    <p class="brand">Zollify<span>.</span></p>
    <ol class="steps" aria-label="Setup progress">
      <li :class="{ current: step === 1, done: step > 1 }">Who you are</li>
      <li :class="{ current: step === 2, done: step > 2 }">Modules</li>
      <li :class="{ current: step === 3 }">Next steps</li>
    </ol>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- ── 1 ─────────────────────────────────────────────────────────────── -->
    <form v-if="step === 1" class="card" @submit.prevent="saveWho">
      <h1>Welcome to Zollify</h1>
      <p class="lede">
        One app for the booth: the till, stock, events and paperwork. First, who is behind the
        table? These details go on receipts and customs documents, so they are worth getting right —
        and you can change them any time under Settings.
      </p>

      <ArtistForm v-model="artist" v-model:name="name" :can-rename="canRename" />

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="finish()">Skip setup</button>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Saving…' : 'Continue' }}</button>
      </footer>
    </form>

    <!-- ── 2 ─────────────────────────────────────────────────────────────── -->
    <form v-else-if="step === 2" class="card" @submit.prevent="saveModules">
      <h1>Switch on what you need</h1>
      <p class="lede">
        Zollify is built from modules. Turn on the ones that fit your booth — anything you leave off
        stays out of the way and can be switched on later under Modules.
      </p>

      <ul class="modules">
        <li v-for="mod in modules" :key="mod.moduleId">
          <label>
            <input
              type="checkbox"
              :checked="wanted.has(mod.moduleId)"
              :aria-describedby="`why-${mod.moduleId}`"
              @change="toggleWanted(mod.moduleId)"
            />
            <span class="body">
              <span class="title">
                {{ mod.title }}
                <span v-if="guideFor(mod).recommended" class="badge">Recommended</span>
              </span>
              <span :id="`why-${mod.moduleId}`" class="why">{{ guideFor(mod).forWhom }}</span>
            </span>
          </label>
        </li>
      </ul>
      <p v-if="!modules.length" class="empty">No modules are published on this server yet.</p>

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="step = 1">Back</button>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Applying…' : 'Continue' }}</button>
      </footer>
    </form>

    <!-- ── 3 ─────────────────────────────────────────────────────────────── -->
    <div v-else class="card">
      <h1>You're set up</h1>
      <p class="lede">
        Here is the order most booths do things in. Each one takes a minute, and none of them has
        to happen today.
      </p>

      <ol class="next">
        <li>
          <strong>Add your products</strong>
          <span>Titles, prices, sizes — and a photo if you like. Everything else reads from this.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'catalog' })">Open Catalog</button>
        </li>
        <li>
          <strong>Count what you own</strong>
          <span>One inventory for the whole booth. Events can claim a share of it.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'stock' })">Open Inventory</button>
        </li>
        <li>
          <strong>Create your first event</strong>
          <span>Every sale is filed against the active event, so make one before you sell.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'events' })">Open Events</button>
        </li>
        <li v-if="sellingOn">
          <strong>Pick how you take payment</strong>
          <span>Cash and an external card terminal work out of the box; wired terminals live under Settings → Payments.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'pos.payments' } })">Open Payments</button>
        </li>
        <li>
          <strong>Invite helpers</strong>
          <span>Give someone the till for one event without handing over the whole account.</span>
          <button type="button" :disabled="busy" @click="finish({ name: 'settings', query: { panel: 'core.team' } })">Open Team</button>
        </li>
      </ol>

      <footer class="actions">
        <button type="button" class="quiet" :disabled="busy" @click="step = 2">Back</button>
        <button type="button" class="primary" :disabled="busy" @click="finish()">{{ busy ? 'Finishing…' : 'Go to Home' }}</button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.welcome { max-width: 44rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1rem; align-self: start; }
.brand { font-weight: 800; font-size: 1.25rem; letter-spacing: -.02em; margin: 0; }
.brand span { color: var(--zfy-accent); }
.steps { list-style: none; margin: 0; padding: 0; display: flex; gap: .5rem; counter-reset: step; }
.steps li { display: flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--zfy-faint); }
.steps li::before { counter-increment: step; content: counter(step); display: grid; place-items: center; width: 1.5rem; height: 1.5rem; border-radius: 999px; border: 1px solid var(--zfy-line); font-variant-numeric: tabular-nums; }
.steps li.current { color: var(--zfy-ink); font-weight: 600; }
.steps li.current::before { background: var(--zfy-accent); border-color: var(--zfy-accent); color: var(--zfy-on-accent); }
.steps li.done { color: var(--zfy-muted); }
.steps li.done::before { content: '✓'; background: var(--zfy-accent-soft); border-color: var(--zfy-accent-soft); color: var(--zfy-accent-ink); }
.steps li + li::after { content: none; }
.card { background: var(--zfy-surface); border: 1px solid var(--zfy-line); border-radius: 14px; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
h1 { margin: 0; font-size: 1.5rem; letter-spacing: -.01em; text-wrap: balance; }
.lede { margin: 0; color: var(--zfy-muted); max-width: 60ch; }
.error { color: var(--zfy-danger); margin: 0; }
.empty { color: var(--zfy-muted); margin: 0; }
.actions { display: flex; justify-content: space-between; gap: .5rem; padding-top: .5rem; border-top: 1px solid var(--zfy-line); }
.modules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.modules label { display: flex; gap: .75rem; align-items: flex-start; padding: .75rem .9rem; border: 1px solid var(--zfy-line); border-radius: 10px; cursor: pointer; }
.modules label:hover { background: var(--zfy-surface-2); }
.modules input { margin-top: .2rem; flex: none; }
.body { display: flex; flex-direction: column; gap: .15rem; }
.title { font-weight: 600; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
.why { font-size: .875rem; color: var(--zfy-muted); }
.badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .08em; color: var(--zfy-accent-ink); background: var(--zfy-accent-soft); border-radius: 999px; padding: .1rem .5rem; }
.next { margin: 0; padding: 0 0 0 1.4rem; display: flex; flex-direction: column; gap: .85rem; }
.next li { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: .1rem .75rem; align-items: center; }
.next strong { grid-column: 1; }
.next span { grid-column: 1; font-size: .875rem; color: var(--zfy-muted); }
.next button { grid-column: 2; grid-row: 1 / span 2; white-space: nowrap; }
@media (max-width: 560px) {
  .next li { grid-template-columns: 1fr; }
  .next button { grid-column: 1; grid-row: auto; justify-self: start; margin-top: .3rem; }
}
</style>
