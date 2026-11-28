import { computed, defineAsyncComponent, onUnmounted, shallowRef, watch, type Component, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { SalesEvent } from '@zollify/shared';
import type { TillAction } from '@zollify/sdk';
import { addModuleLine, findModuleLine, replaceModuleLine, total } from '../cart';
import { tillLinkFrom } from '../lib/till-link';
import { sdk } from '../runtime';
import { visibleTileActions } from '../search';
import type { ViewMode } from './useCatalogBrowse';
import type { Toast } from './useToast';

export interface TillActionsDeps {
  search: Ref<string>;
  viewMode: Readonly<Ref<ViewMode>>;
  openArtist: Readonly<Ref<string | null>>;
  activeEvent: Readonly<Ref<SalesEvent | null | undefined>>;
  currency: Readonly<Ref<string>>;
  toast: Toast;
}

/** What other modules add to the till (a workshop place, say): their buttons, tiles and screens, and their way into the cart. */
export function useTillActions({ search, viewMode, openArtist, activeEvent, currency, toast }: TillActionsDeps) {
  const tillActions = computed(() => sdk().till.actions());
  const tillButtons = computed(() => tillActions.value.filter((a) => !a.tile));
  const tillTiles = computed(() => visibleTileActions(tillActions.value, search.value, viewMode.value === 'artists' && openArtist.value !== null));
  const openAction = shallowRef<{ action: TillAction; view: Component; focus: string | null } | null>(null);
  function runAction(action: TillAction, focus: string | null = null): void {
    openAction.value = { action, view: defineAsyncComponent(action.component as () => Promise<Component>), focus };
  }
  // A link naming one of these actions (see lib/till-link) opens it once, then
  // drops the query so a reload or Back does not open it again.
  const route = useRoute();
  const router = useRouter();
  watch(
    [() => route.query, tillActions],
    ([query, actions]) => {
      const link = tillLinkFrom(query, actions);
      if (!link) return;
      runAction(link.action, link.focus);
      const { action: _a, focus: _f, ...rest } = query;
      void router.replace({ query: rest });
    },
    { immediate: true },
  );
  const offTill = sdk().till.onAddLine((line) => {
    if (!activeEvent.value) {
      toast('Pick an active event first (Events).', 'bad');
      return false;
    }
    return addModuleLine(line);
  });
  const offTillLines = sdk().till.onLineAccess({ find: findModuleLine, replace: replaceModuleLine });
  // What the sale comes to, for a module pricing a reward (loyalty) against it.
  const offTillTotal = sdk().till.onTotal?.(() => ({ total: total.value, currency: currency.value }));
  onUnmounted(() => {
    offTill();
    offTillLines();
    offTillTotal?.();
  });

  return { tillButtons, tillTiles, openAction, runAction };
}
