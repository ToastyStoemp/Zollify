<script setup lang="ts">
import type { Product } from '@zollify/shared';
import { ModalShell } from '@zollify/ui';
import ProductTile from './ProductTile.vue';

/** Type drill-down: the products of one type, in a sheet over the till. */
defineProps<{
  type: string;
  products: Product[];
  /** The product a scan just added, to flash its tile. */
  justAddedId: string | null;
}>();
const emit = defineEmits<{ add: [productId: string]; bundle: [productId: string, qty: number]; close: [] }>();
</script>

<template>
  <ModalShell :title="type" wide @close="emit('close')">
    <div class="grid inmodal">
      <ProductTile v-for="p in products" :key="p.id" :product="p" :added="p.id === justAddedId" @add="emit('add', p.id)" @bundle="(q) => emit('bundle', p.id, q)" />
    </div>
  </ModalShell>
</template>

<style scoped src="./styles/tile-grid.css"></style>
