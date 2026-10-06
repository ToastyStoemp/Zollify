import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';
import { answerOffer, errorText, loadOffers, myLinks } from './api';

async function askAboutInvites(sdk: Sdk): Promise<void> {
  let offers;
  try {
    offers = await loadOffers();
  } catch {
    return; // offline: My stores still lists them
  }
  for (const o of offers) {
    const pct = `${Number(o.commissionPct.toFixed(2))}%`;
    const accept = await sdk.ui.confirm(
      `${o.storeAccountName} would like to sell your work in their store, as “${o.consignorName}”, keeping ${pct} commission. Accepting lets you share items with them and follow your sales and payouts there. Your own events and sales stay private.`,
      `Invite from ${o.storeAccountName}`,
      { confirm: 'Accept', cancel: 'Decline' },
    );
    // Escape or a stray click must not throw an invite away: a decline is confirmed.
    if (!accept && !(await sdk.ui.confirm(`${o.storeAccountName} is told you declined. They can invite you again later.`, 'Decline the invite?', { confirm: 'Decline', cancel: 'Keep it for now' }))) continue;
    try {
      await answerOffer(o, accept);
      sdk.ui.toast(accept ? `You now consign with ${o.storeAccountName} - see Stores → My stores.` : `Declined - ${o.storeAccountName} has been told.`, { kind: 'success' });
    } catch (err) {
      sdk.ui.toast(errorText(err, 'Could not send your answer - try again under Stores → My stores.'), { kind: 'error' });
    }
  }
}

/**
 * My stores - the artist's half of consignment. Stores that sell this
 * account's work invite it; once accepted, the artist shares items, restocks
 * or sends packages, answers setup times and follows their sales and payouts
 * there. The store owner's half is the separate "consignment" module.
 */
export default defineModule({
  id: 'consignment-artist',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'My stores',
  description: 'Consign your work in other people’s stores: accept their invites, share items, restock and follow your sales and payouts there.',
  requires: ['catalog'],
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'My stores', minRole: 'admin', component: () => import('./views/MyStoresView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'stores', label: 'My stores', icon: 'store', order: 300, minRole: 'admin' });
    // Setups at the stores on the home calendar; one still to confirm stands out.
    sdk.calendar.source(async ({ from, to }) =>
      (await myLinks()).flatMap((l) =>
        l.setups
          .filter((s) => s.date >= from && s.date <= to)
          .map((s) => ({
            id: `setup:${l.storeAccountId}:${s.id}`,
            date: s.date,
            time: s.time,
            title: `Setup · ${l.storeAccountName}`,
            tone: s.status === 'scheduled' ? ('attention' as const) : s.status === 'cancelled' || s.status === 'declined' ? ('muted' as const) : ('normal' as const),
            link: '/m/consignment-artist',
          })),
      ),
    );
    // A store's invite waiting for an answer: asked right away, whatever screen
    // this account opened on - for someone who signed up with the invite, it
    // is the reason they are here.
    void askAboutInvites(sdk);
    sdk.log.info('consignment-artist module ready');
  },

  teardown() {
    clearSdk();
  },
});
