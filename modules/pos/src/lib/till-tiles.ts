import { inject, provide, type InjectionKey } from 'vue';
import type { Product } from '@zollify/shared';

/**
 * What a product tile looks up about its product: stock at the till's event,
 * how many are in the cart, the bundle chips and the price as charged. The
 * till screen owns these (they hang on its event) and provides them once, so
 * a tile in the grid or in a sheet reads the same figures without each grid
 * passing them down.
 */
export interface TillTiles {
  stockLabel: (pid: string, vid: string | null) => { text: string; cls: string };
  productInCart: (p: Product) => number;
  productLeft: (p: Product) => number | null;
  bundleQtys: (p: Product, vid?: string | null) => number[];
  price: (pid: string, vid: string | null, base: number) => string;
  fromPrice: (p: Product) => string;
}

const KEY: InjectionKey<TillTiles> = Symbol('pos.till-tiles');

export function provideTillTiles(tiles: TillTiles): void {
  provide(KEY, tiles);
}

export function useTillTiles(): TillTiles {
  const tiles = inject(KEY);
  if (!tiles) throw new Error('A product tile was used outside the till screen.');
  return tiles;
}
