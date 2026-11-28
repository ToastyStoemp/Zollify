<script setup lang="ts">
import type { TillAction } from '@zollify/sdk';
import { Icon } from '@zollify/ui';
import type { Entry } from '../composables/useCatalogBrowse';
import { typeColor } from '../search';
import ProductThumb from './ProductThumb.vue';
import ProductTile from './ProductTile.vue';

/**
 * The till's floor: one tile per artist, type or product (whatever the browse
 * mode and the search come to), then the tiles other modules add. Says what
 * was tapped; opening, adding and running are the till's.
 */
defineProps<{
  entries: Entry[];
  /** Tiles other modules put on the till. */
  actionTiles: TillAction[];
  /** The artist drilled into while browsing by artist: shown as a way back. Null when not inside one. */
  insideArtist: string | null;
  /** What is in the search box, for the wording of the empty state. */
  search: string;
  /** The product a scan just added, to flash its tile (or its group's). */
  justAddedId: string | null;
}>();
const emit = defineEmits<{
  openArtist: [key: string | null];
  openType: [type: string];
  add: [productId: string];
  bundle: [productId: string, qty: number];
  action: [action: TillAction];
}>();
</script>

<template>
  <div v-if="insideArtist !== null" class="crumb">
    <button type="button" class="quiet" @click="emit('openArtist', null)"><Icon name="arrow-left" :size="14" /> All artists</button>
    <strong>{{ insideArtist }}</strong>
  </div>

  <p v-if="!entries.length && !actionTiles.length" class="empty">{{ search ? 'Nothing matches that search.' : 'No products for sale yet - add some under Products.' }}</p>
  <div v-else class="grid">
    <template v-for="e in entries" :key="e.key">
      <button v-if="'artist' in e" type="button" class="tile type artist" :aria-label="`${e.artist.name}, ${e.artist.products.length} products`" :class="{ dim: e.artist.stock === 0, added: e.artist.products.some((p) => p.id === justAddedId) }" @click="emit('openArtist', e.artist.key)">
        <span v-if="e.artist.inCart" class="count">{{ e.artist.inCart }}</span>
        <span class="head">
          <ProductThumb v-if="e.artist.products.find((p) => p.imageId)" :image-id="e.artist.products.find((p) => p.imageId)!.imageId!" :alt="''" :size="36" />
          <span class="title">{{ e.artist.name }}</span>
        </span>
        <small>{{ e.artist.products.length }} product{{ e.artist.products.length === 1 ? '' : 's' }}</small>
        <span class="foot">
          <span :class="e.artist.stock === 0 ? 'bad' : 'muted'">{{ e.artist.stock === null ? '' : e.artist.stock === 0 ? 'Out of stock' : `${e.artist.stock} in stock` }}</span>
          <Icon name="chevron-right" :size="14" />
        </span>
      </button>
      <button v-else-if="'group' in e" type="button" class="tile type" :aria-label="`${e.group.type}, ${e.group.products.length} products`" :style="{ borderLeftColor: typeColor(e.group.type) }" :class="{ dim: e.group.stock === 0, added: e.group.products.some((p) => p.id === justAddedId) }" @click="emit('openType', e.group.type)">
        <span v-if="e.group.inCart" class="count">{{ e.group.inCart }}</span>
        <span class="title" :style="{ color: typeColor(e.group.type) }">{{ e.group.type }}</span>
        <small>{{ e.group.products.length }} products</small>
        <span class="foot">
          <span :class="e.group.stock === 0 ? 'bad' : 'muted'">{{ e.group.stock === null ? '' : e.group.stock === 0 ? 'Out of stock' : `${e.group.stock} in stock` }}</span>
          <Icon name="chevron-right" :size="14" />
        </span>
      </button>
      <ProductTile v-else :product="e.product" dim-when-out :added="e.product.id === justAddedId" @add="emit('add', e.product.id)" @bundle="(q) => emit('bundle', e.product.id, q)" />
    </template>
    <button v-for="a in actionTiles" :key="`action:${a.id}`" type="button" class="tile" :aria-label="a.label" @click="emit('action', a)">
      <span class="head">
        <Icon :name="a.icon ?? 'plus'" :size="36" />
        <span class="title">{{ a.label }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped src="./styles/tile-grid.css"></style>
<style scoped src="./styles/tile.css"></style>
<style scoped>
.empty { color: var(--zfy-muted, #5a6472); margin: 0; padding: 1rem; font-size: .9rem; }
.crumb { display: flex; align-items: center; gap: .6rem; margin: 0 0 .5rem; }
.crumb button { min-height: 2rem; display: inline-flex; align-items: center; gap: .3rem; font-size: .82rem; }
</style>
