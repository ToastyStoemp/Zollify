<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { defaultProviderId, getProvider, setActiveProvider } from '../payments/registry';
import type { PaymentProviderId } from '../payments/provider';
import { loadSumupCloudStatus } from '../payments/sumup-cloud';
import { QrCode } from '@zollify/ui';
import { isNativePlatform } from '../native/plugins';
import { sdk } from '../runtime';
import SumupSoloPairing from './SumupSoloPairing.vue';

/**
 * First-run setup: how do you take card payments? Picks the terminal this
 * device uses and walks through what it needs - SumUp (account, sign-in,
 * reader) or myPOS (Go2, Carbon or Glass). A SumUp Solo works from any
 * device over the internet when the server is set up for it; every other
 * reader connects through the Android app, so on a computer this only
 * explains what to do and saves nothing for a terminal it cannot talk to. The full list,
 * with Nexi and the rest, stays under Settings → Payments.
 */
type Way = 'sumup' | 'mypos' | 'other' | 'cash';
type MyposId = 'mypos-go2' | 'mypos-carbon' | 'mypos-glass';

const way = ref<Way | null>(null);
const mypos = ref<MyposId>('mypos-go2');
type SumupReader = 'solo' | 'solo-lite' | 'air';
const sumupReader = ref<SumupReader>('solo');
/**
 * How the merchant wants to use a Solo: on its own over the internet (any
 * till device) or paired with a phone or tablet over Bluetooth. Asked, never
 * guessed. The Solo Lite and the Air only pair over Bluetooth.
 */
const soloRoute = ref<'cloud' | 'bluetooth' | null>(null);
const SUMUP_READERS: { id: SumupReader; title: string; text: string }[] = [
  { id: 'solo', title: 'Solo', text: 'With its own screen, Wi-Fi and SIM.' },
  { id: 'solo-lite', title: 'Solo Lite', text: 'The smaller Solo - always paired with a phone or tablet.' },
  { id: 'air', title: 'Air', text: 'No screen - always paired with a phone or tablet.' },
];
/** The SumUp account is connected on the server (the Solo route). */
const sumupConnected = ref(false);
const available = ref<Record<string, boolean>>({});
const status = ref<{ connected: boolean; detail?: string } | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

const MYPOS: { id: MyposId; title: string; text: string; needs: string }[] = [
  { id: 'mypos-go2', title: 'Go2', text: 'A small card reader that pairs with this device over Bluetooth.', needs: 'the Zollify Android app' },
  { id: 'mypos-carbon', title: 'Carbon', text: 'An all-in-one terminal: Zollify runs on the Carbon and takes the card on the same device.', needs: 'Zollify installed on the Carbon' },
  { id: 'mypos-glass', title: 'Glass', text: 'Tap to pay on this phone, with the myPOS Glass app.', needs: 'the Zollify Android app and myPOS Glass' },
];

/** The terminal this choice means for this device, if it is one. */
const cloud = computed(() => available.value['sumup-cloud'] === true);
const sumupProviderId = computed<PaymentProviderId | null>(() =>
  sumupReader.value !== 'solo' ? 'sumup' : soloRoute.value === 'cloud' ? 'sumup-cloud' : soloRoute.value === 'bluetooth' ? 'sumup' : null,
);
const providerId = computed<PaymentProviderId | null>(() =>
  way.value === 'sumup' ? sumupProviderId.value : way.value === 'mypos' ? mypos.value : way.value === 'cash' ? 'manual' : null,
);
const sumupTitle = computed(() => SUMUP_READERS.find((r) => r.id === sumupReader.value)!.title);
const usable = computed(() => (providerId.value ? available.value[providerId.value] === true : false));

async function refresh(): Promise<void> {
  for (const id of ['sumup', 'sumup-cloud', 'mypos-go2', 'mypos-carbon', 'mypos-glass'] as const) available.value[id] = await getProvider(id).isAvailable();
  sumupConnected.value = providerId.value === 'sumup-cloud' ? ((await loadSumupCloudStatus().catch(() => null))?.connected ?? false) : false;
  status.value = providerId.value && usable.value ? await getProvider(providerId.value).getStatus().catch((e) => ({ connected: false, detail: String(e) })) : null;
}

onMounted(async () => {
  // Never chosen: a Carbon starts on its own card reader.
  const saved = (await sdk().config.get<string>('activeProvider')) ?? defaultProviderId();
  if (saved === 'sumup' || saved === 'sumup-cloud') {
    way.value = 'sumup';
    soloRoute.value = saved === 'sumup-cloud' ? 'cloud' : 'bluetooth';
  }
  else if (saved?.startsWith('mypos-') && MYPOS.some((m) => m.id === saved)) {
    way.value = 'mypos';
    mypos.value = saved as MyposId;
  } else if (saved && saved !== 'manual') way.value = 'other';
  await refresh();
  timer = setInterval(() => void refresh(), 3000);
});
onUnmounted(() => clearInterval(timer));

/** Where to get the Android app readers need: the server's own download, when it publishes one. */
const androidApp = ref<string | null>(null);
onMounted(async () => {
  if (isNativePlatform()) return;
  try {
    if ((await fetch('/api/updates/latest')).ok) androidApp.value = `${location.origin}/api/updates/download/full`;
  } catch {
    /* none published */
  }
});

/** Remembers the choice for this device, but only a terminal it can actually use. */
async function pick(next: Way, device?: MyposId, reader?: SumupReader, route?: 'cloud' | 'bluetooth'): Promise<void> {
  error.value = null;
  way.value = next;
  if (device) mypos.value = device;
  if (reader) sumupReader.value = reader;
  if (route) soloRoute.value = route;
  await refresh();
  if (providerId.value && (usable.value || providerId.value === 'manual')) await setActiveProvider(providerId.value);
}

/** Runs one of the provider's own actions and says in words what went wrong. */
async function act(action: 'configure' | 'pairReader'): Promise<void> {
  const p = providerId.value ? getProvider(providerId.value) : null;
  const fn = p?.[action];
  if (!p || !fn) return;
  busy.value = true;
  error.value = null;
  try {
    await fn.call(p);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
    setTimeout(() => void refresh(), 1200);
  }
}

const myposDevice = computed(() => MYPOS.find((m) => m.id === mypos.value)!);
</script>

<template>
  <div class="setup">
    <p class="lede">Customers pay by card on a reader that works with Zollify. Pick yours and we set this device up for it. Skip this if you only take cash - you can come back under Settings → Payments.</p>

    <div class="ways" role="radiogroup" aria-label="How you take card payments">
      <label :class="{ on: way === 'sumup' }"><input type="radio" name="way" :checked="way === 'sumup'" @change="pick('sumup')" /><strong>SumUp</strong><span>Solo, Solo Lite or Air</span></label>
      <label :class="{ on: way === 'mypos' }"><input type="radio" name="way" :checked="way === 'mypos'" @change="pick('mypos')" /><strong>myPOS</strong><span>Go2, Carbon or Glass</span></label>
      <label :class="{ on: way === 'other' }"><input type="radio" name="way" :checked="way === 'other'" @change="pick('other')" /><strong>Another terminal</strong><span>Nexi SmartPOS and others</span></label>
      <label :class="{ on: way === 'cash' }"><input type="radio" name="way" :checked="way === 'cash'" @change="pick('cash')" /><strong>Cash for now</strong><span>Record card payments by hand</span></label>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- SumUp -->
    <div v-if="way === 'sumup'" class="devices" role="radiogroup" aria-label="Your SumUp reader">
      <label v-for="r in SUMUP_READERS" :key="r.id" :class="{ on: sumupReader === r.id }">
        <input type="radio" name="sumup-reader" :checked="sumupReader === r.id" @change="pick('sumup', undefined, r.id)" />
        <strong>{{ r.title }}</strong><span>{{ r.text }}</span>
      </label>
    </div>

    <fieldset v-if="way === 'sumup' && sumupReader === 'solo'" class="route">
      <legend>How do you want to use your Solo?</legend>
      <div class="devices" role="radiogroup" aria-label="How you use your Solo">
        <label :class="{ on: soloRoute === 'cloud' }">
          <input type="radio" name="solo-route" :checked="soloRoute === 'cloud'" @change="pick('sumup', undefined, 'solo', 'cloud')" />
          <strong>On its own, over the internet</strong><span>The till can be any device - a laptop, a tablet, a browser. The Solo stays online over Wi-Fi or its SIM.</span>
        </label>
        <label :class="{ on: soloRoute === 'bluetooth' }">
          <input type="radio" name="solo-route" :checked="soloRoute === 'bluetooth'" @change="pick('sumup', undefined, 'solo', 'bluetooth')" />
          <strong>Paired with a phone or tablet</strong><span>Over Bluetooth, with the Zollify Android app on that phone or tablet.</span>
        </label>
      </div>
    </fieldset>

    <p v-if="way === 'sumup' && providerId === 'sumup-cloud' && !cloud" class="note">
      This Zollify server is not set up to reach SumUp over the internet yet. Ask whoever runs it to switch that on - or pair the Solo with a phone or tablet for now.
    </p>

    <ol v-if="way === 'sumup' && providerId === 'sumup-cloud' && cloud" class="steps">
      <li>
        <strong>A SumUp account and a Solo</strong>
        <span>Sign up at <a href="https://www.sumup.com/" target="_blank" rel="noopener noreferrer">sumup.com</a> and get a Solo. Connect it to Wi-Fi, or use its own SIM.</span>
      </li>
      <li :class="{ done: sumupConnected }">
        <strong>Connect your SumUp account</strong>
        <span>{{ sumupConnected ? 'Connected.' : 'Sign in with your own SumUp email and password, in a window that closes by itself.' }}</span>
        <button v-if="!sumupConnected" type="button" :disabled="busy" @click="act('configure')">Connect SumUp</button>
      </li>
      <li :class="{ done: status?.connected }">
        <strong>Pair your Solo</strong>
        <SumupSoloPairing v-if="sumupConnected" @picked="refresh" />
        <span v-else>After connecting, type in the code the Solo shows.</span>
      </li>
    </ol>

    <ol v-else-if="way === 'sumup' && providerId === 'sumup'" class="steps">
      <li>
        <strong>A SumUp account and reader</strong>
        <span>Sign up at <a href="https://www.sumup.com/" target="_blank" rel="noopener noreferrer">sumup.com</a> and order a {{ sumupTitle }}.</span>
      </li>
      <li :class="{ done: status?.connected }">
        <strong>Sign in to SumUp</strong>
        <span>{{ status?.connected ? 'Signed in.' : 'With your own SumUp email and password, on SumUp’s sign-in screen. Once - this device stays signed in.' }}</span>
        <button v-if="usable && !status?.connected" type="button" :disabled="busy" @click="act('configure')">Sign in</button>
      </li>
      <li>
        <strong>Connect the reader</strong>
        <span>Switch the reader on and pair it over Bluetooth. It also connects by itself when you charge a card.</span>
        <button v-if="usable" type="button" :disabled="busy || !status?.connected" @click="act('pairReader')">Pair reader</button>
      </li>
    </ol>

    <!-- myPOS -->
    <div v-else-if="way === 'mypos'" class="mypos">
      <div class="devices" role="radiogroup" aria-label="Your myPOS device">
        <label v-for="m in MYPOS" :key="m.id" :class="{ on: mypos === m.id }">
          <input type="radio" name="mypos" :checked="mypos === m.id" @change="pick('mypos', m.id)" />
          <strong>{{ m.title }}</strong><span>{{ m.text }}</span>
        </label>
      </div>
      <ol class="steps">
        <li>
          <strong>A myPOS account</strong>
          <span>Sign up at <a href="https://www.mypos.com/" target="_blank" rel="noopener noreferrer">mypos.com</a> and get your {{ myposDevice.title }}.</span>
        </li>
        <li v-if="mypos === 'mypos-go2'" :class="{ done: status?.connected }">
          <strong>Pair the Go2</strong>
          <span v-if="usable">{{ status?.connected ? 'Terminal ready.' : 'Switch the Go2 on, allow Bluetooth when asked, and connect.' }}</span>
          <button v-if="usable && !status?.connected" type="button" :disabled="busy" @click="act('configure')">Connect</button>
        </li>
        <li v-else :class="{ done: status?.connected }">
          <strong>{{ mypos === 'mypos-carbon' ? 'Run Zollify on the Carbon' : 'Sign in to myPOS Glass' }}</strong>
          <span v-if="usable">{{ status?.detail || (status?.connected ? 'Ready.' : 'Not ready yet.') }}</span>
        </li>
      </ol>
    </div>

    <p v-else-if="way === 'other'" class="hint">Nexi SmartPOS and the other terminals are set up under Settings → Payments once you are in. Your choice there is kept for this device.</p>
    <p v-else-if="way === 'cash'" class="hint">Card payments are recorded by hand at the till: you confirm the card payment happened and the sale is booked. Add a reader any time under Settings → Payments.</p>

    <p v-if="(way === 'sumup' || way === 'mypos') && providerId && providerId !== 'sumup-cloud' && !usable" class="note">
      Readers connect through the Zollify Android app{{ way === 'mypos' ? ` (${myposDevice.needs})` : '' }}, so there is nothing to connect from here. Open Zollify on your till device and finish under <strong>Settings → Payments</strong> - the steps above are what it needs.
      <template v-if="androidApp"><br /><a :href="androidApp" download>Download the Android app</a>, or scan this with the phone or tablet:</template>
    </p>
    <QrCode v-if="androidApp && (way === 'sumup' || way === 'mypos') && providerId && providerId !== 'sumup-cloud' && !usable" :value="androidApp" :size="120" label="Android app download QR code" />
  </div>
</template>

<style scoped>
.setup { display: flex; flex-direction: column; gap: 1rem; }
.lede, .hint { margin: 0; color: var(--zfy-muted); max-width: 60ch; }
.hint { font-size: .9rem; }
.error { margin: 0; color: var(--zfy-danger); }
.note { margin: 0; padding: .7rem .9rem; border: 1px solid var(--zfy-line); border-radius: 10px; background: var(--zfy-surface-2); font-size: .875rem; color: var(--zfy-muted); }
.ways, .devices { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem; }
.ways label, .devices label { display: flex; flex-direction: column; gap: .2rem; padding: .7rem .8rem; border: 1px solid var(--zfy-line); border-radius: 10px; cursor: pointer; font-size: .85rem; }
.ways label.on, .devices label.on { border-color: var(--zfy-accent); background: var(--zfy-accent-soft); }
.ways span, .devices span { color: var(--zfy-muted); }
.ways input, .devices input { position: absolute; opacity: 0; pointer-events: none; }
.ways label:focus-within, .devices label:focus-within { outline: 2px solid var(--zfy-accent); outline-offset: 2px; }
.mypos { display: flex; flex-direction: column; gap: 1rem; }
.route { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.route legend { font-weight: 600; font-size: .9rem; margin-bottom: .4rem; }
.steps { margin: 0; padding: 0 0 0 1.4rem; display: flex; flex-direction: column; gap: .9rem; }
.steps li { display: flex; flex-direction: column; gap: .25rem; align-items: flex-start; }
.steps li span { font-size: .875rem; color: var(--zfy-muted); }
.steps li.done strong::after { content: ' ✓'; color: var(--zfy-accent-ink); }
</style>
