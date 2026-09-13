import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type Database from 'better-sqlite3';
import type { DisplayCartMessage, NudgeMessage, PaymentResultMessage, PaymentTriggerMessage } from '@boothly/shared';
import type { JwtClaims } from './auth';
import { touchDevice } from './db';

type PaymentMessage = PaymentTriggerMessage | PaymentResultMessage;

/**
 * WebSocket is a doorbell only: after a push, every *other* connected device
 * of the account gets a nudge and pulls over HTTP. Clients without WS poll —
 * same behavior, just slower.
 */
export class Rooms {
  private byAccount = new Map<string, Set<{ socket: WebSocket; deviceId: string }>>();

  add(accountId: string, deviceId: string, socket: WebSocket): void {
    let room = this.byAccount.get(accountId);
    if (!room) this.byAccount.set(accountId, (room = new Set()));
    const entry = { socket, deviceId };
    room.add(entry);
    socket.on('close', () => room!.delete(entry));
  }

  nudge(accountId: string, latestSeq: number, exceptDeviceId?: string): void {
    const room = this.byAccount.get(accountId);
    if (!room) return;
    const msg: NudgeMessage = { type: 'nudge', latestSeq };
    const json = JSON.stringify(msg);
    for (const { socket, deviceId } of room) {
      if (deviceId === exceptDeviceId) continue;
      if (socket.readyState === socket.OPEN) socket.send(json);
    }
  }

  /**
   * Rebroadcast a register's cart snapshot to the account's other devices so
   * they can act as customer displays. Ephemeral — nothing is stored.
   */
  relayDisplayCart(accountId: string, fromDeviceId: string, cart: DisplayCartMessage['cart']): void {
    const room = this.byAccount.get(accountId);
    if (!room) return;
    const msg: DisplayCartMessage = { type: 'display.cart', from: fromDeviceId, cart };
    const json = JSON.stringify(msg);
    for (const { socket, deviceId } of room) {
      if (deviceId === fromDeviceId) continue;
      if (socket.readyState === socket.OPEN) socket.send(json);
    }
  }

  /**
   * Point-to-point relay for the remote payment trigger/result handshake —
   * only the named target device gets the message, unlike the broadcast
   * relayDisplayCart. Ephemeral — nothing is stored.
   */
  relayToDevice(accountId: string, fromDeviceId: string, msg: PaymentMessage): void {
    const room = this.byAccount.get(accountId);
    if (!room) return;
    const stamped: PaymentMessage = { ...msg, from: fromDeviceId };
    const json = JSON.stringify(stamped);
    for (const { socket, deviceId } of room) {
      if (deviceId === msg.to && socket.readyState === socket.OPEN) socket.send(json);
    }
  }
}

export async function registerWs(app: FastifyInstance, rooms: Rooms, db: Database.Database): Promise<void> {
  await app.register(websocket);

  app.get('/api/sync/ws', { websocket: true }, (socket, req) => {
    const { token, deviceId, flavor } = req.query as { token?: string; deviceId?: string; flavor?: string };
    let claims: JwtClaims;
    try {
      claims = app.jwt.verify<JwtClaims>(token ?? '');
    } catch {
      socket.close(4001, 'invalid token');
      return;
    }
    rooms.add(claims.accountId, deviceId ?? 'unknown', socket);
    if (deviceId) {
      // Best-effort presence touch — a device that mostly just listens (e.g.
      // a Carbon in customer-display mode) may rarely push its own ops, so a
      // WS connection is often the only signal that it's still around.
      try {
        touchDevice(db, deviceId, claims.accountId, claims.sub, null, flavor || null, Date.now());
      } catch {
        /* devices row requires an existing account/user FK — skip on any edge case */
      }
    }
    socket.on('message', (raw) => {
      // Registers push ephemeral customer-display cart snapshots and the
      // remote-payment trigger/result handshake; everything else is ignored
      // (sync data always travels over HTTP).
      try {
        const msg = JSON.parse(String(raw)) as DisplayCartMessage | PaymentMessage;
        if (msg?.type === 'display.cart' && msg.cart && typeof msg.cart === 'object') {
          rooms.relayDisplayCart(claims.accountId, deviceId ?? 'unknown', msg.cart);
        } else if (
          (msg?.type === 'payment.trigger' || msg?.type === 'payment.result') &&
          typeof msg.to === 'string' &&
          typeof msg.requestId === 'string'
        ) {
          rooms.relayToDevice(claims.accountId, deviceId ?? 'unknown', msg);
        }
      } catch {
        /* not JSON — ignore */
      }
    });
  });
}
