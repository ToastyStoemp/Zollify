<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { authFetch, currentAccount } from '@zollify/platform';
import { Icon } from '@zollify/ui';

/**
 * The signed-in half of "sign in with another device": scan the QR the
 * signed-out device shows, check it is the device in front of you, approve.
 *
 * Reached two ways: the in-app scanner below, or a phone's own camera app
 * opening the QR's link straight onto this route with the code in `?c=`.
 */

interface Request {
  deviceName: string | null;
  device: string | null;
  flavor: string | null;
  ip: string | null;
  geo: string | null;
  createdAt: number;
}

const route = useRoute();
const router = useRouter();
const code = computed(() => (typeof route.query.c === 'string' ? route.query.c : ''));
const request = ref<Request | null>(null);
const state = ref<'idle' | 'loading' | 'ready' | 'approved' | 'denied'>('idle');
const error = ref<string | null>(null);
const busy = ref(false);

async function lookup(c: string): Promise<void> {
  request.value = null;
  error.value = null;
  if (!c) {
    state.value = 'idle';
    return;
  }
  state.value = 'loading';
  try {
    request.value = (await authFetch('/link/lookup', { method: 'POST', body: JSON.stringify({ code: c }) })) as Request;
    state.value = 'ready';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not read that code.';
    state.value = 'idle';
  }
}
watch(code, (c) => void lookup(c), { immediate: true });

async function answer(approve: boolean): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await authFetch(approve ? '/link/approve' : '/link/deny', { method: 'POST', body: JSON.stringify({ code: code.value }) });
    state.value = approve ? 'approved' : 'denied';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not answer that request.';
  } finally {
    busy.value = false;
  }
}

function scanAgain(): void {
  void router.replace({ name: 'link' });
}

// ── Scanner ──────────────────────────────────────────────────────────────────
// Same approach as the till's barcode scanner: the browser's own
// BarcodeDetector, no bundled decoder. Where it's missing, the phone's camera
// app opening the QR's link does the same job.

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}
const scannerSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
const scanning = ref(false);
const video = ref<HTMLVideoElement | null>(null);
let stream: MediaStream | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

/** Pulls the code out of whatever was scanned: the QR's link, or a bare code. */
function codeFrom(raw: string): string | null {
  const value = raw.trim();
  try {
    const url = new URL(value);
    const hash = url.hash.replace(/^#/, '');
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : url.search.slice(1);
    return new URLSearchParams(query).get('c');
  } catch {
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
  }
}

async function startScan(): Promise<void> {
  error.value = null;
  scanning.value = true;
  await nextTick();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
    if (!video.value) throw new Error('Could not open the camera view.');
    video.value.srcObject = stream;
    await video.value.play();
    const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = new Detector({ formats: ['qr_code'] });
    timer = setInterval(() => {
      if (!video.value || video.value.readyState < 2) return;
      detector
        .detect(video.value)
        .then((found) => {
          for (const f of found) {
            const c = codeFrom(f.rawValue);
            if (!c) continue;
            stopScan();
            void router.replace({ name: 'link', query: { c } });
            return;
          }
        })
        .catch(() => undefined); // one bad frame - try the next tick
    }, 300);
  } catch (err) {
    stopScan();
    error.value = err instanceof Error && err.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser settings and try again.' : 'Could not open the camera.';
  }
}

function stopScan(): void {
  clearInterval(timer);
  timer = undefined;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  scanning.value = false;
}

onBeforeUnmount(stopScan);

const asking = computed(() => {
  const r = request.value;
  if (!r) return '';
  return r.deviceName || r.device || 'An unnamed device';
});
const where = computed(() => [request.value?.device, request.value?.ip, request.value?.geo].filter(Boolean).join(' · '));
</script>

<template>
  <section class="page link-device">
    <header><h1>Sign in another device</h1></header>

    <article v-if="state === 'approved'" class="card">
      <p class="ok"><Icon name="check" :size="16" /> Approved. The other device is signing in as {{ currentAccount?.email }}.</p>
      <router-link :to="{ name: 'settings', query: { panel: 'core.security' } }" class="btn">Back to settings</router-link>
    </article>

    <article v-else-if="state === 'denied'" class="card">
      <p>Declined. The other device was not signed in.</p>
      <button type="button" @click="scanAgain">Scan another code</button>
    </article>

    <article v-else-if="state === 'ready' && request" class="card">
      <h2>Sign in this device as you?</h2>
      <div class="who">
        <strong>{{ asking }}</strong>
        <small v-if="where">{{ where }}</small>
      </div>
      <p class="warn">
        Only approve a device you can see in front of you. If someone sent you this code, decline: approving gives them full access as
        <strong>{{ currentAccount?.email }}</strong>.
      </p>
      <div class="row">
        <button type="button" class="primary" :disabled="busy" @click="answer(true)">{{ busy ? 'Working…' : 'Approve' }}</button>
        <button type="button" :disabled="busy" @click="answer(false)">Decline</button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </article>

    <article v-else class="card">
      <p v-if="state === 'loading'" class="hint">Checking the code…</p>
      <template v-else>
        <p class="hint">
          On the device you want to sign in, choose <strong>Sign in with another device</strong>, then scan the code it shows.
        </p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <template v-if="scannerSupported">
          <div v-show="scanning" class="viewfinder"><video ref="video" muted playsinline></video></div>
          <button v-if="!scanning" type="button" class="primary" @click="startScan"><Icon name="scan" :size="14" /> Scan QR code</button>
          <button v-else type="button" @click="stopScan">Stop scanning</button>
        </template>
        <p v-else class="hint">This browser can't scan codes itself. Point your phone's camera app at the code instead - it opens this screen with the code filled in.</p>
      </template>
    </article>
  </section>
</template>

<style scoped>
.link-device { max-width: 32rem; }
.card { border: 1px solid var(--zfy-line, #d6dde4); border-radius: 12px; background: var(--zfy-surface, #fff); padding: 1rem; display: flex; flex-direction: column; gap: .75rem; align-items: flex-start; }
.card h2 { margin: 0; font-size: 1rem; }
.who { display: flex; flex-direction: column; padding: .6rem .75rem; border-radius: 8px; background: var(--zfy-bg, #f1f4f6); width: 100%; box-sizing: border-box; }
.who small { color: var(--zfy-muted, #5a6472); font-size: .8rem; }
.warn { margin: 0; font-size: .85rem; color: var(--zfy-danger, #c6512f); }
.hint { margin: 0; color: var(--zfy-muted, #5a6472); font-size: .875rem; }
.error { margin: 0; color: var(--zfy-danger, #c6512f); font-size: .875rem; }
.ok { margin: 0; color: var(--zfy-accent-ink, #0a5a4a); display: inline-flex; align-items: center; gap: .35rem; font-weight: 600; }
.row { display: flex; gap: .5rem; flex-wrap: wrap; }
.viewfinder { width: 100%; aspect-ratio: 1; max-width: 22rem; border-radius: 12px; overflow: hidden; background: #000; }
.viewfinder video { width: 100%; height: 100%; object-fit: cover; display: block; }
.btn { display: inline-flex; align-items: center; gap: .35rem; min-height: 2.5rem; padding: .45rem .95rem; border-radius: 8px; border: 1px solid var(--zfy-line, #d6dde4); background: var(--zfy-surface, #fff); color: inherit; text-decoration: none; font-weight: 500; font-size: .875rem; }
.btn:hover { background: var(--zfy-surface-2, #e9edf1); }
</style>
