<script setup lang="ts">
import type { Product, Variant } from '@zollify/shared';
import { inCart } from '../cart';
import { useTillMoney } from '../composables/useTillMoney';
import { useTillTiles } from '../lib/till-tiles';
import { typeColor } from '../search';
import ProductThumb from './ProductThumb.vue';

/**
 * One product on the till - or, with `variant`, one of its variants in the
 * variant picker. Shows the photo, name, SKU, bundle chips, stock and price,
 * and how many are in the cart. A tap asks the till to add it.
 */
const props = defineProps<{
  product: Product;
  /** Set in the variant picker: the tile is this variant of `product`. */
  variant?: Variant;
  /** Fade the tile when nothing is left to sell (the floor grid does, the sheets do not). */
  dimWhenOut?: boolean;
  /** Just added by a scan: flash once. */
  added?: boolean;
}>();
const emit = defineEmits<{ add: []; bundle: [qty: number] }>();

const { stockLabel, productInCart, productLeft, bundleQtys } = useTillTiles();
const { price, fromPrice } = useTillMoney();

const vid = (): string | null => props.variant?.id ?? null;
const hasVariants = (): boolean => !props.variant && !!props.product.variants?.length;
const count = (): number => (props.variant ? inCart(props.product.id, props.variant.id) : productInCart(props.product));
/** The "+3 / +5" chips; a product with variants has them on its variants instead. */
const bundles = (): number[] => (props.variant ? bundleQtys(props.product, props.variant.id) : props.product.variants?.length ? [] : bundleQtys(props.product));
function priceLabel(): string {
  const p = props.product;
  if (props.variant) return price(p.id, props.variant.id, props.variant.price ?? p.price);
  return p.variants?.length ? fromPrice(p) : price(p.id, null, p.price);
}
</script>

<template>
  <button
    type="button"
    class="tile"
    :aria-label="variant ? variant.name || 'Variant' : product.title || 'Untitled product'"
    :style="variant ? undefined : { borderLeftColor: typeColor(product.type) }"
    :class="variant ? undefined : { dim: dimWhenOut && (productLeft(product) ?? 1) <= 0, added }"
    @click="emit('add')"
  >
    <span v-if="count()" class="count">{{ count() }}</span>
    <span class="head">
      <!-- A variant shows only its own photo - the product's would misrepresent the variant. -->
      <ProductThumb v-if="variant ? variant.imageId : product.imageId" :image-id="(variant ? variant.imageId : product.imageId)!" :alt="variant ? variant.name : product.title" :size="36" />
      <span class="title">{{ (variant ? variant.name : product.title) || '(untitled)' }}</span>
    </span>
    <small v-if="variant ? variant.sku : product.sku">{{ variant ? variant.sku : product.sku }}</small>
    <span v-if="bundles().length" class="bundles">
      <span v-for="q in bundles()" :key="q" role="button" tabindex="0" class="bundle" @click.stop="emit('bundle', q)" @keydown.enter.stop.prevent="emit('bundle', q)" @keydown.space.stop.prevent="emit('bundle', q)">+{{ q }}</span>
    </span>
    <span class="foot">
      <span :class="stockLabel(product.id, vid()).cls">{{ hasVariants() ? `${product.variants.length} sizes` : stockLabel(product.id, vid()).text }}</span>
      <strong>{{ priceLabel() }}</strong>
    </span>
  </button>
</template>

<style scoped src="./styles/tile.css"></style>
