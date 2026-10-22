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

// ── Staying connected over Wi-Fi ───────────────────────────────────────────
//
// When the phone sleeps, the terminal's TCP link drops and the myPOS SDK never
// says so: it keeps reporting the terminal ready while nothing gets through.
// So the link is checked before each payment and reopened when the app comes
// back, rather than waiting for the seller to tap Connect.

/** How long a payment waits for the terminal to come back before giving up. */
export const GO2_READY_TIMEOUT_MS = 10_000;
/** Reopen the link again if the terminal has not answered by then - the phone's Wi-Fi may still be waking. */
export const GO2_RETRY_EVERY_MS = 4_000;
const POLL_MS = 300;
/** Back from at least this long in the background: open a fresh link even if the old one looks alive. */
export const GO2_WAKE_FORCE_AFTER_MS = 15_000;

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let attempt: Promise<boolean> | null = null;
let paying = false;

async function terminalStatus(): Promise<{ connected: boolean; alive: boolean }> {
  const s = (await MyPos.getStatus()) as { connected?: boolean; alive?: boolean };
  // `alive` is the link probe; an app build without it only knows `connected`.
  return { connected: s.connected === true, alive: s.alive !== false };
}

/**
 * True once the Go2 can take a payment. Over Wi-Fi a link that is gone is
 * reopened, retrying until `timeoutMs`; with `force` it is reopened even when
 * it looks fine (after a long sleep a half-open link can). Bluetooth is only
 * read, never reconnected here: reconnecting it opens the SDK's terminal
 * picker. Calls that overlap share one attempt.
 */
export function ensureGo2Ready(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
  if (attempt) return attempt;
  attempt = (async () => {
    try {
      const c = await go2Connection();
      if (c.transport !== 'wifi' || !c.host) return (await terminalStatus()).connected;
      if (!opts.force) {
        const s = await terminalStatus();
        if (s.connected && s.alive) return true;
      }
      const deadline = Date.now() + (opts.timeoutMs ?? GO2_READY_TIMEOUT_MS);
      let reconnectAt = 0;
      while (Date.now() < deadline) {
        if (Date.now() >= reconnectAt) {
          reconnectAt = Date.now() + GO2_RETRY_EVERY_MS;
          await connectGo2().catch(() => undefined);
        }
        await pause(POLL_MS);
        if ((await terminalStatus()).connected) return true;
      }
      return false;
    } catch {
      return false;
    }
  })().finally(() => {
    attempt = null;
  });
  return attempt;
}

let watching = false;

/**
 * Reopens the Wi-Fi link as soon as the app is back in front, so it is up by
 * the time the seller rings the next sale. `isActive` says whether the Go2 is
 * still the terminal in use. Installed once; never during a payment.
 */
export function watchGo2Wake(isActive: () => Promise<boolean>): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  let hiddenAt: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const slept = hiddenAt !== null && Date.now() - hiddenAt >= GO2_WAKE_FORCE_AFTER_MS;
    hiddenAt = null;
    void (async () => {
      if (paying || !(await isActive().catch(() => false))) return;
      await ensureGo2Ready({ force: slept });
    })();
  });
}

/** Test seam: forget the listener and any attempt in progress. */
export function resetGo2Watch(): void {
  watching = false;
  attempt = null;
  paying = false;
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
    // Over Wi-Fi the link may have dropped while the phone slept: bring it back first.
    const c = await go2Connection();
    if (c.transport === 'wifi' && !(await ensureGo2Ready())) {
      return {
        approved: false,
        provider: 'mypos-go2',
        error: c.host
          ? `Can't reach the terminal at ${c.host} - check it is switched on and on the same Wi-Fi as this phone, then try again.`
          : 'Enter the terminal’s IP address under Settings → Card terminal.',
      };
    }
    paying = true;
    try {
      const result = await MyPos.startPayment({ amount: req.amount, currency: req.currency });
      return {
        approved: !!result.approved,
        provider: 'mypos-go2',
        txRef: result.transactionId,
        cardBrand: result.cardBrand,
        authCode: result.authCode,
        error: result.error,
      };
    } finally {
      paying = false;
    }
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
