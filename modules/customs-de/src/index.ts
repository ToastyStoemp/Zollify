import { defineModule, type Sdk } from '@zollify/sdk';
import { CUSTOMS_BUNDLE_REQUEST, type CustomsBundleRequest } from '@zollify/customs-core';
import { germanBundleProvider } from './bundle';
import { clearSdk, setSdk } from './runtime';

/**
 * Customs (Germany) - export/re-import paperwork for a booth crossing the
 * German border, independent of the Swiss customs-ch module so a booth
 * coming from a different country (e.g. France) never needs this one.
 *
 * Scope is deliberately limited: this generates preparation documents
 * (packing lists, a checklist) for a declarant or customs broker to file
 * ATLAS with. It does not generate or submit an ATLAS export/re-import
 * message itself - nobody on this team has verified ATLAS test access, and a
 * confidently wrong customs declaration is worse than no automation at all.
 * Revisit once that access exists.
 */
export default defineModule({
  id: 'customs-de',
  version: '0.1.15',
  sdk: '^0.1.0',
  title: 'Customs (Germany)',
  description: 'ATLAS export/re-import preparation: packing lists and a filing checklist.',
  requires: ['catalog', 'customs-hub'],
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.addAll([
      {
        path: '',
        name: 'index',
        title: 'Customs (Germany)',
        component: () => import('./views/CustomsDeView.vue'),
      },
      {
        path: 'documents/:eventId',
        name: 'documents',
        title: 'Customs (Germany) documents',
        component: () => import('./views/DocumentsView.vue'),
      },
    ]);

    sdk.settings.panel({
      id: 'declarant',
      label: 'Customs declarant (Germany)',
      component: () => import('./views/DeclarantSettings.vue'),
      order: 121,
    });

    // The customs hub's "export all documents" buttons ask each country module for its documents.
    sdk.events.on(CUSTOMS_BUNDLE_REQUEST, (req) => (req as CustomsBundleRequest).providers.push(germanBundleProvider));

    sdk.log.info('customs-de module ready');
  },

  teardown() {
    clearSdk();
  },
});
