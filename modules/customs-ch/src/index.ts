import { defineModule, type Sdk } from '@zollify/sdk';
import { CUSTOMS_BUNDLE_REQUEST, type CustomsBundleRequest } from '@zollify/customs-core';
import { swissBundleProvider } from './bundle';
import { clearSdk, setSdk } from './runtime';

/**
 * Customs - Swiss customs paperwork for a booth crossing a border.
 *
 * The engine under `src/engine` is ported verbatim from ZollTool and is covered
 * by golden-file tests that diff its output against the original implementation.
 * Nothing in this file should reimplement any of it; this is registration only.
 */
export default defineModule({
  id: 'customs-ch',
  version: '0.1.17',
  sdk: '^0.1.0',
  title: 'Customs (Switzerland)',
  description: 'EDEC XML, Forms 1174 and 1187, proforma invoices and goods lists.',
  requires: ['catalog', 'customs-hub'],
  // Helpers work an event; customs paperwork is the account holder's business.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.addAll([
      {
        path: '',
        name: 'index',
        title: 'Customs',
        component: () => import('./views/CustomsView.vue'),
      },
      {
        path: 'documents/:eventId',
        name: 'documents',
        title: 'Customs documents',
        component: () => import('./views/DocumentsView.vue'),
      },
    ]);

    sdk.settings.panel({
      id: 'declarant',
      label: 'Customs declarant (Switzerland)',
      component: () => import('./views/DeclarantSettings.vue'),
      order: 120,
    });

    // The customs hub's "export all documents" buttons ask each country module for its documents.
    sdk.events.on(CUSTOMS_BUNDLE_REQUEST, (req) => (req as CustomsBundleRequest).providers.push(swissBundleProvider));

    sdk.log.info('customs module ready');
  },

  teardown() {
    clearSdk();
  },
});
