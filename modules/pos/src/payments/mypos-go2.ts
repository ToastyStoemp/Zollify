import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';
import { MyPos, hasNativePlugin } from '../native/plugins';
import { getSetting } from '../lib/settings';

/**
 * MyPOS Go2 via the native MyPosPlugin.kt (com.mypos:slavesdk), over
 * Bluetooth or over Wi-Fi. Wi-Fi is the terminal in slave mode on the same
 * network as this device, reached by its IP address - it needs no Bluetooth
 * module (an optional extra on the Go2) and no pairing.
 */
export const GO2_TRANSPORT_SETTING = 'mypos.go2.transport';
export const GO2_HOST_SETTING = 'mypos.go2.host';
export const GO2_PORT_SETTING = 'mypos.go2.port';
export type Go2Transport = 'bluetooth' | 'wifi';

export async function go2Connection(): Promise<{ transport: Go2Transport; host: string; port: number }> {
  return {
    transport: ((await getSetting<string>(GO2_TRANSPORT_SETTING)) === 'wifi' ? 'wifi' : 'bluetooth') as Go2Transport,
    host: ((await getSetting<string>(GO2_HOST_SETTING)) ?? '').trim(),
    port: Number(await getSetting<number | string>(GO2_PORT_SETTING)) || 8080,
  };
}

/** Connects over whichever transport is set; Bluetooth asks for its permissions first. */
export async function connectGo2(): Promise<{ granted: boolean }> {
  const c = await go2Connection();
  if (c.transport === 'wifi') return MyPos.connectTerminal({ transport: 'wifi', host: c.host, port: c.port });
  return MyPos.connectTerminal({ transport: 'bluetooth' });
}

export const myposGo2Provider: PaymentProvider = {
  id: 'mypos-go2',
  label: 'MyPOS Go2 (Bluetooth or Wi-Fi)',

  async isAvailable(): Promise<boolean> {
    return hasNativePlugin('MyPos');
  },

  async getStatus(): Promise<ProviderStatus> {
    if (!hasNativePlugin('MyPos')) return { connected: false, detail: 'Android only' };
    try {
      const { connected } = await MyPos.getStatus();
      const c = await go2Connection();
      if (c.transport === 'wifi' && !c.host) return { connected: false, detail: 'Enter the terminal’s IP address below' };
      return { connected, detail: connected ? `Terminal ready (${c.transport === 'wifi' ? c.host : 'Bluetooth'})` : c.transport === 'wifi' ? `Not connected to ${c.host} - tap Connect` : 'Terminal not paired - tap Connect' };
    } catch (err) {
      return { connected: false, detail: String(err) };
    }
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const result = await MyPos.startPayment({ amount: req.amount, currency: req.currency });
    return {
      approved: !!result.approved,
      provider: 'mypos-go2',
      txRef: result.transactionId,
      cardBrand: result.cardBrand,
      authCode: result.authCode,
      error: result.error,
    };
  },

  async cancel(): Promise<void> {
    // Aborts the terminal transaction (SDK cancelTransaction) and resets the
    // native pending-payment latch so the next payment can start.
    await MyPos.cancelPayment();
  },

  async configure(): Promise<void> {
    const { granted } = await connectGo2();
    if (!granted) {
      throw new Error('Bluetooth permission denied - allow Bluetooth (and Location) for ZollTool in Android settings');
    }
  },
};
