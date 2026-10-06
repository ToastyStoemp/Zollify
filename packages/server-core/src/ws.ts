import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type Database from 'better-sqlite3';
import type {
  DisplayCartMessage,
  DisplayListenersMessage,
  DisplaySubscribeMessage,
  NotificationMessage,
  NudgeMessage,
  PaymentResultMessage,
  PaymentTriggerMessage,
  ShellUpdateMessage,
} from '@zollify/shared';
import { checkClaims, type JwtClaims } from './auth';
import { touchDevice } from './db';

type PaymentMessage = PaymentTriggerMessage | PaymentResultMessage;

/**
 * WebSocket is a doorbell only: after a push, every *other* connected device
 * of the account gets a nudge and pulls over HTTP. Clients without WS poll -
 * same behavior, just slower.
 */
interface Member {
  socket: WebSocket;
  deviceId: string;
  /** Showing a customer display; undefined = an older client that never said, which gets carts as before. */
  display?: boolean;
}

export class Rooms {
  private byAccount = new Map<string, Set<Member>>();
  private authorized = new WeakMap<WebSocket, () => boolean>();

  add(accountId: string, deviceId: string, socket: WebSocket, authorized: () => boolean = () => true): Member {
    this.authorized.set(socket, authorized);
    let room = this.byAccount.get(accountId);
    if (!room) this.byAccount.set(accountId, (room = new Set()));
    const entry: Member = { socket, deviceId };
    room.add(entry);
    socket.on('close', () => {
      room!.delete(entry);
      if (entry.display) this.announceListeners(accountId);
    });
    // Tell the newcomer whether anyone is watching, so a register knows
    // whether to bother broadcasting its cart.
    this.send(socket, this.listenersMessage(accountId));
    return entry;
  }

  setDisplay(accountId: string, entry: Member, on: boolean): void {
    const was = entry.display === true;
    entry.display = on;
    if (was !== on) this.announceListeners(accountId);
  }

  private listenersMessage(accountId: string): DisplayListenersMessage {
    let count = 0;
    for (const m of this.byAccount.get(accountId) ?? []) if (m.display) count++;
    return { type: 'display.listeners', count };
  }

  private announceListeners(accountId: string): void {
    const json = JSON.stringify(this.listenersMessage(accountId));
    for (const { socket } of this.byAccount.get(accountId) ?? []) this.send(socket, json);
  }

  private send(socket: WebSocket, msg: unknown): void {
    if (this.authorized.get(socket)?.() === false) {
      socket.close(4001, 'invalid token');
      return;
    }
    if (socket.readyState === socket.OPEN) socket.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** Doorbell: the account has a new notification; devices fetch it over HTTP. */
  notify(accountId: string): void {
    const msg: NotificationMessage = { type: 'notification' };
    for (const { socket } of this.byAccount.get(accountId) ?? []) this.send(socket, msg);
  }

  nudge(accountId: string, latestSeq: number, exceptDeviceId?: string): void {
    const room = this.byAccount.get(accountId);
    if (!room) return;
    const msg: NudgeMessage = { type: 'nudge', latestSeq };
    const json = JSON.stringify(msg);
    for (const { socket, deviceId } of room) {
      if (deviceId === exceptDeviceId) continue;
      this.send(socket, json);
    }
  }

  /**
   * Rebroadcast a register's cart snapshot to the account's other devices so
   * they can act as customer displays. Ephemeral - nothing is stored.
   */
  relayDisplayCart(accountId: string, fromDeviceId: string, cart: DisplayCartMessage['cart']): void {
    const room = this.byAccount.get(accountId);
    if (!room) return;
    const msg: DisplayCartMessage = { type: 'display.cart', from: fromDeviceId, cart };
    const json = JSON.stringify(msg);
    for (const { socket, deviceId, display } of room) {
      // Only screens showing a customer display; tills and terminals have no
      // use for another register's cart every 15 seconds.
      if (deviceId === fromDeviceId || display === false) continue;
      this.send(socket, json);
    }
  }

  /**
   * Point-to-point relay for the remote payment trigger/result handshake -
   * only the named target device gets the message, unlike the broadcast
   * relayDisplayCart. Ephemeral - nothing is stored.
   */
  relayToDevice(accountId: string, fromDeviceId: string, msg: PaymentMessage): void {
    const room = this.byAccount.get(accountId);
    if (!room) return;
    const stamped: PaymentMessage = { ...msg, from: fromDeviceId };
    const json = JSON.stringify(stamped);
    for (const { socket, deviceId } of room) {
      if (deviceId === msg.to) this.send(socket, json);
    }
  }
}

/**
 * Keepalive. A reverse proxy closes a socket it sees no traffic on (nginx's
 * default is 60s), and every reconnect costs a TLS handshake, an upgrade and
 * a round of catch-up requests - far more than a ping frame of a few bytes.
 * A socket that misses a pong is dead and is dropped, so the device notices
 * and reconnects instead of waiting on a silent connection.
 */
const PING_MS = 25_000;

export async function registerWs(app: FastifyInstance, rooms: Rooms, db: Database.Database): Promise<void> {
  await app.register(websocket);

  const alive = new WeakMap<WebSocket, boolean>();
  const live = new Set<WebSocket>();
  const pinger = setInterval(() => {
    for (const socket of live) {
      if (alive.get(socket) === false) {
        socket.terminate();
        live.delete(socket);
        continue;
      }
      alive.set(socket, false);
      try {
        socket.ping();
      } catch {
        /* closing anyway */
      }
    }
  }, PING_MS);
  pinger.unref?.();
  app.addHook('onClose', async () => clearInterval(pinger));

  app.get('/api/sync/ws', { websocket: true }, (socket, req) => {
    const { token, deviceId, flavor } = req.query as { token?: string; deviceId?: string; flavor?: string };
    let claims: JwtClaims;
    try {
      claims = app.jwt.verify<JwtClaims>(token ?? '');
      if (checkClaims(db, claims, 'GET', '/api/sync/ws')) throw new Error('revoked');
    } catch {
      socket.close(4001, 'invalid token');
      return;
    }
    const authorized = () => {
      try {
        app.jwt.verify(token ?? ''); // Recheck expiration for each send and receive.
        return checkClaims(db, claims, 'GET', '/api/sync/ws') === null;
      } catch {
        return false;
      }
    };
    const member = rooms.add(claims.accountId, deviceId ?? 'unknown', socket, authorized);
    live.add(socket);
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('close', () => live.delete(socket));
    // The shell store only ever changes by redeploying the whole server, so a
    // fresh connection - the first one after boot, or any reconnect a deploy
    // itself just caused - is exactly the moment to check, rather than
    // waiting for this device's own next full cold start.
    const shellMsg: ShellUpdateMessage = { type: 'shell.update' };
    socket.send(JSON.stringify(shellMsg));
    if (deviceId) {
      // Best-effort presence touch - a device that mostly just listens (e.g.
      // a Carbon in customer-display mode) may rarely push its own ops, so a
      // WS connection is often the only signal that it's still around.
      try {
        touchDevice(db, deviceId, claims.accountId, claims.sub, null, flavor || null, Date.now());
      } catch {
        /* devices row requires an existing account/user FK - skip on any edge case */
      }
    }
    socket.on('message', (raw) => {
      if (!authorized()) {
        socket.close(4001, 'invalid token');
        return;
      }
      // Registers push ephemeral customer-display cart snapshots and the
      // remote-payment trigger/result handshake; everything else is ignored
      // (sync data always travels over HTTP).
      try {
        const msg = JSON.parse(String(raw)) as DisplayCartMessage | PaymentMessage | DisplaySubscribeMessage;
        if (msg?.type === 'display.subscribe') {
          rooms.setDisplay(claims.accountId, member, msg.on === true);
        } else if (msg?.type === 'display.cart' && msg.cart && typeof msg.cart === 'object') {
          rooms.relayDisplayCart(claims.accountId, deviceId ?? 'unknown', msg.cart);
        } else if (
          (msg?.type === 'payment.trigger' || msg?.type === 'payment.result') &&
          typeof msg.to === 'string' &&
          typeof msg.requestId === 'string'
        ) {
          rooms.relayToDevice(claims.accountId, deviceId ?? 'unknown', msg);
        }
      } catch {
        /* not JSON - ignore */
      }
    });
  });
}
