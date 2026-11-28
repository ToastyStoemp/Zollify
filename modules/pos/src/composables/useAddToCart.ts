import { ref, type Ref } from 'vue';
import type { Product } from '@zollify/shared';
import { addLine } from '../cart';
import { sdk } from '../runtime';

/** Adding a product to the cart: straight in, through the variant picker, or a bundle's worth at once. */
export function useAddToCart(products: Readonly<Ref<Product[]>>) {
  const variantPicker = ref<Product | null>(null);

  function add(pid: string, vid: string | null): void {
    const p = products.value.find((x) => x.id === pid);
    if (!p) return;
    const variants = p.variants ?? [];
    if (variants.length && !vid) {
      variantPicker.value = p;
      return;
    }
    const v = vid ? variants.find((x) => x.id === vid) : undefined;
    addLine({
      productId: p.id,
      variantId: v?.id ?? null,
      variantLabel: v?.name ?? null,
      sku: v?.sku ?? p.sku ?? null,
      name: v ? `${p.title} · ${v.name}` : p.title,
      qty: 1,
      unitPrice: v?.price ?? p.price,
      // Set at checkout from the event's VAT; p.vatRate is the Swiss import rate.
      taxRate: null,
      type: p.type,
    });
  }

  /** Tier quantities of tiered rules on this product drive the "+3 / +5" chips. */
  function bundleQtys(p: Product, vid: string | null = null): number[] {
    const qtys = new Set<number>();
    for (const rule of sdk().data.discounts.active()) {
      if (rule.type !== 'tiered' || !rule.tiers?.length || rule.hideQuickAdd) continue;
      const matches = rule.productIds.includes(p.id) || (!!p.type && (rule.productTypes ?? []).includes(p.type)) || (vid !== null && rule.variantIds.includes(`${p.id}:${vid}`));
      if (!matches) continue;
      for (const t of rule.tiers) if (t.qty > 1) qtys.add(t.qty);
    }
    return [...qtys].sort((a, b) => a - b).slice(0, 3);
  }
  function addBundle(pid: string, vid: string | null, qty: number): void {
    for (let i = 0; i < qty; i++) add(pid, vid);
  }
  return { variantPicker, add, bundleQtys, addBundle };
}
