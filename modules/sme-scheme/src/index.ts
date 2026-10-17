import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * SME scheme - the EU small-business VAT exemption, cross-border.
 *
 * The quarterly report lists what the booth sold in each country: exempt
 * sales in full, VAT-charged sales without their VAT. See engine/report.ts.
 *
 * Which countries are exempt still lives in the account profile (core's VAT
 * settings), because the till decides every sale's VAT from it whether or
 * not this module is on.
 */
export default defineModule({
  id: 'sme-scheme',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'SME scheme',
  description: 'Quarterly sales per country for the EU small-business VAT scheme.',
  requires: ['events'],
  // Turnover per country is the account holder's business, not a helper's.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'SME report', component: () => import('./views/QuarterReportView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'SME report', icon: 'book', order: 220 });
    sdk.log.info('sme-scheme module ready');
  },

  teardown() {
    clearSdk();
  },
});
