import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { Product } from '@zollify/shared';
import type { Sdk } from '@zollify/sdk';
import { setSdk } from '../runtime';
import { useScanSubmit } from '../composables/useScanSubmit';

/**
 * Enter in the search box (a scanner types and presses Enter): what the till
 * does with a known code, an unclear one, an unknown one and a staff badge.
 * Written when this left PosView.vue, to pin down what it did there.
 */

const product = (id: string, title: string, sku: string, variants: Product['variants'] = []): Product => ({ id, title, sku, forSale: true, unlisted: false, price: 5, variants }) as Product;
const catalogue = [product('p1', 'Cat sticker', 'STK-CAT'), product('p2', 'Cat pin', 'PIN-CAT'), product('p3', 'Print', 'PRT', [{ id: 'a4', name: 'A4', sku: 'PRT-A4' }])];

const lookup = vi.fn();
const badge = vi.fn();
const fake = { till: { lookup }, lock: { badge } } as unknown as Sdk;

function till(canLock = false) {
  const search = ref('');
  const products = ref<Product[]>([...catalogue]);
  const toasts: [string, string?][] = [];
  const add = vi.fn();
  const scan = useScanSubmit({ search, products, toast: (text, kind) => toasts.push(kind ? [text, kind] : [text]), add, canLock: ref(canLock), seller: ref('sam') });
  const enter = (text: string): void => {
    search.value = text;
    scan.submitSearch();
  };
  return { search, products, toasts, add, enter, ...scan };
}

beforeEach(() => {
  setSdk(fake);
  lookup.mockReset();
  badge.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('scan submit', () => {
  it('adds the product a known code names, says so, and clears the box', () => {
    const t = till();
    t.enter('stk-cat');
    expect(t.add).toHaveBeenCalledExactlyOnceWith('p1', null);
    expect(t.toasts).toEqual([['Added Cat sticker']]);
    expect(t.search.value).toBe('');
    expect(t.justAddedId.value).toBe('p1');
    vi.advanceTimersByTime(1500);
    expect(t.justAddedId.value).toBeNull();
  });

  it('adds the variant a variant code names', () => {
    const t = till();
    t.enter('PRT-A4');
    expect(t.add).toHaveBeenCalledExactlyOnceWith('p3', 'a4');
    expect(t.toasts).toEqual([['Added Print - A4']]);
  });

  it('adds nothing while several products match, and keeps what was typed', () => {
    const t = till();
    t.enter('cat');
    expect(t.add).not.toHaveBeenCalled();
    expect(t.toasts).toEqual([['2 matches - keep typing to narrow it down.', 'bad']]);
    expect(t.search.value).toBe('cat');
  });

  it('treats words that match nothing as a failed search, without asking the modules', () => {
    const t = till();
    t.enter('blue whale');
    expect(lookup).not.toHaveBeenCalled();
    expect(t.toasts).toEqual([['No product found for that search.', 'bad']]);
  });

  it('asks the modules about an unknown code, and says when none knows it', async () => {
    lookup.mockResolvedValue(null);
    const t = till();
    t.enter('ART-0042');
    expect(lookup).toHaveBeenCalledExactlyOnceWith('ART-0042');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.add).not.toHaveBeenCalled();
    expect(t.toasts).toEqual([['No product found for that code.', 'bad']]);
  });

  it('lets a module take an unknown code itself', async () => {
    lookup.mockResolvedValue({ handled: true, message: 'Loyalty card attached.' });
    const t = till();
    t.enter('LOYAL-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.add).not.toHaveBeenCalled();
    expect(t.toasts).toEqual([['Loyalty card attached.']]);
    expect(t.search.value).toBe('');
  });

  it('waits for a product a module makes available, then adds it', async () => {
    lookup.mockResolvedValue({ productId: 'p9', variantId: null, message: 'Added from Ada' });
    const t = till();
    t.enter('ART-0042');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.add).not.toHaveBeenCalled();
    t.products.value = [...catalogue, product('p9', 'Ada print', 'ART-0042')];
    await vi.advanceTimersByTimeAsync(250);
    expect(t.add).toHaveBeenCalledExactlyOnceWith('p9', null);
    expect(t.toasts).toEqual([['Added from Ada']]);
  });

  it('gives up after ten seconds when that product never arrives', async () => {
    lookup.mockResolvedValue({ productId: 'p9', variantId: null });
    const t = till();
    t.enter('ART-0042');
    await vi.advanceTimersByTimeAsync(9900);
    expect(t.toasts).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.add).not.toHaveBeenCalled();
    expect(t.toasts).toEqual([['Found it. It is not on this till yet - try again in a moment.', 'bad']]);
  });

  it('hands the till over on a staff badge when the till can lock', async () => {
    const code = 'ZS-123456789012345678901234';
    badge.mockResolvedValue(undefined);
    const t = till(true);
    t.enter(code);
    expect(badge).toHaveBeenCalledExactlyOnceWith(code);
    expect(t.search.value).toBe('');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.toasts).toEqual([['Selling as sam.', 'ok']]);
    expect(t.add).not.toHaveBeenCalled();
  });

  it('reads a staff badge as an ordinary code on a till that cannot lock', async () => {
    lookup.mockResolvedValue(null);
    const t = till(false);
    t.enter('ZS-123456789012345678901234');
    expect(badge).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledOnce();
  });
});
