import type { PaymentProvider, PaymentProviderId } from './provider';
import { MyPos, hasNativePlugin } from '../native/plugins';
import { manualProvider } from './manual';
import { myposGo2Provider } from './mypos-go2';
import { myposCarbonProvider } from './mypos-carbon';
import { myposGlassProvider } from './mypos-glass';
import { bridgeProvider, bridgeConnection } from './bridge-ws';
import { sumupProvider } from './sumup';

const providers: PaymentProvider[] = [
  manualProvider,
  myposGo2Provider,
  myposCarbonProvider,
  myposGlassProvider,
  bridgeProvider,
  sumupProvider,
];

export function allProviders(): PaymentProvider[] {
  return providers;
}

export function getProvider(id: PaymentProviderId | undefined): PaymentProvider {
  return providers.find((p) => p.id === id) ?? manualProvider;
}

export async function availableProviders(): Promise<PaymentProvider[]> {
  const flags = await Promise.all(providers.map((p) => p.isAvailable()));
  return providers.filter((_, i) => flags[i]);
}

/**
 * Called on app start and whenever the provider selection changes. Connections
 * are only established for the provider that is actually in use:
 * - bridge: keep its websocket alive only while selected
 * - MyPOS GO2: enter Bluetooth-connectable state only while selected — the
 *   native plugin deliberately never auto-connects on its own, so a paired
 *   terminal isn't grabbed when a different provider (or none) is configured.
 */
export function onActiveProviderChanged(id: PaymentProviderId): void {
  if (id === 'bridge') bridgeConnection.connect();
  else bridgeConnection.disconnect();

  if (id === 'mypos-go2' && hasNativePlugin('MyPos')) {
    void MyPos.connectTerminal().catch(() => {});
  }
}
