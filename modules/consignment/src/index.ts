import { defineComponent, h } from 'vue';
import { defineModule, type Sdk } from '@zollify/sdk';
import { isStore } from '@zollify/shared';
import { clearSdk, setSdk } from './runtime';
import { loadPlanner, loadProgramme } from './api';
import type { Page } from './views/ConsignmentView.vue';

/**
 * Consignment - selling artists' work in your stores.
 *
 * The store owner keeps artists, tags their items, plans space and setups,
 * runs store events and settles what each artist is owed per store. Artists
 * invited here get the separate "My stores" module (consignment-artist) on
 * their own account. Artists, invites and payouts live server-side; the
 * items are ordinary catalogue products, so the till sells them like
 * anything else.
 */
export default defineModule({
  id: 'consignment',
  version: '0.9.0',
  sdk: '^0.1.0',
  title: 'Consignment',
  description: 'Sell work by consignment artists across your stores and settle what each is owed.',
  requires: ['catalog'],
  // Staff load it for the till (workshop places, artists' labels); the
  // screens are admin-only, and so is everything else on the server.
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    // One page per part, all in the sidebar's Stores section.
    const page = (p: Page) => () => import('./views/ConsignmentView.vue').then((m) => defineComponent({ name: `Consignment-${p}`, render: () => h(m.default, { page: p }) }));
    const PAGES: { page: Page; path: string; name: string; label: string; icon: string }[] = [
      { page: 'artists', path: '', name: 'index', label: 'Artists', icon: 'users' },
      { page: 'items', path: 'items', name: 'items', label: 'Consigned items', icon: 'package' },
      { page: 'planner', path: 'planner', name: 'planner', label: 'Planner', icon: 'calendar' },
      { page: 'programme', path: 'events', name: 'events', label: 'Store events', icon: 'sparkles' },
      { page: 'statement', path: 'statement', name: 'statement', label: 'Statement', icon: 'file-text' },
      { page: 'reports', path: 'reports', name: 'reports', label: 'Reports', icon: 'book' },
    ];
    PAGES.forEach((p, i) => {
      sdk.routes.add({ path: p.path, name: p.name, title: p.label, minRole: 'admin', component: page(p.page) });
      sdk.nav.add({ routeName: p.name, group: 'stores', label: p.label, icon: p.icon, order: 200 + i * 10, minRole: 'admin' });
    });
    // An artist's label scanned at a store: share the item there if the artist has not yet.
    sdk.till.onLookup(async (code) => {
      const store = sdk.data.events.active();
      if (!store || !isStore(store)) return null;
      let found: { productId: string; variantId: string | null; consignorName: string; autoShared: boolean; priced: boolean };
      try {
        found = await sdk.http.post('scan', { code });
      } catch {
        return null;
      }
      if (!found.priced) {
        sdk.ui.toast(`That is ${found.consignorName}'s item, now shared here - give it a price in your currency first (Consignment → Items → Prices).`, { kind: 'warning', timeoutMs: 8000 });
        return null;
      }
      return {
        productId: found.productId,
        variantId: found.variantId,
        message: found.autoShared ? `Shared from ${found.consignorName}'s catalogue and added - they have been told.` : `Added ${found.consignorName}'s item`,
      };
    });
    // Artists' setup times on the home calendar, beside the sales events.
    sdk.calendar.source(async ({ from, to }) => {
      if (sdk.account()?.role === 'member') return [];
      const [{ setups }, names, { workshops }] = await Promise.all([
        loadPlanner(),
        sdk.http.get<{ consignors: { id: string; name: string }[] }>('consignors').then((r) => new Map(r.consignors.map((c) => [c.id, c.name]))),
        loadProgramme().catch(() => ({ workshops: [] as Awaited<ReturnType<typeof loadProgramme>>['workshops'] })),
      ]);
      const inRange = (d: string): boolean => d >= from && d <= to;
      const sessions = workshops
        .filter((w) => inRange(w.date))
        .map((w) => ({
          id: `workshop:${w.id}`,
          date: w.date,
          time: w.time,
          title: `${w.title} · ${w.booked}/${w.capacity}`,
          icon: 'users',
          tone: w.cancelledAt ? ('muted' as const) : ('normal' as const),
          link: '/m/consignment/events',
        }));
      return [...sessions, ...setups
        .filter((s) => inRange(s.date))
        .map((s) => ({
          id: `setup:${s.id}`,
          date: s.date,
          time: s.time,
          title: `Setup · ${names.get(s.consignorId) ?? 'artist'}`,
          icon: 'layers',
          // The artist can't make it: the store has to find another time.
          tone: s.status === 'declined' ? ('attention' as const) : s.status === 'cancelled' ? ('muted' as const) : ('normal' as const),
          link: '/m/consignment/planner',
        }))];
    });
    // Taking payment for a workshop place, right at the till.
    sdk.till.action({ id: 'workshops', label: 'Workshop', icon: 'calendar', component: () => import('./views/TillWorkshops.vue') });
    sdk.log.info('consignment module ready');
  },

  teardown() {
    clearSdk();
  },
});
