import { defineModule, type Sdk } from '@zollify/sdk';
import { addDays, deadlinesBetween, localIsoDay } from '@zollify/shared';
import { doneSet, loadState, state } from './api';
import { clearSdk, setSdk } from './runtime';

/**
 * Tax deadlines - when to file and pay, and a reminder before each.
 *
 * The business describes its tax setup once (country, VAT status, how often
 * it files, extension, advisor…) and the deadlines follow from the rules in
 * `deadlinesBetween` (@zollify/shared): Germany in full, the EU SME scheme
 * report for any EU country, and custom deadlines for anything else. The
 * server rings the bell and emails at the lead times picked.
 */
export default defineModule({
  id: 'tax-deadlines',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Tax deadlines',
  description: 'Filing and payment deadlines worked out from your tax setup, with reminders a week, two weeks or a few days ahead.',
  // Taxes are the account holder's business, not a helper's.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Tax deadlines', component: () => import('./views/DeadlinesView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'Tax deadlines', icon: 'calendar', order: 220 });
    sdk.settings.panel({ id: 'setup', label: 'Tax deadlines', component: () => import('./views/DeadlinesSetup.vue'), minRole: 'admin', order: 220 });
    sdk.home.card({ id: 'upcoming', order: 40, component: () => import('./views/DeadlinesCard.vue') });

    // Open deadlines on the home calendar; one due within three days, or missed, stands out.
    sdk.calendar.source(async ({ from, to }) => {
      const s = await loadState();
      if (!s.settings.configured) return [];
      const done = doneSet(s);
      const soon = addDays(localIsoDay(), 3);
      return deadlinesBetween(s.settings, from, to).map((d) => ({
        id: `tax:${d.id}`,
        date: d.due,
        title: d.title,
        icon: 'file-text',
        tone: done.has(d.id) ? ('muted' as const) : d.due <= soon ? ('attention' as const) : ('normal' as const),
        link: '/m/tax-deadlines',
      }));
    });
    sdk.log.info('tax-deadlines module ready');
  },

  teardown() {
    state.value = null;
    clearSdk();
  },
});
