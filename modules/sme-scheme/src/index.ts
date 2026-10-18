import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * SME scheme - the EU small-business VAT exemption, cross-border.
 *
 * The quarterly report lists what the booth sold in each country: exempt
 * sales in full, VAT-charged sales without their VAT. See engine/report.ts.
 *
 * The exemption itself (countries, EX number, receipt wording) is set here,
 * under Settings → SME exemption and as a first-run setup step, but saved in
 * the account profile: the till decides every sale's VAT from it whether or
 * not this module is on. Core's VAT settings show a summary of it.
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
    sdk.nav.add({ routeName: 'index', group: 'books', label: 'SME report', icon: 'book', order: 225 });
    sdk.settings.panel({ id: 'exemption', label: 'SME exemption', component: () => import('./views/SmeExemption.vue'), minRole: 'admin', order: 95 });
    // Switched on in setup because the business said it is on a scheme: ask where, right away.
    sdk.setup.step({ id: 'exemption', title: 'SME exemption', component: () => import('./views/SmeSetupStep.vue'), minRole: 'admin', order: 90 });
    sdk.log.info('sme-scheme module ready');
  },

  teardown() {
    clearSdk();
  },
});
