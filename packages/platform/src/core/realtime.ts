import { reactive, ref } from 'vue';
import type {
  DisplayCart,
  DisplayCartMessage,
  DisplayListenersMessage,
  DisplaySubscribeMessage,
  NudgeMessage,
  PaymentResultMessage,
  PaymentTriggerMessage,
  ShellUpdateMessage,
  TseRequestMessage,
  TseResultMessage,
} from '@zollify/shared';
import { getAccessToken, getAccount, getApiBase, refreshAccessToken } from '../session';
import { announceShellUpdate } from '../shell-updates';
import { deviceFlavor, deviceId } from './device';
import { setLiveChannelProbe, syncNow } from './sync';
import { setTseTransport } from './tse';

/**
 * The account's live channel. Sync data never travels here - the socket is a
 * doorbell (another device pushed, pull now) and a relay for ephemeral
 * customer-display cart snapshots. Without it the app still works, just on
 * the polling interval.
 */

export type PaymentMessage = PaymentTriggerMessage | PaymentResultMessage;
type TseMessage = TseRequestMessage | TseResultMessage;
type Incoming = NudgeMessage | ShellUpdateMessage | DisplayCartMessage | PaymentMessage | TseMessage | DisplayListenersMessage;

// Signing through a main TSE device travels this channel: tse.ts sends and
// listens through what is handed over here, so it needs no import of this
// module (which would make a cycle through sync).
const tseListeners = new Set<(msg: TseMessage) => void>();
setTseTransport({
  send: (msg) => sendDirect(msg),
  on: (handler) => {
    tseListeners.add(handler);
    return () => tseListeners.delete(handler);
  },
});

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

/**
 * Customer displays listening on the account. Null until a server says - an
 * older server never does, and then carts are sent as before.
 */
let displayListeners: number | null = null;
/** This register's latest cart, re-sent the moment a display appears. */
let lastCart: DisplayCart | null = null;
/** Whether this device is showing a customer display (told to the server on every connect). */
let showingDisplay = false;
/** Set once the server has accepted this connection - a bad token is closed before anything is sent. */
let accepted = false;

// The poller backs off while nudges can reach us.
setLiveChannelProbe(() => realtimeConnected.value);

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
  // Stopped (signed out) or connected by another call while we waited.
  if (!wanted || socket) return;
  const ws = new WebSocket(wsUrl(token, id));
  socket = ws;
  accepted = false;
  ws.onopen = () => {
    realtimeConnected.value = true;
    const hello: DisplaySubscribeMessage = { type: 'display.subscribe', on: showingDisplay };
    ws.send(JSON.stringify(hello));
  };
  ws.onmessage = (ev) => {
    let msg: Incoming;
    try {
      msg = JSON.parse(String(ev.data)) as Incoming;
    } catch {
      return;
    }
    if (!accepted) {
      // The server only talks to a connection whose token it accepted, so
      // the first message is the proof. Resetting the backoff on open
      // instead let a stale token reconnect every second.
      accepted = true;
      attempts = 0;
      // Nudges sent while we were away are lost; catch up once now.
      void syncNow();
    }
    if (msg?.type === 'display.listeners' && typeof msg.count === 'number') {
      const before = displayListeners ?? 0;
      displayListeners = msg.count;
      if (msg.count > 0 && before === 0 && lastCart) sendCart(lastCart);
    } else if (msg?.type === 'nudge') void syncNow();
    else if (msg?.type === 'shell.update') void announceShellUpdate();
    else if (msg?.type === 'display.cart' && msg.from && msg.cart && typeof msg.cart === 'object') {
      displayCarts[msg.from] = { ...msg.cart, deviceId: msg.from, receivedAt: Date.now() };
    } else if ((msg?.type === 'payment.trigger' || msg?.type === 'payment.result') && typeof msg.requestId === 'string') {
      for (const h of paymentListeners) h(msg);
    } else if ((msg?.type === 'tse.request' || msg?.type === 'tse.result') && typeof msg.requestId === 'string') {
      for (const h of tseListeners) h(msg);
    }
  };
  ws.onclose = (ev) => {
    if (socket === ws) socket = null;
    realtimeConnected.value = false;
    displayListeners = null;
    // 4001: the server refused the access token, which only lives 15
    // minutes. Get a fresh one first - retrying with the same one just gets
    // refused again, a full TLS handshake each time.
    if (ev.code === 4001) void refreshAccessToken().finally(scheduleReconnect);
    else scheduleReconnect();
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
  attempts = 0;
  if (reconnect) clearTimeout(reconnect);
  reconnect = null;
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  socket?.close();
  socket = null;
  realtimeConnected.value = false;
  for (const key of Object.keys(displayCarts)) delete displayCarts[key];
  displayListeners = null;
  lastCart = null;
}

/** Tells the server this device is (or stops) showing a customer display, so carts are sent to it. */
export function setDisplaySubscribed(on: boolean): void {
  showingDisplay = on;
  if (!socket || socket.readyState !== socket.OPEN) return; // sent on (re)connect
  const msg: DisplaySubscribeMessage = { type: 'display.subscribe', on };
  socket.send(JSON.stringify(msg));
}

/** Sends a payment trigger or result to one named device. Best effort; nothing is stored. */
export function sendPaymentMessage(msg: PaymentMessage): boolean {
  return sendDirect(msg);
}

function sendDirect(msg: PaymentMessage | TseMessage): boolean {
  if (!socket || socket.readyState !== socket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/**
 * Broadcasts this register's cart to the account's customer displays. Best
 * effort; nothing is stored. With no display listening it sends nothing - a
 * till re-sent its cart every 15 seconds all day for nobody - and keeps the
 * latest so a display that appears gets it straight away.
 */
export function sendDisplayCart(cart: DisplayCart): void {
  lastCart = cart;
  if (displayListeners === 0) return;
  sendCart(cart);
}

function sendCart(cart: DisplayCart): void {
  if (!socket || socket.readyState !== socket.OPEN) return;
  const msg: DisplayCartMessage = { type: 'display.cart', cart };
  socket.send(JSON.stringify(msg));
}
