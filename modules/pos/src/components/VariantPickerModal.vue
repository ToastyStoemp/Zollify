<script setup lang="ts">
import type { Product } from '@zollify/shared';
import { ModalShell } from '@zollify/ui';
import ProductTile from './ProductTile.vue';

/** Variant picker: stays open for several sizes in a row. */
defineProps<{ product: Product }>();
const emit = defineEmits<{ add: [variantId: string]; bundle: [variantId: string, qty: number]; close: [] }>();
</script>

<template>
  <ModalShell :title="product.title || 'Choose a variant'" @close="emit('close')">
    <div class="grid inmodal">
      <ProductTile v-for="v in product.variants ?? []" :key="v.id" :product="product" :variant="v" @add="emit('add', v.id)" @bundle="(q) => emit('bundle', v.id, q)" />
    </div>
  </ModalShell>
</template>

<style scoped src="./styles/tile-grid.css"></style>
