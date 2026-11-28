import { computed, ref, watch, type Ref } from 'vue';
import type { Product, SalesEvent } from '@zollify/shared';
import { isStore } from '@zollify/shared';
import { sdk } from '../runtime';

// ── Browsing: by artist, by type, or flat ───────────────────────────────────
// A store's till sells many artists' work, so it opens by artist; a booth's
// till sells one artist's and opens by type. Each remembers its own choice.
export type ViewMode = 'flat' | 'grouped' | 'artists';
export interface BrowseMode {
  id: ViewMode;
  label: string;
  icon: string;
}
export interface ArtistGroup {
  key: string;
  name: string;
  products: Product[];
  stock: number | null;
  inCart: number;
}
export interface TypeGroup {
  type: string;
  products: Product[];
  stock: number | null;
  inCart: number;
}
export type Entry = { key: string; product: Product } | { key: string; group: TypeGroup } | { key: string; artist: ArtistGroup };

const VIEW_KEY = 'zollify.pos.view';
const STORE_VIEW_KEY = 'zollify.pos.view.store';
const readMode = (key: string): ViewMode | null => {
  try {
    const v = localStorage.getItem(key);
    return v === 'flat' || v === 'grouped' || v === 'artists' ? v : null;
  } catch {
    return null;
  }
};
const artistKey = (p: Product): string => p.consignorId ?? '';

export interface CatalogBrowseDeps {
  search: Ref<string>;
  products: Readonly<Ref<Product[]>>;
  activeEvent: Readonly<Ref<SalesEvent | null | undefined>>;
  productLeft: (p: Product) => number | null;
  productInCart: (p: Product) => number;
}

/** What the product grid shows: the browse mode, the artist or type drilled into, and the tiles that follow from them. */
export function useCatalogBrowse({ search, products, activeEvent, productLeft, productInCart }: CatalogBrowseDeps) {
  const boothMode = ref<ViewMode>(readMode(VIEW_KEY) === 'flat' ? 'flat' : 'grouped');
  const storeMode = ref<ViewMode>(readMode(STORE_VIEW_KEY) ?? 'artists');
  const atStore = computed(() => isStore(activeEvent.value));
  /** Whether this business runs stores at all: decides where "open one" points. */
  const sellsStores = computed(() => Boolean(sdk().account()?.profile.sells?.stores) || sdk().data.events.list().some((e) => isStore(e) && !e.deletedAt));
  /** Artists only mean something when the catalogue has their work in it. */
  const hasArtists = computed(() => products.value.some((p) => p.consignorId));
  const viewMode = computed<ViewMode>(() => {
    const mode = atStore.value ? storeMode.value : boothMode.value;
    return mode === 'artists' && !hasArtists.value ? 'grouped' : mode;
  });
  /** The browse modes on offer, for the pills (wide) and the single picker (narrow). */
  const viewModes = computed<BrowseMode[]>(() => [
    ...(atStore.value && hasArtists.value ? [{ id: 'artists' as ViewMode, label: 'Artists', icon: 'users' }] : []),
    { id: 'flat' as ViewMode, label: 'All', icon: 'package' },
    { id: 'grouped' as ViewMode, label: 'Types', icon: 'layers' },
  ]);
  const currentMode = computed(() => viewModes.value.find((m) => m.id === viewMode.value) ?? viewModes.value[0]!);
  function setViewMode(mode: ViewMode): void {
    if (atStore.value) storeMode.value = mode;
    else boothMode.value = mode;
    openArtist.value = null;
    try {
      localStorage.setItem(atStore.value ? STORE_VIEW_KEY : VIEW_KEY, mode);
    } catch {
      /* no storage */
    }
  }

  /** The artist being browsed, by consignor id; '' = the store's own items. */
  const openArtist = ref<string | null>(null);
  watch(() => activeEvent.value?.id, () => (openArtist.value = null));
  const artistGroups = computed<ArtistGroup[]>(() => {
    const map = new Map<string, Product[]>();
    for (const p of products.value) (map.get(artistKey(p)) ?? map.set(artistKey(p), []).get(artistKey(p))!).push(p);
    const own = sdk().account()?.accountName || 'Our own';
    return [...map.entries()]
      .map(([key, list]) => ({
        key,
        name: key ? (list.find((p) => p.consignorName)?.consignorName ?? 'Artist') : own,
        products: list,
        stock: activeEvent.value ? list.reduce((s, p) => s + (productLeft(p) ?? 0), 0) : null,
        inCart: list.reduce((s, p) => s + productInCart(p), 0),
      }))
      .sort((a, b) => Number(!a.key) - Number(!b.key) || a.name.localeCompare(b.name));
  });
  const openArtistName = computed(() => artistGroups.value.find((g) => g.key === openArtist.value)?.name ?? '');
  /** What the type grouping works on: one artist's items while browsing by artist. */
  const scoped = computed(() => (viewMode.value === 'artists' && openArtist.value !== null ? products.value.filter((p) => artistKey(p) === openArtist.value) : products.value));

  const filtered = computed(() => {
    const q = search.value.trim().toLowerCase();
    if (!q) return products.value;
    return products.value.filter((p) =>
      [p.title, p.sku, p.type, ...(p.variants ?? []).flatMap((v) => [v.name, v.sku])].filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  });
  /** Searching always shows flat results; grouping is for browsing. */
  const grouped = computed(() => viewMode.value !== 'flat' && !search.value.trim());

  const typeGroups = computed<TypeGroup[]>(() => {
    const map = new Map<string, Product[]>();
    for (const p of scoped.value) (map.get(p.type || '(no type)') ?? map.set(p.type || '(no type)', []).get(p.type || '(no type)')!).push(p);
    return [...map.entries()].map(([type, list]) => ({
      type,
      products: list,
      stock: activeEvent.value ? list.reduce((s, p) => s + (productLeft(p) ?? 0), 0) : null,
      inCart: list.reduce((s, p) => s + productInCart(p), 0),
    }));
  });
  const entries = computed<Entry[]>(() => {
    if (!grouped.value) return filtered.value.map((p) => ({ key: p.id, product: p }));
    if (viewMode.value === 'artists' && openArtist.value === null && artistGroups.value.length > 1) {
      return artistGroups.value.map((g) => ({ key: `a:${g.key}`, artist: g }));
    }
    return typeGroups.value.map((g) => (g.products.length === 1 ? { key: g.products[0]!.id, product: g.products[0]! } : { key: `t:${g.type}`, group: g }));
  });
  const openType = ref<string | null>(null);
  const typeProducts = computed(() => (openType.value === null ? [] : scoped.value.filter((p) => (p.type || '(no type)') === openType.value)));

  return { atStore, sellsStores, viewMode, viewModes, currentMode, setViewMode, openArtist, openArtistName, grouped, entries, openType, typeProducts };
}
