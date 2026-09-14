import { reactive, ref } from 'vue';
import type { DisplayCart, DisplayCartMessage, NudgeMessage, PaymentResultMessage, PaymentTriggerMessage } from '@zollify/shared';
import { getAccessToken, getAccount, getApiBase } from '../session';
import { deviceFlavor, deviceId } from './device';
import { syncNow } from './sync';

/**
 * The account's live channel. Sync data never travels here — the socket is a
 * doorbell (another device pushed, pull now) and a relay for ephemeral
 * customer-display cart snapshots. Without it the app still works, just on
 * the polling interval.
 */

export type PaymentMessage = PaymentTriggerMessage | PaymentResultMessage;
type Incoming = NudgeMessage | DisplayCartMessage | PaymentMessage;

const paymentListeners = new Set<(msg: PaymentMessage) => void>();
/** Point-to-point payment trigger/result messages addressed to this device. */
export function onPaymentMessage(handler: (msg: PaymentMessage) => void): () => void {
  paymentListeners.add(handler);
  return () => paymentListeners.delete(handler);
}

export interface DisplayCartSnapshot extends DisplayCart {
  deviceId: string;
  receivedAt: number;
}

/** Carts other registers are showing right now, keyed by their device id. */
export const displayCarts = reactive<Record<string, DisplayCartSnapshot>>({});
export const realtimeConnected = ref(false);

let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;
let wanted = false;
let attempts = 0;

function wsUrl(token: string, id: string): string {
  const base = getApiBase();
  const abs = base.startsWith('http') ? base : `${location.origin}${base.startsWith('/') ? '' : '/'}${base}`;
  const url = new URL(`${abs}/sync/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('deviceId', id);
  url.searchParams.set('flavor', deviceFlavor());
  return url.toString();
}

async function connect(): Promise<void> {
  if (!wanted || socket || typeof WebSocket === 'undefined') return;
  const token = getAccessToken();
  if (!token || !getAccount()) {
    scheduleReconnect();
    return;
  }
  const id = await deviceId();
  const ws = new WebSocket(wsUrl(token, id));
  socket = ws;
  ws.onopen = () => {
    attempts = 0;
    realtimeConnected.value = true;
  };
  ws.onmessage = (ev) => {
    let msg: Incoming;
    try {
      msg = JSON.parse(String(ev.data)) as Incoming;
    } catch {
      return;
    }
    if (msg?.type === 'nudge') void syncNow();
    else if (msg?.type === 'display.cart' && msg.from && msg.cart && typeof msg.cart === 'object') {
      displayCarts[msg.from] = { ...msg.cart, deviceId: msg.from, receivedAt: Date.now() };
    } else if ((msg?.type === 'payment.trigger' || msg?.type === 'payment.result') && typeof msg.requestId === 'string') {
      for (const h of paymentListeners) h(msg);
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    realtimeConnected.value = false;
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect(): void {
  if (!wanted || reconnect) return;
  // ponytail: capped exponential backoff; a jittered schedule if many devices ever share one server
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5));
  reconnect = setTimeout(() => {
    reconnect = null;
    void connect();
  }, delay);
}

export function startRealtime(): void {
  wanted = true;
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  void connect();
}

function onOnline(): void {
  if (!socket) void connect();
}

export function stopRealtime(): void {
  wanted = false;
  if (reconnect) clearTimeout(reconnect);
  reconnect = null;
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  socket?.close();
  socket = null;
  realtimeConnected.value = false;
  for (const key of Object.keys(displayCarts)) delete displayCarts[key];
}

/** Sends a payment trigger or result to one named device. Best effort; nothing is stored. */
export function sendPaymentMessage(msg: PaymentMessage): boolean {
  if (!socket || socket.readyState !== socket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/** Broadcasts this register's cart to the account's other devices. Best effort; nothing is stored. */
export function sendDisplayCart(cart: DisplayCart): void {
  if (!socket || socket.readyState !== socket.OPEN) return;
  const msg: DisplayCartMessage = { type: 'display.cart', cart };
  socket.send(JSON.stringify(msg));
}
