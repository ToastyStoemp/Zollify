import { computed, type Ref } from 'vue';
import type { Product, SalesEvent } from '@zollify/shared';
import { inCart } from '../cart';
import { sdk } from '../runtime';

/** What is left to sell at the till's event, less what is already in the cart. */
export function useStock(activeEvent: Readonly<Ref<SalesEvent | null>>) {
  const availability = computed(() => {
    const event = activeEvent.value;
    if (!event) return new Map<string, number>();
    const inv = sdk().data.inventory;
    // An item never counted and not claimed has no known stock: no figure rather
    // than "3 over stock" for every sale of it.
    return new Map(
      inv
        .availability(event.id)
        .filter((r) => r.source === 'claim' || inv.counted(r.productId, r.variantId))
        .map((r) => [`${r.productId}:${r.variantId}`, r.available]),
    );
  });
  function remaining(pid: string, vid: string | null): number | null {
    if (!activeEvent.value) return null;
    const left = availability.value.get(`${pid}:${vid ?? ''}`);
    return left === undefined ? null : left - inCart(pid, vid);
  }
  function stockLabel(pid: string, vid: string | null): { text: string; cls: string } {
    const left = remaining(pid, vid);
    if (left === null) return { text: '', cls: '' };
    if (left < 0) return { text: `${-left} over stock`, cls: 'bad' };
    if (left === 0) return { text: 'Out of stock', cls: 'bad' };
    if (left <= 3) return { text: `${left} left`, cls: 'warn' };
    return { text: `${left} in stock`, cls: 'muted' };
  }
  const productInCart = (p: Product): number => (p.variants?.length ? p.variants.reduce((s, v) => s + inCart(p.id, v.id), 0) : inCart(p.id, null));
  /** Units still sellable across a product's sizes; null when no event is active. */
  function productLeft(p: Product): number | null {
    if (!activeEvent.value) return null;
    const keys = p.variants?.length ? p.variants.map((v) => v.id) : [null];
    return keys.reduce((s, vid) => s + Math.max(0, remaining(p.id, vid) ?? 0), 0);
  }
  return { stockLabel, productInCart, productLeft };
}
