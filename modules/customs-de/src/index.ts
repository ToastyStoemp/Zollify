import { defineModule, type Sdk } from '@zollify/sdk';
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
  version: '0.1.2',
  sdk: '^0.1.0',
  title: 'Customs (Germany)',
  description: 'ATLAS export/re-import preparation: packing lists and a filing checklist.',
  requires: ['catalog'],
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

    sdk.nav.add({ routeName: 'index', group: 'events', label: 'Customs (Germany)', icon: 'file-text', order: 121 });

    sdk.settings.panel({
      id: 'declarant',
      label: 'Customs declarant (Germany)',
      component: () => import('./views/DeclarantSettings.vue'),
      order: 121,
    });

    sdk.log.info('customs-de module ready');
  },

  teardown() {
    clearSdk();
  },
});
