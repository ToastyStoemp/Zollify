<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { fmtPrice } from '@zollify/shared';
import { currentAccount, displayCarts, realtimeConnected } from '@zollify/platform';
import { Icon } from '@zollify/ui';

/**
 * Customer display - ZollTool's. This device mirrors another register's cart
 * live, fed by the server's realtime relay. With several registers
 * broadcasting, pick one; otherwise the newest is followed.
 */

const THANKS_DISPLAY_MS = 8_000;
const IDLE_SCREEN_MS = 60_000;

const account = currentAccount;
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let wakeLock: { release(): Promise<void> } | null = null;

const boothName = computed(() => account.value?.profile.artist.companyName || account.value?.accountName || '');

const sources = computed(() => Object.values(displayCarts).sort((a, b) => b.receivedAt - a.receivedAt));
const selectedId = ref('');
const current = computed(() => (selectedId.value && displayCarts[selectedId.value]) || sources.value[0] || null);
/** No update for a while - the register is gone or offline. */
const stale = computed(() => !!current.value && now.value - current.value.receivedAt > 90_000);

// "Thank you!" clears itself even if the register never starts the next sale.
const thanksRaw = computed(() => !!current.value?.paid && !current.value.lines.length);
const thanksExpired = ref(false);
let thanksTimer: ReturnType<typeof setTimeout> | undefined;
watch(thanksRaw, (on) => {
  clearTimeout(thanksTimer);
  if (on) {
    thanksExpired.value = false;
    thanksTimer = setTimeout(() => (thanksExpired.value = true), THANKS_DISPLAY_MS);
  }
});
const screen = computed<'idle' | 'thanks' | 'cart'>(() => (thanksRaw.value && !thanksExpired.value ? 'thanks' : current.value?.lines.length ? 'cart' : 'idle'));

// Keep the screen lit while there is something to show; let it sleep a minute after.
let sleepTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  screen,
  async (state) => {
    if (state !== 'idle') {
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
  clock = setInterval(() => (now.value = Date.now()), 5000);
});
onUnmounted(() => {
  clearInterval(clock);
  clearTimeout(thanksTimer);
  clearTimeout(sleepTimer);
  void wakeLock?.release().catch(() => {});
});

const amount = (n: number): string => n.toFixed(2);
</script>

<template>
  <div class="display">
    <div class="controls">
      <select v-if="sources.length > 1" v-model="selectedId" aria-label="Register">
        <option value="">newest register</option>
        <option v-for="s in sources" :key="s.deviceId" :value="s.deviceId">{{ s.deviceName || s.deviceId.slice(0, 8) }}</option>
      </select>
    </div>
    <router-link :to="{ name: 'settings' }" class="exit" aria-label="Leave display mode"><Icon name="x" :size="18" /></router-link>

    <div v-if="screen === 'idle'" class="idle">
      <p v-if="boothName" class="brand">{{ boothName }}</p>
      <p v-if="!realtimeConnected" class="hint">Not connected - waiting for the server…</p>
      <p v-else class="hint pulse">Waiting for the next sale…</p>
    </div>

    <div v-else-if="screen === 'thanks' && current" class="thanks">
      <p class="big">Thank you!</p>
      <p class="paid">{{ fmtPrice(current.paid!.total, current.currency) }}</p>
    </div>

    <template v-else-if="current">
      <p class="event">{{ current.eventName }}<span v-if="stale" class="stale">register offline?</span></p>
      <div class="lines">
        <div v-for="(l, i) in current.lines" :key="i" class="line">
          <span class="name">{{ l.qty }} × {{ l.title }}<span v-if="l.variantLabel" class="muted"> · {{ l.variantLabel }}</span></span>
          <span class="sum">{{ fmtPrice(l.lineTotal, current.currency) }}</span>
        </div>
        <div v-for="d in current.discounts" :key="d.name" class="line good"><span>{{ d.name }}</span><span>− {{ fmtPrice(d.amount, current.currency) }}</span></div>
      </div>
      <div class="total">
        <p class="label">Total</p>
        <p class="figure"><span class="cur">{{ current.currency }}</span><span class="num">{{ amount(current.total) }}</span></p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.display { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; padding: 2rem; background: var(--zfy-bg); color: var(--zfy-ink); }
.controls { position: absolute; left: .75rem; top: .75rem; }
.controls select { font-size: .75rem; min-height: 1.8rem; }
.exit { position: absolute; right: .75rem; top: .75rem; padding: .4rem; border-radius: 8px; color: var(--zfy-faint); }
.exit:hover { color: var(--zfy-ink); background: var(--zfy-surface); }
.idle, .thanks { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 1rem; align-items: center; }
.brand { margin: 0; font-size: 2rem; font-weight: 700; }
.hint { margin: 0; color: var(--zfy-muted); }
.pulse { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.big { margin: 0; font-size: 2.5rem; font-weight: 800; color: var(--zfy-accent); }
.paid { margin: 0; font-size: 4rem; font-weight: 800; font-variant-numeric: tabular-nums; }
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
