import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';

/**
 * Notify me - a customer scans a code at the booth and asks to hear from
 * the business: when an item is back in stock, when it is next at an event
 * near them, when the webstore has news.
 *
 * The page, the confirmations, the mails and the subscribers live on the
 * server half; this side is the admin's: the codes to print, who signed up,
 * a note to send, and the settings.
 */
export default defineModule({
  id: 'notify-me',
  version: '0.1.0',
  sdk: '^0.1.0',
  title: 'Notify me',
  description: 'A QR code customers scan to hear when an item is back, when you are next in their city, or what is new in the webstore.',
  requires: ['catalog'],
  // Addresses of people who asked to hear from the business: the admin's to keep.
  minRole: 'admin',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Notify me', component: () => import('./views/NotifyView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'selling', label: 'Notify me', icon: 'bell', order: 140 });
    sdk.settings.panel({ id: 'notify-me', label: 'Notify me', component: () => import('./views/NotifySettings.vue'), minRole: 'admin', order: 128 });
    sdk.log.info('notify-me module ready');
  },

  teardown() {
    clearSdk();
  },
});
