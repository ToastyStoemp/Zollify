<script setup lang="ts">
import { Icon, ModalShell } from '@zollify/ui';

/** The camera scanner's sheet: the live picture, a camera switch, and what the device granted. The camera itself is useBarcodeScanner's. */
const props = defineProps<{
  error: string | null;
  /** What the camera actually granted (size, zoom, lens), shown small. */
  info: string | null;
  /** More than one camera to cycle through. */
  canSwitch: boolean;
  /** Hands the <video> to the scanner while this sheet is open. */
  setVideo: (el: HTMLVideoElement | null) => void;
}>();
const emit = defineEmits<{ switch: []; close: [] }>();
// One function for the life of the sheet, so the <video> is handed over once and taken back once.
function videoRef(el: unknown): void {
  props.setVideo(el as HTMLVideoElement | null);
}
</script>

<template>
  <!-- ── Barcode scanner ───────────────────────────────────────────────── -->
  <ModalShell title="Scan barcode" @close="emit('close')">
    <p v-if="error" class="warn">{{ error }}</p>
    <div class="scanner-wrap">
      <video :ref="videoRef" class="scanner-video" autoplay playsinline muted></video>
      <button v-if="canSwitch" type="button" class="quiet iconbtn scanner-switch" aria-label="Switch camera" title="Switch camera" @click="emit('switch')">
        <Icon name="refresh-cw" :size="16" />
      </button>
    </div>
    <p class="hint">Point the camera at a barcode.</p>
    <p v-if="info" class="hint mono">{{ info }}</p>
  </ModalShell>
</template>

<style scoped>
.iconbtn { display: inline-flex; align-items: center; min-height: 2rem; padding: .3rem; color: var(--zfy-muted, #5a6472); border-radius: 8px; }
.iconbtn:hover { background: var(--zfy-bg, #f1f4f6); color: var(--zfy-ink, #1a2230); }
.scanner-wrap { position: relative; }
.scanner-video { width: 100%; max-height: 60vh; border-radius: 10px; background: #000; object-fit: contain; }
.scanner-switch { position: absolute; top: .5rem; right: .5rem; background: rgba(0, 0, 0, .5); color: #fff; }
.scanner-switch:hover { background: rgba(0, 0, 0, .7); color: #fff; }
.hint.mono { font-family: ui-monospace, monospace; font-size: .72rem; word-break: break-word; }
.hint { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
.warn { color: var(--zfy-warning-ink, #8a5a1e); }
</style>
