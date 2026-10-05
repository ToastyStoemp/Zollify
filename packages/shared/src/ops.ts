/** Sync op log - every local mutation becomes one op; the server just orders and fans them out. */

export type OpType =
  | 'tx.create'
  | 'tx.revert'
  | 'product.upsert'
  | 'product.delete'
  | 'product.merge'
  | 'event.upsert'
  | 'event.close'
  | 'stock.set'
  | 'discount.upsert'
  | 'discount.delete'
  | 'image.meta'
  | 'setting.upsert';

export interface Op {
  /** uuidv7, client-generated, globally unique - the idempotency key. */
  opId: string;
  deviceId: string;
  /** Client wall clock (informational; LWW uses payload.updatedAt). */
  ts: number;
  type: OpType;
  payload: unknown;
}

/** The changes staff (role member) may make; the server drops anything else they push. */
export const STAFF_OP_TYPES: readonly string[] = ['tx.create', 'tx.revert', 'stock.set'];

/**
 * A staff badge as a scanner reads it: "ZS", an optional dash, then 22
 * characters without look-alikes. Scanned at a shared till, it unlocks as
 * the badge's owner.
 */
export const STAFF_BADGE_PATTERN = /^ZS-?[A-HJ-NP-Z2-9]{22}$/i;
export const isStaffBadge = (code: string): boolean => STAFF_BADGE_PATTERN.test(code.trim());
