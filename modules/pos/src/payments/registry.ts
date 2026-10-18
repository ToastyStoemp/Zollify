import type { PaymentProvider, PaymentProviderId } from './provider';
import { hasNativePlugin } from '../native/plugins';
import { sdk } from '../runtime';
import { manualProvider } from './manual';
import { connectGo2, myposGo2Provider } from './mypos-go2';
import { myposCarbonProvider } from './mypos-carbon';
import { myposGlassProvider } from './mypos-glass';
import { sumupProvider } from './sumup';
import { sumupCloudProvider } from './sumup-cloud';
import { myposCarbonRemoteProvider } from './mypos-carbon-remote';
import { nexiSmartposProvider } from './nexi-smartpos';

const providers: PaymentProvider[] = [
  manualProvider,
  myposGo2Provider,
  myposCarbonProvider,
  myposCarbonRemoteProvider,
  myposGlassProvider,
  sumupProvider,
  sumupCloudProvider,
  nexiSmartposProvider,
];

export function allProviders(): PaymentProvider[] {
  return providers;
}

export function getProvider(id: PaymentProviderId | undefined): PaymentProvider {
  return providers.find((p) => p.id === id) ?? manualProvider;
}

/**
 * The card terminal a device uses until someone picks one: on a myPOS
 * Carbon/Smart terminal its own card reader (on-device), elsewhere recording
 * cards by hand. A choice made under Settings → Card terminal always wins.
 */
export function defaultProviderId(): PaymentProviderId {
  return hasNativePlugin('CarbonPayment') ? 'mypos-carbon' : 'manual';
}

/** Makes `id` the card terminal this device uses - what picking it under Settings → Card terminal does. */
export async function setActiveProvider(id: PaymentProviderId): Promise<void> {
  await sdk().config.set('activeProvider', id);
  onActiveProviderChanged(id);
}

export async function availableProviders(): Promise<PaymentProvider[]> {
  const flags = await Promise.all(providers.map((p) => p.isAvailable()));
  return providers.filter((_, i) => flags[i]);
}

/**
 * Called on app start and whenever the provider selection changes. Connections
 * are only established for the provider that is actually in use:
 * - MyPOS GO2: enter Bluetooth-connectable state only while selected - the
 *   native plugin deliberately never auto-connects on its own, so a paired
 *   terminal isn't grabbed when a different provider (or none) is configured.
 */
export function onActiveProviderChanged(id: PaymentProviderId): void {
  if (id === 'mypos-go2' && hasNativePlugin('MyPos')) {
    void connectGo2().catch(() => {});
  }
}
