import { computed, reactive } from 'vue';
import type { CashMovement, CashMovementReason } from '@zollify/shared';
import { openCoreDb } from './db';
import { getAccount } from '../session';
import { queueOp } from './outbox';
import { toPlain } from './plain';
import { deviceId } from './device';
import { getSalesEvent } from './sales-events';
import { signCashMovement, tseRequiredFor } from './tse';
import { localDay, takeReceiptNumber } from './closings';

/**
 * Cash put into or taken out of the till that is not a sale.
 *
 * The starting float, the owner topping the box up or taking money out, cash
 * carried to the bank: each is recorded once, numbered as a receipt on this
 * till and - at an event in Germany - signed by the TSE, so the day's closing
 * and the tax export explain what is in the box. Core keeps them because they
 * are account records like sales: never deleted, synced to every device.
 */

const movements = reactive(new Map<string, CashMovement>());

function requireAccountId(): string {
  const account = getAccount();
  if (!account) throw new Error('Cash movements were used while signed out.');
  return account.accountId;
}

export async function loadCashMovements(): Promise<void> {
  const rows = await openCoreDb(requireAccountId()).cashMoves.toArray();
  movements.clear();
  for (const row of rows) movements.set(row.id, row);
}

/** Every movement known here, newest first. */
export const cashMovements = computed(() => [...movements.values()].sort((a, b) => b.timestamp - a.timestamp));

/** The movements at one event, newest first. */
export function cashMovementsFor(eventId: string): CashMovement[] {
  return cashMovements.value.filter((m) => m.eventId === eventId);
}

/** What the movements at an event add up to: in minus out, per currency; the float counted separately. */
export function cashMovementTotals(eventId: string, currency: string): { float: number; moved: number } {
  let float = 0;
  let moved = 0;
  for (const m of cashMovementsFor(eventId)) {
    if (m.currency !== currency) continue;
    const cents = Math.round(m.amount * 100) * (m.direction === 'out' ? -1 : 1);
    if (m.reason === 'float') float += cents;
    else moved += cents;
  }
  return { float: float / 100, moved: moved / 100 };
}

export const CASH_MOVEMENT_REASONS: { id: CashMovementReason; label: string; direction: 'in' | 'out' }[] = [
  { id: 'float', label: 'Starting cash (float)', direction: 'in' },
  { id: 'deposit', label: 'Cash put in', direction: 'in' },
  { id: 'withdrawal', label: 'Cash taken out', direction: 'out' },
  { id: 'bank', label: 'Taken to the bank', direction: 'out' },
];

export function directionOf(reason: CashMovementReason): 'in' | 'out' {
  return CASH_MOVEMENT_REASONS.find((r) => r.id === reason)?.direction ?? 'in';
}

export interface CashMovementInput {
  eventId: string;
  reason: CashMovementReason;
  amount: number;
  currency: string;
  note?: string;
}

/**
 * Records a movement on this till: numbered as a receipt of its own (closing
 * the till first when the day, event or currency changed, like a sale) and
 * signed when the event is in Germany. A TSE failure is kept on the record
 * rather than stopping it - the box has to be explainable either way.
 */
export async function recordCashMovement(input: CashMovementInput): Promise<CashMovement> {
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0)) throw new Error('Give an amount above zero.');
  if (!input.eventId) throw new Error('Pick the event the till is at.');
  const db = openCoreDb(requireAccountId());
  const who = getAccount();
  const timestamp = Date.now();
  const move: CashMovement = toPlain({
    id: crypto.randomUUID(),
    eventId: input.eventId,
    deviceId: await deviceId(),
    timestamp,
    direction: directionOf(input.reason),
    reason: input.reason,
    amount,
    currency: input.currency,
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
    ...(who ? { by: { userId: who.userId, email: who.email } } : {}),
  });
  move.receipt = await takeReceiptNumber({ day: localDay(timestamp), eventId: move.eventId, currency: move.currency });
  if (tseRequiredFor(getSalesEvent(move.eventId))) move.tse = toPlain(await signCashMovement(move));
  await db.cashMoves.put(move);
  movements.set(move.id, move);
  await queueOp({ type: 'cash.move', payload: move });
  return move;
}

/** Sync: another device's movement (or this one's, from a restore). Insert-if-absent. */
export async function applyCashMovement(incoming: CashMovement): Promise<number> {
  const db = openCoreDb(requireAccountId());
  if (await db.cashMoves.get(incoming.id)) return 0;
  await db.cashMoves.put(incoming);
  movements.set(incoming.id, incoming);
  return 1;
}

export function resetCashMovementCache(): void {
  movements.clear();
}
