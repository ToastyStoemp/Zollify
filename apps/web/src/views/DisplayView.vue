<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { fmtPrice } from '@zollify/shared';
import {
  afterSalePrefs,
  authFetch,
  currentAccount,
  dimLayer,
  displayCarts,
  displayVideoBlob,
  displayVideoPrefs,
  listDisplayVideos,
  loadAfterSalePrefs,
  loadDisplayVideoPrefs,
  realtimeConnected,
  setDisplaySubscribed,
} from '@zollify/platform';
import { AfterSalePanel, BrandLogo, Icon } from '@zollify/ui';

/**
 * Customer display - ZollTool's. This device mirrors another register's cart
 * live, fed by the server's realtime relay. With several registers
 * broadcasting, pick one; otherwise the newest is followed.
 *
 * With videos added on this device (Settings → This device), they play while
 * no sale is on; a cart either comes over them, the video dimmed behind, or
 * takes the screen while the video waits paused - and they carry on after.
 */

const THANKS_DISPLAY_MS = 8_000;
/** Long enough to get a phone out and scan. */
const RECEIPT_DISPLAY_MS = 30_000;
const IDLE_SCREEN_MS = 60_000;

const account = currentAccount;
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let wakeLock: { release(): Promise<void> } | null = null;

const boothName = computed(() => account.value?.profile.artist.companyName || account.value?.accountName || '');
/** The logo set under POS → Receipts, shared through the server; none if POS is off or nothing is set. */
const logo = ref<string | undefined>();
async function loadLogo(): Promise<void> {
  try {
    const branding = (await authFetch('/m/pos/branding')) as { logo?: string | null };
    logo.value = branding.logo ? `data:image/png;base64,${branding.logo}` : undefined;
  } catch {
    /* no POS, or offline: the name alone still shows */
  }
}

const sources = computed(() => Object.values(displayCarts).sort((a, b) => b.receivedAt - a.receivedAt));
const selectedId = ref('');
const current = computed(() => (selectedId.value && displayCarts[selectedId.value]) || sources.value[0] || null);
/** No update for a while - the register is gone or offline. */
const stale = computed(() => !!current.value && now.value - current.value.receivedAt > 90_000);

// This display's own choice (Settings → This device), not the register's.
const receiptUrl = computed(() => (afterSalePrefs.receiptQr ? current.value?.paid?.receiptUrl : undefined));
// "Thank you!" clears itself even if the register never starts the next sale.
const thanksRaw = computed(() => !!current.value?.paid && !current.value.lines.length && (afterSalePrefs.thankYou || !!receiptUrl.value));
const thanksExpired = ref(false);
let thanksTimer: ReturnType<typeof setTimeout> | undefined;
watch(thanksRaw, (on) => {
  clearTimeout(thanksTimer);
  if (on) {
    thanksExpired.value = false;
    thanksTimer = setTimeout(() => (thanksExpired.value = true), receiptUrl.value ? RECEIPT_DISPLAY_MS : THANKS_DISPLAY_MS);
  }
});
const screen = computed<'idle' | 'thanks' | 'cart'>(() => (thanksRaw.value && !thanksExpired.value ? 'thanks' : current.value?.lines.length ? 'cart' : 'idle'));

// ── Videos between sales ────────────────────────────────────────────────────
const playlist = ref<string[]>([]);
const playing = ref(0);
const videoSrc = ref<string | null>(null);
const player = ref<HTMLVideoElement | null>(null);
/**
 * A see-through poster. Without one, Android's WebView paints its own grey
 * play button while the next video loads - a flash between every two videos.
 */
const NO_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** The browser would not start a video by itself; a tap on the screen does. */
const needsTap = ref(false);
/** Videos in a row that would not play - once every one has failed, the logo comes back. */
let failures = 0;
const videosOn = computed(() => displayVideoPrefs.enabled && playlist.value.length > 0);
/** Full screen between sales; under the cart when it comes over them; out of sight when the cart takes the screen. */
const videoShown = computed(() => videosOn.value && (screen.value === 'idle' || displayVideoPrefs.mode === 'overlay'));
const overVideo = computed(() => videoShown.value && screen.value !== 'idle');
/**
 * This device's colours for the cart over the video, as the app's own colour
 * variables - so labels, lines and the thank-you follow them too. Unset ones
 * keep the app's light or dark look.
 */
const panelStyle = computed<Record<string, string>>(() => {
  const p = displayVideoPrefs;
  return {
    ...(p.panelBg ? { '--zfy-bg': p.panelBg, '--zfy-surface': p.panelBg } : {}),
    ...(p.panelText ? { '--zfy-ink': p.panelText, '--zfy-muted': `color-mix(in srgb, ${p.panelText} 65%, transparent)`, '--zfy-line': `color-mix(in srgb, ${p.panelText} 20%, transparent)`, color: p.panelText } : {}),
    ...(p.totalColor ? { '--zfy-accent': p.totalColor } : {}),
  };
});

async function loadVideos(): Promise<void> {
  await loadDisplayVideoPrefs().catch(() => {});
  playlist.value = (await listDisplayVideos().catch(() => [])).map((v) => v.id);
  failures = 0;
  if (playlist.value.length) await cue(0);
}
async function cue(index: number): Promise<void> {
  const id = playlist.value[index];
  if (!id) return;
  playing.value = index;
  const blob = await displayVideoBlob(id).catch(() => null);
  if (videoSrc.value) URL.revokeObjectURL(videoSrc.value);
  videoSrc.value = blob ? URL.createObjectURL(blob) : null;
  if (!blob) return next();
  await nextTick();
  void play();
}
function next(): void {
  if (playlist.value.length) void cue((playing.value + 1) % playlist.value.length);
}
/** A file this device cannot play: skip it, and give up once none will. */
function failed(): void {
  failures++;
  if (failures >= playlist.value.length) {
    playlist.value = [];
    return;
  }
  next();
}
async function play(): Promise<void> {
  const v = player.value;
  if (!v || !videoShown.value) return;
  // Muted as a property too: only a silent video may start on its own.
  v.muted = true;
  try {
    await v.play();
    needsTap.value = false;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') needsTap.value = true;
  }
}
function started(): void {
  failures = 0;
}
// Pause when the cart takes the screen, carry on where it was after.
watch(videoShown, (shown) => {
  if (shown) void play();
  else player.value?.pause();
});

// Keep the screen lit while there is something to show - a sale, or the videos; let it sleep a minute after.
const awake = computed(() => screen.value !== 'idle' || videoShown.value);
let sleepTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  awake,
  async (on) => {
    if (on) {
      clearTimeout(sleepTimer);
      sleepTimer = undefined;
      if (!wakeLock) {
        try {
          wakeLock = (await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
        } catch {
          /* unsupported or denied */
        }
      }
    } else if (!sleepTimer) {
      sleepTimer = setTimeout(() => {
        sleepTimer = undefined;
        void wakeLock?.release().catch(() => {});
        wakeLock = null;
      }, IDLE_SCREEN_MS);
    }
  },
  { immediate: true },
);

onMounted(() => {
  // Only screens in display mode receive carts; registers stop sending when none are.
  setDisplaySubscribed(true);
  void loadAfterSalePrefs().catch(() => {});
  void loadLogo();
  void loadVideos();
  clock = setInterval(() => (now.value = Date.now()), 5000);
});
onUnmounted(() => {
  setDisplaySubscribed(false);
  clearInterval(clock);
  clearTimeout(thanksTimer);
  clearTimeout(sleepTimer);
  void wakeLock?.release().catch(() => {});
  if (videoSrc.value) URL.revokeObjectURL(videoSrc.value);
});

const amount = (n: number): string => n.toFixed(2);
</script>

<template>
  <div class="display" :class="{ 'with-video': videoShown, 'over-video': overVideo }">
    <video
      v-if="videoSrc"
      v-show="videoShown"
      ref="player"
      class="video"
      :src="videoSrc"
      :poster="NO_POSTER"
      muted
      playsinline
      autoplay
      preload="auto"
      :loop="playlist.length === 1"
      aria-hidden="true"
      @playing="started"
      @ended="next"
      @error="failed"
    ></video>
    <div v-if="overVideo" class="scrim" :style="{ background: dimLayer(displayVideoPrefs) }"></div>
    <button v-if="needsTap && videoShown" type="button" class="tap" @click="play">Tap to play the videos</button>
    <div class="controls">
      <select v-if="sources.length > 1" v-model="selectedId" aria-label="Register">
        <option value="">newest register</option>
        <option v-for="s in sources" :key="s.deviceId" :value="s.deviceId">{{ s.deviceName || s.deviceId.slice(0, 8) }}</option>
      </select>
    </div>
    <router-link :to="{ name: 'settings' }" class="exit" aria-label="Leave display mode"><Icon name="x" :size="18" /></router-link>

    <p v-if="screen === 'idle' && videoShown && !realtimeConnected" class="offline">Not connected - waiting for the server…</p>
    <div v-if="screen === 'idle' && videoShown" class="spacer"></div>
    <div v-else-if="screen === 'idle'" class="idle">
      <BrandLogo v-if="logo" :src="logo" size="large" />
      <p v-if="boothName" class="brand">{{ boothName }}</p>
      <p v-if="!realtimeConnected" class="hint">Not connected - waiting for the server…</p>
      <p v-else class="hint pulse">Waiting for the next sale…</p>
    </div>

    <div v-else-if="screen === 'thanks' && current" class="thanks" :class="{ panel: overVideo }" :style="overVideo ? panelStyle : undefined">
      <AfterSalePanel :thank-you="afterSalePrefs.thankYou" :total="fmtPrice(current.paid!.total, current.currency)" :receipt-url="receiptUrl" :logo="logo" :qr-size="260" />
    </div>

    <div v-else-if="current" class="cart" :class="{ panel: overVideo }" :style="overVideo ? panelStyle : undefined">
      <p class="event">{{ current.eventName }}<span v-if="stale" class="stale">register offline?</span></p>
      <div class="lines">
        <div v-for="(l, i) in current.lines" :key="i" class="line">
          <span class="name">{{ l.qty }} × {{ l.title }}<span v-if="l.variantLabel && !l.title.endsWith(l.variantLabel)" class="muted"> · {{ l.variantLabel }}</span></span>
          <span class="sum">{{ fmtPrice(l.lineTotal, current.currency) }}</span>
        </div>
        <div v-for="d in current.discounts" :key="d.name" class="line good"><span>{{ d.name }}</span><span>− {{ fmtPrice(d.amount, current.currency) }}</span></div>
      </div>
      <div class="total">
        <p class="label">Total</p>
        <p class="figure"><span class="cur">{{ current.currency }}</span><span class="num">{{ amount(current.total) }}</span></p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.display { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; padding: 2rem; background: var(--zfy-bg); color: var(--zfy-ink); }
.controls { position: absolute; left: .75rem; top: .75rem; z-index: 3; }
.controls select { font-size: .75rem; min-height: 1.8rem; }
.exit { position: absolute; right: .75rem; top: .75rem; z-index: 3; padding: .4rem; border-radius: 8px; color: var(--zfy-faint); }
.cart { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* Videos between sales: full bleed, black behind whatever does not fill the screen. */
.display.with-video { background: #000; }
.video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; z-index: 0; }
.scrim { position: absolute; inset: 0; z-index: 1; }
.spacer { flex: 1; }
.offline { position: absolute; left: 50%; bottom: 1rem; transform: translateX(-50%); z-index: 2; margin: 0; padding: .3rem .7rem; border-radius: 6px; background: rgba(0, 0, 0, .6); color: #fff; font-size: .8rem; }
.tap { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2; font-size: 1.2rem; padding: .8rem 1.4rem; }
.with-video .exit { color: rgba(255, 255, 255, .55); }
/* The cart over a playing video: on a panel of its own, readable from across the table. */
.panel { position: relative; z-index: 2; width: 100%; max-width: 48rem; margin: auto; padding: 1.5rem 2rem; border-radius: 16px; color: var(--zfy-ink); background: color-mix(in srgb, var(--zfy-bg) 96%, transparent); backdrop-filter: blur(14px); box-shadow: 0 10px 40px rgba(0, 0, 0, .35); }
.cart.panel { flex: 0 1 auto; max-height: calc(100% - 2rem); }
.panel .lines { margin-top: 1rem; }
.exit:hover { color: var(--zfy-ink); background: var(--zfy-surface); }
.idle, .thanks { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 1rem; align-items: center; }
.logo { max-width: min(22rem, 70vw); max-height: 10rem; object-fit: contain; }
.brand { margin: 0; font-size: 2rem; font-weight: 700; }
.hint { margin: 0; color: var(--zfy-muted); }
.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.event { margin: 0; text-align: center; font-size: 1.1rem; color: var(--zfy-muted); }
.stale { margin-left: .6rem; font-size: .7rem; padding: .15rem .5rem; border-radius: 4px; background: var(--zfy-signal-soft); color: var(--zfy-warning-ink); }
.lines { flex: 1; overflow-y: auto; width: 100%; max-width: 44rem; margin: 1.5rem auto 0; display: flex; flex-direction: column; gap: .6rem; }
.line { display: flex; justify-content: space-between; gap: 1rem; font-size: 1.6rem; }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sum { flex-shrink: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.muted { color: var(--zfy-muted); }
.good { color: var(--zfy-accent); }
.total { width: 100%; max-width: 44rem; margin: 0 auto; border-top: 1px solid var(--zfy-line); padding-top: 1.2rem; }
.label { margin: 0; font-size: 1.2rem; color: var(--zfy-muted); }
.figure { margin: .2rem 0 0; display: flex; justify-content: flex-end; align-items: baseline; gap: .6rem; }
.cur { font-size: 1.6rem; font-weight: 600; color: var(--zfy-accent); opacity: .7; }
.num { font-size: 5rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--zfy-accent); line-height: 1; }
@media (max-width: 640px) { .display { padding: 1.25rem; } .line { font-size: 1.15rem; } .num { font-size: 3.2rem; } }
</style>
