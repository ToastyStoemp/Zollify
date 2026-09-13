import { openCoreDb, type ImageRec } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';

/**
 * Product images.
 *
 * Blobs live only on the device: they are large, the sync protocol carries
 * metadata rather than binary, and a booth's photos are not worth the bandwidth
 * mid-convention. A backup keeps them out too — which is why the migration
 * importer says images are not carried across.
 */

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Images were used while signed out.');
  return account.accountId;
}

/** Per-account, like every other core table. */
function db() {
  return openCoreDb(requireAccountId());
}

function uuidv7(): string {
  return crypto.randomUUID();
}

/**
 * Image pipeline: any picked file is re-encoded to a bounded JPEG plus a small
 * WebP thumbnail. A plain <input type="file" accept="image/*"> covers both the
 * web file picker and the Android camera/gallery chooser — no extra plugin.
 */

const FULL_MAX_PX = 1280;
const THUMB_MAX_PX = 200;

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function scaleTo(source: ImageBitmap | HTMLImageElement, maxPx: number, type: string, quality: number): Promise<Blob> {
  const w = 'width' in source ? source.width : 0;
  const h = 'height' in source ? source.height : 0;
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image encode failed'))), type, quality);
  });
}

export async function processImageFile(file: Blob): Promise<{ full: Blob; thumb: Blob }> {
  const bitmap = await loadBitmap(file);
  const full = await scaleTo(bitmap, FULL_MAX_PX, 'image/jpeg', 0.8);
  const thumb = await scaleTo(bitmap, THUMB_MAX_PX, 'image/webp', 0.75);
  if ('close' in bitmap) bitmap.close();
  return { full, thumb };
}

export async function saveProductImage(productId: string, file: Blob): Promise<string> {
  const { full, thumb } = await processImageFile(file);
  const rec: ImageRec = { id: uuidv7(), productId, full, thumb, updatedAt: Date.now() };
  await db().images.put(rec);
  // The thumbnail is small enough (<20KB) to ride inline in the ops stream, so
  // other devices get something to show. The full-size blob stays local: it is
  // large, and pushing it over a convention's connection would starve the sale
  // ops that actually matter.
  await queueOp({
    type: 'image.meta',
    payload: {
      imageId: rec.id,
      productId,
      updatedAt: rec.updatedAt,
      thumbB64: await blobToBase64(thumb),
    },
  });
  return rec.id;
}

export async function deleteImage(imageId: string): Promise<void> {
  await db().images.delete(imageId);
}

// ── Object-URL cache for rendering thumbs/fulls ────────────────────────────
const urlCache = new Map<string, string>();

export async function imageUrl(imageId: string | undefined, kind: 'thumb' | 'full' = 'thumb'): Promise<string | null> {
  if (!imageId) return null;
  const cacheKey = `${imageId}:${kind}`;
  const cached = urlCache.get(cacheKey);
  if (cached) return cached;
  const rec = await db().images.get(imageId);
  if (!rec) return null;
  const url = URL.createObjectURL(kind === 'thumb' ? rec.thumb : rec.full);
  urlCache.set(cacheKey, url);
  return url;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(base64: string, type: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type });
}
