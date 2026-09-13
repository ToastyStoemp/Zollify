export type PaymentProviderId =
  | 'manual'
  | 'mypos-go2'
  | 'mypos-carbon'
  | 'mypos-carbon-remote'
  | 'mypos-glass'
  | 'bridge'
  | 'sumup';

export interface ProviderStatus {
  connected: boolean;
  detail?: string;
}

export interface PaymentRequest {
  /** Decimal major-unit amount (e.g. 12.50) — matches the native plugin contracts. */
  amount: number;
  currency: string;
  reference: string;
}

export interface PaymentResult {
  approved: boolean;
  provider: PaymentProviderId;
  txRef?: string;
  cardBrand?: string;
  authCode?: string;
  error?: string;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly label: string;
  /** Platform/plugin presence check — cheap, safe to call often. */
  isAvailable(): Promise<boolean>;
  getStatus(): Promise<ProviderStatus>;
  startPayment(req: PaymentRequest): Promise<PaymentResult>;
  cancel(): Promise<void>;
  /** Optional pairing / login flow (terminal pairing, SumUp login). */
  configure?(): Promise<void>;
  /** Optional: open the reader's own pairing/connection screen (e.g. SumUp's card reader page). */
  pairReader?(): Promise<void>;
  /** Optional: disconnect this device from the provider account (e.g. SumUp logout). */
  disconnect?(): Promise<void>;
  /**
   * Optional: true when the provider needs an interactive sign-in (e.g. SumUp
   * login) that hasn't happened yet, so checkout should prompt to connect or
   * pick another method instead of attempting — and failing at — the terminal.
   * Providers that connect on demand (myPOS Bluetooth) don't implement this.
   */
  needsLogin?(): Promise<boolean>;
}
