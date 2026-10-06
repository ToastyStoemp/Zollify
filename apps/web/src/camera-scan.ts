/**
 * The camera as a barcode scanner, with the browser's own BarcodeDetector -
 * the same approach as the till's scanner and device linking. Where the
 * browser has none, the caller hides its camera button.
 */

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

export const cameraScanSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

/**
 * Streams the back camera into `video` and calls `onCode` for every code it
 * reads; `accept` decides whether a code is the one wanted, and the scan stops
 * on the first that is. Returns the function that stops it.
 */
export async function startCameraScan(video: HTMLVideoElement, formats: string[], accept: (code: string) => boolean, onCode: (code: string) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
  };
  try {
    video.srcObject = stream;
    await video.play();
    const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    const detector = new Detector({ formats });
    timer = setInterval(() => {
      if (video.readyState < 2) return;
      detector
        .detect(video)
        .then((found) => {
          const hit = found.map((f) => f.rawValue.trim()).find(accept);
          if (!hit) return;
          stop();
          onCode(hit);
        })
        .catch(() => undefined); // one bad frame - try the next tick
    }, 250);
  } catch (err) {
    stop();
    throw err;
  }
  return stop;
}
