import { defineModule, type Sdk } from '@zollify/sdk';
import { clearSdk, setSdk } from './runtime';
import { pendingJobs, queueJob } from './jobs';

/**
 * Label Printer - SKU-barcode + product-name labels, printed to a Phomemo
 * M110 over Bluetooth (the Android app's own BLE plugin, or Web Bluetooth on
 * Chrome/Edge as a site - not Safari/iOS). The protocol itself is
 * reverse-engineered and unverified against real hardware - see
 * engine/phomemo.ts. Other screens can hand it a label to print (the
 * 'label:print' event), such as a staff badge.
 */
export default defineModule({
  id: 'label-printer',
  version: '0.1.29',
  sdk: '^0.1.0',
  title: 'Label Printer',
  description: 'Print SKU barcode + product name labels to a Phomemo M110 over Bluetooth.',
  requires: ['catalog'],
  minRole: 'member',

  setup(sdk: Sdk) {
    setSdk(sdk);
    sdk.routes.add({ path: '', name: 'index', title: 'Print labels', component: () => import('./views/PrintLabelsView.vue') });
    sdk.nav.add({ routeName: 'index', group: 'stock', label: 'Print labels', icon: 'tag', order: 150 });
    // Labels asked for elsewhere - a staff badge from Settings.
    sdk.events.on('label:print', queueJob);
    sdk.log.info('label-printer module ready');
  },

  teardown() {
    pendingJobs.value = [];
    clearSdk();
  },
});
