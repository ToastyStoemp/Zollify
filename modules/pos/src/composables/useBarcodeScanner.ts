import { nextTick, onUnmounted, ref, type Ref } from 'vue';
import { sdk } from '../runtime';
import type { Toast } from './useToast';

// ── Barcode scanner (camera) ─────────────────────────────────────────────────
// Native BarcodeDetector rather than a bundled decoder library: our own
// labels are Code128 (see @zollify/label-printer), which it covers, and it
// needs no dependency - Chrome/Edge desktop and Android support it, same
// browsers this app already requires elsewhere (Web Bluetooth). Not in the
// standard DOM types yet, hence the local shape below instead of `any`.
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}
/** focusMode/zoom aren't in the standard MediaTrackConstraints type yet either, same reasoning as BarcodeDetectorLike above. */
interface ScannerVideoConstraints extends MediaTrackConstraints {
  advanced?: (MediaTrackConstraintSet & { focusMode?: string; zoom?: number | { ideal: number } })[];
}
const scannerSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window;
/** ideal, not exact: zoom/focusMode are non-standard and a bare value would be an EXACT constraint - if the device's range doesn't include it exactly, the whole `advanced` set gets skipped rather than getting as close as it can. */
const BASE_CAMERA_CONSTRAINTS: ScannerVideoConstraints = {
  // 1920x1080 ideal, not a smaller size: some phones asked for a resolution
  // well under their native sensor mode hand back a CENTER-CROPPED region
  // instead of a full-frame downscale - a real Android camera-HAL quirk
  // that also looks exactly like "zoomed in".
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  advanced: [{ focusMode: 'continuous' }, { zoom: { ideal: 1 } }],
};

export interface BarcodeScannerDeps {
  /** The search box: a code the camera reads is put there and submitted like a typed one. */
  search: Ref<string>;
  submitSearch: () => void;
  toast: Toast;
}

/** The camera scanner: opens the camera, looks for a Code128 barcode a few times a second, and submits what it reads. */
export function useBarcodeScanner({ search, submitSearch, toast }: BarcodeScannerDeps) {
  const scannerOpen = ref(false);
  const scannerError = ref<string | null>(null);
  const scannerInfo = ref<string | null>(null);
  const scannerVideo = ref<HTMLVideoElement | null>(null);
  let scannerStream: MediaStream | null = null;
  let scannerTimer: ReturnType<typeof setInterval> | undefined;

  // Chrome/Android has a known unfixed bug (crbug 40749120): facingMode
  // "environment" sometimes binds to a phone's telephoto lens instead of the
  // main wide one, which looks exactly like "the camera is zoomed in" and
  // can't be fixed with a zoom constraint (that only zooms *within* whichever
  // lens got picked). No reliable way to detect which lens is which from
  // enumerateDevices() labels across vendors, so instead: let the user cycle
  // through the phone's cameras once and remember which one worked.
  const cameraDeviceId = ref<string | null>(null);
  const cameraDevices = ref<MediaDeviceInfo[]>([]);
  const currentCameraId = ref<string | null>(null);

  /** The <video> the camera plays in; set by the scanner modal while it is open. */
  function setScannerVideo(el: HTMLVideoElement | null): void {
    scannerVideo.value = el;
  }

  async function startCamera(deviceId?: string): Promise<void> {
    scannerStream?.getTracks().forEach((t) => t.stop());
    const constraints: ScannerVideoConstraints = deviceId
      ? { ...BASE_CAMERA_CONSTRAINTS, deviceId: { exact: deviceId } }
      : { ...BASE_CAMERA_CONSTRAINTS, facingMode: { ideal: 'environment' } };
    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({ video: constraints });
    } catch {
      // Saved device is gone (unplugged, permissions reset elsewhere) - fall
      // back to the default pick rather than failing outright.
      scannerStream = await navigator.mediaDevices.getUserMedia({ video: { ...BASE_CAMERA_CONSTRAINTS, facingMode: { ideal: 'environment' } } });
    }
    const video = scannerVideo.value;
    if (!video) throw new Error('Could not open the camera view.');
    video.srcObject = scannerStream;
    await video.play();

    // Genuinely can't verify camera behaviour remotely - this is the
    // practical alternative: show exactly what the device actually granted,
    // so "still zoomed in" becomes a fact (the wrong resolution/zoom value)
    // instead of another guess to chase blind.
    const track = scannerStream.getVideoTracks()[0];
    const settings = track?.getSettings() as MediaTrackSettings & { zoom?: number; focusMode?: string };
    currentCameraId.value = settings?.deviceId ?? null;
    if (settings) {
      const bits = [
        settings.width && settings.height ? `${settings.width}x${settings.height}` : null,
        settings.zoom != null ? `zoom ${settings.zoom}` : null,
        settings.facingMode ? settings.facingMode : null,
        track?.label || null,
      ].filter(Boolean);
      scannerInfo.value = bits.join(' · ');
    }

    // Device labels are only populated once permission is granted - the
    // getUserMedia call above is what grants it, so this has to run after.
    // Only once per session: the device list doesn't change while open.
    if (!cameraDevices.value.length) {
      const all = await navigator.mediaDevices.enumerateDevices();
      cameraDevices.value = all.filter((d) => d.kind === 'videoinput');
    }
  }

  async function cycleCamera(): Promise<void> {
    if (cameraDevices.value.length < 2) return;
    const i = cameraDevices.value.findIndex((d) => d.deviceId === currentCameraId.value);
    const next = cameraDevices.value[(i + 1) % cameraDevices.value.length]!;
    try {
      await startCamera(next.deviceId);
      cameraDeviceId.value = next.deviceId;
      void sdk().config.set('cameraDeviceId', next.deviceId);
    } catch (err) {
      scannerError.value = err instanceof Error ? err.message : 'Could not switch camera.';
    }
  }

  async function openScanner(): Promise<void> {
    if (!scannerSupported) return toast('Barcode scanning needs a newer Chrome or Edge - not available on this device.', 'bad');
    scannerError.value = null;
    scannerInfo.value = null;
    scannerOpen.value = true;
    await nextTick();
    try {
      await startCamera(cameraDeviceId.value ?? undefined);

      const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
      const detector = new Detector({ formats: ['code_128'] });
      scannerTimer = setInterval(() => {
        if (!scannerVideo.value || scannerVideo.value.readyState < 2) return;
        detector
          .detect(scannerVideo.value)
          .then((codes) => {
            const value = codes[0]?.rawValue;
            if (!value) return;
            closeScanner();
            search.value = value;
            submitSearch();
          })
          .catch(() => undefined); // one bad frame - try the next tick
      }, 300);
    } catch (err) {
      scannerError.value = err instanceof Error ? err.message : 'Could not access the camera.';
    }
  }

  function closeScanner(): void {
    scannerOpen.value = false;
    scannerInfo.value = null;
    clearInterval(scannerTimer);
    scannerTimer = undefined;
    scannerStream?.getTracks().forEach((t) => t.stop());
    scannerStream = null;
  }
  onUnmounted(closeScanner);

  return { scannerOpen, scannerError, scannerInfo, setScannerVideo, cameraDeviceId, cameraDevices, openScanner, closeScanner, cycleCamera };
}
