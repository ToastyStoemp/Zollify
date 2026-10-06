import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Belgian e-invoices (Peppol): B2B invoices and credit notes in Peppol BIS
 * Billing 3.0, as Belgian businesses must send them from 2026. Numbered by
 * the server in one gap-free sequence, frozen once issued, sent through the
 * business's Peppol access point or downloaded as UBL. A till sale can
 * become an invoice for a business customer.
 */
export default defineModule({
  id: 'peppol-be',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'E-invoices for Belgium (Peppol)',
  description: 'Issue Belgian B2B invoices and credit notes in Peppol BIS 3.0, send them through your access point or download the UBL.',
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'E-invoices', component: () => import('./views/InvoicesView.vue'), minRole: 'admin' });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'E-invoices (Peppol)', icon: 'file-text', order: 60, minRole: 'admin' });
    sdk.settings.panel({ id: 'peppol', label: 'E-invoices (Peppol)', component: () => import('./views/PeppolSettings.vue'), minRole: 'admin', order: 120 });
  },

  teardown() {
    clearSdk();
  },
});
