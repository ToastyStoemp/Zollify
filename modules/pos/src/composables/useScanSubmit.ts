import { ref, type Ref } from 'vue';
import type { Product } from '@zollify/shared';
import { isStaffBadge } from '@zollify/shared';
import { findSearchMatch } from '../search';
import { sdk } from '../runtime';
import type { Toast } from './useToast';

// A short beep via WebAudio rather than an audio file - no asset to ship,
// and it needs no user gesture beyond the one already opening the search/scan
// flow. Best-effort: some browsers block audio outside a user gesture, and
// this must never block or fail the actual add.
function beep(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => void ctx.close();
  } catch {
    // best-effort feedback only
  }
}

export interface ScanSubmitDeps {
  /** The search box: what was typed or scanned. Cleared once it is dealt with. */
  search: Ref<string>;
  products: Readonly<Ref<Product[]>>;
  toast: Toast;
  add: (productId: string, variantId: string | null) => void;
  canLock: Readonly<Ref<boolean>>;
  seller: Readonly<Ref<string>>;
}

/** Enter in the search box, or a scanned code: a staff badge, one product to add, or a code another module knows. */
export function useScanSubmit({ search, products, toast, add, canLock, seller }: ScanSubmitDeps) {
  const justAddedId = ref<string | null>(null);
  let justAddedTimer: ReturnType<typeof setTimeout> | undefined;

  function submitSearch(): void {
    // A staff badge, from a handheld scanner or the camera: hand the till over.
    if (isStaffBadge(search.value) && canLock.value) {
      const code = search.value.trim();
      search.value = '';
      void sdk()
        .lock.badge(code)
        .then(() => toast(`Selling as ${seller.value}.`, 'ok'))
        .catch((err: unknown) => toast(err instanceof Error ? err.message : 'That badge was not accepted.', 'bad'));
      return;
    }
    const match = findSearchMatch(products.value, search.value);
    if (!match) {
      const code = search.value.trim();
      // A code-like miss may be an item another module can make available
      // (an artist's label scanned at a store); words are just a failed search.
      if (!code || /\s/.test(code)) return toast('No product found for that search.', 'bad');
      void lookupUnknown(code);
      return;
    }
    if ('ambiguous' in match) return toast(`${match.count} matches - keep typing to narrow it down.`, 'bad');
    added(match.productId, match.variantId, `Added ${match.label}`);
  }

  function added(productId: string, variantId: string | null, message: string): void {
    add(productId, variantId);
    toast(message);
    search.value = '';
    navigator.vibrate?.(80);
    beep();
    justAddedId.value = productId;
    clearTimeout(justAddedTimer);
    justAddedTimer = setTimeout(() => (justAddedId.value = null), 1500);
  }

  /**
   * Asks the modules about a code the catalogue does not know. What one makes
   * available reaches this device with the next sync (the server rings it), so
   * wait a few seconds for it before adding.
   */
  async function lookupUnknown(code: string): Promise<void> {
    const found = await sdk().till.lookup(code);
    if (!found) return toast('No product found for that code.', 'bad');
    if ('handled' in found) {
      // A module took the code itself - a loyalty card attached to the sale, say.
      toast(found.message ?? 'Done.');
      search.value = '';
      beep();
      return;
    }
    for (let i = 0; i < 40 && !products.value.some((p) => p.id === found.productId); i++) await new Promise((r) => setTimeout(r, 250));
    if (!products.value.some((p) => p.id === found.productId)) return toast(`${found.message ?? 'Found it.'} It is not on this till yet - try again in a moment.`, 'bad');
    added(found.productId, found.variantId, found.message ?? 'Added');
  }

  return { justAddedId, submitSearch };
}
