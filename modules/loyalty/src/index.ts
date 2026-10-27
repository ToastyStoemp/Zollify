import { defineModule, type Sdk } from '@zollify/sdk';
import { LOYALTY_MEMBER_LINE_KEY, LOYALTY_MEMBER_REF_KIND, loyaltyUnit, memberCodeIn } from '@zollify/shared';
import { api } from './api';
import { clearSdk, setSdk } from './runtime';

/**
 * Loyalty - a stamp card or points on the customer's phone.
 *
 * The customer joins from a QR on the table and gets a card: a code on a
 * web page, and a Google Wallet pass when the account has an issuer. At the
 * till the card is scanned (or typed) and the sale carries a zero-price line
 * naming the member; the server counts stamps from the synced sales and
 * keeps the pass up to date. A reward comes off the sale as a negative line.
 * The records live on the server half; this is the till's and the owner's
 * side of them.
 */
export default defineModule({
  id: 'loyalty',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Loyalty',
  description: 'A stamp card or points on the customer\'s phone (Google Wallet), earned at the till and spent as a reward.',
  requires: ['events'],
  // Staff read cards at the till; the programme and the members are the admins'.
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Loyalty', minRole: 'admin', component: () => import('./views/MembersView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'selling', label: 'Loyalty', icon: 'gift', order: 130, minRole: 'admin' });
    sdk.settings.panel({ id: 'setup', label: 'Loyalty card', component: () => import('./views/LoyaltySettings.vue'), minRole: 'admin', order: 230 });
    sdk.till.action({ id: 'card', label: 'Loyalty card', icon: 'gift', tile: true, order: 60, component: () => import('./views/TillLoyalty.vue') });
    // A card's QR scanned into the till's search: attach the member to the sale right there.
    sdk.till.onLookup(async (code) => {
      const member = memberCodeIn(code);
      if (!member) return null;
      const found = await api.lookup(member);
      const added = sdk.till.addLine({ key: LOYALTY_MEMBER_LINE_KEY, name: `${found.settings.programme || 'Loyalty card'} · ${found.member.name || found.member.code.slice(-4)}`, qty: 1, unitPrice: 0, ref: { kind: LOYALTY_MEMBER_REF_KIND, id: found.member.id } });
      const st = found.member.standing;
      const note = st.rewards > 0 ? ` - ${st.rewards} reward${st.rewards === 1 ? '' : 's'} to use (Loyalty card)` : ` - ${st.balance} ${loyaltyUnit(found.settings, st.balance)}`;
      return { handled: true, message: added ? `${found.member.name || 'Card'} on this sale${note}` : 'Open the till with an active event first.' };
    });
    sdk.log.info('loyalty module ready');
  },

  teardown() {
    clearSdk();
  },
});
