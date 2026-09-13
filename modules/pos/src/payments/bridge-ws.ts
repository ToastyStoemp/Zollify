import type { PaymentProvider, PaymentRequest, PaymentResult, ProviderStatus } from './provider';

/**
 * ZollBridge desktop app (bridge/Program.cs) over WebSocket — protocol v1,
 * frozen: identify → {status:'connected'|'primary_taken'}, pay → result
 * message with {approved, card_brand, auth_code}. The "v":1 field is ignored
 * by the current bridge and reserves room for future protocol changes.
 */
const BRIDGE_WS = 'wss://localhost:8765';
const RECONNECT_MS = 5000;
const PAYMENT_TIMEOUT_MS = 120000;

type BridgeState = 'disconnected' | 'connecting' | 'connected' | 'terminal-offline' | 'taken';

class BridgeConnection {
  private ws: WebSocket | null = null;
  private state: BridgeState = 'disconnected';
  private providerName = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: ((msg: any) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private wanted = false;

  connect(force = false): void {
    this.wanted = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.state = 'connecting';
    try {
      const ws = new WebSocket(BRIDGE_WS);
      this.ws = ws;
      ws.onopen = () => {
        const msg: Record<string, unknown> = { action: 'identify', role: 'primary', v: 1 };
        if (force) msg.force = true;
        ws.send(JSON.stringify(msg));
      };
      ws.onmessage = (e) => {
        let msg: any;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.status === 'primary_taken') {
          this.state = 'taken';
          return;
        }
        if (msg.status === 'connected') {
          this.state = 'connected';
          this.providerName = msg.provider || '';
          return;
        }
        if (msg.status === 'terminal_disconnected') {
          this.state = 'terminal-offline';
          return;
        }
        if (msg.status === 'terminal_reconnected') {
          this.state = 'connected';
          return;
        }
        // Anything else while a payment is pending is the payment result.
        if (this.pendingResolve) {
          this.pendingResolve(msg);
          this.pendingResolve = this.pendingReject = null;
        }
      };
      ws.onclose = () => {
        this.ws = null;
        if (this.state !== 'taken') this.state = 'disconnected';
        if (this.pendingReject) {
          this.pendingReject(new Error('Terminal disconnected'));
          this.pendingResolve = this.pendingReject = null;
        }
        if (this.wanted && this.state !== 'taken') {
          this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
        }
      };
      ws.onerror = () => ws.close();
    } catch {
      if (this.wanted) this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    }
  }

  disconnect(): void {
    this.wanted = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.state = 'disconnected';
  }

  getState(): { state: BridgeState; provider: string } {
    return { state: this.state, provider: this.providerName };
  }

  pay(req: PaymentRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'connected') {
        reject(new Error('Bridge not connected'));
        return;
      }
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.ws.send(
        JSON.stringify({
          action: 'pay',
          amount: req.amount.toFixed(2),
          currency: req.currency,
          reference: req.reference,
          v: 1,
        }),
      );
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = this.pendingReject = null;
          reject(new Error('Payment timed out — no response from terminal'));
        }
      }, PAYMENT_TIMEOUT_MS);
    });
  }

  cancelPayment(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: 'cancel', v: 1 }));
    }
    this.pendingResolve = this.pendingReject = null;
  }
}

export const bridgeConnection = new BridgeConnection();

export const bridgeProvider: PaymentProvider = {
  id: 'bridge',
  label: 'ZollBridge (desktop)',

  async isAvailable(): Promise<boolean> {
    // The bridge is reachable from any platform; whether it's running shows in status.
    return true;
  },

  async getStatus(): Promise<ProviderStatus> {
    const { state, provider } = bridgeConnection.getState();
    if (state === 'connected') return { connected: true, detail: provider || 'Terminal ready' };
    if (state === 'terminal-offline') return { connected: false, detail: 'Bridge up, terminal unplugged' };
    if (state === 'taken') return { connected: false, detail: 'Another tab owns the bridge' };
    return { connected: false, detail: 'Bridge not reachable' };
  },

  async startPayment(req: PaymentRequest): Promise<PaymentResult> {
    const msg = await bridgeConnection.pay(req);
    return {
      approved: !!msg.approved,
      provider: 'bridge',
      cardBrand: msg.card_brand || undefined,
      authCode: msg.auth_code || undefined,
      error: msg.error || undefined,
    };
  },

  async cancel(): Promise<void> {
    bridgeConnection.cancelPayment();
  },

  async configure(): Promise<void> {
    bridgeConnection.connect(true);
  },
};
