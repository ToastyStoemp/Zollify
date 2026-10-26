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
  | 'setting.upsert'
  | 'tx.test.create'
  | 'tx.test.revert'
  | 'tx.test.end'
  | 'tx.test.clear';

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
export const STAFF_OP_TYPES: readonly string[] = ['tx.create', 'tx.revert', 'stock.set', 'tx.test.create', 'tx.test.revert', 'tx.test.end'];

/**
 * Synced settings under this prefix are the team's, not the owner's: staff
 * (and helpers limited to some events) may write them too. Day-to-day state a
 * module wants every colleague to change - where stock sits, say - lives here;
 * configuration stays outside it.
 */
export const TEAM_SETTING_PREFIX = 'team.';

/** A synced setting the whole team may write. */
export function isTeamSetting(op: { type: string; payload: unknown }): boolean {
  if (op.type !== 'setting.upsert') return false;
  const key = (op.payload as { key?: unknown } | null)?.key;
  return typeof key === 'string' && key.startsWith(TEAM_SETTING_PREFIX) && key.length > TEAM_SETTING_PREFIX.length;
}

/** Whether staff may push this op: a sale, a refund, a claim, or a team setting. */
export function isStaffOp(op: { type: string; payload: unknown }): boolean {
  return STAFF_OP_TYPES.includes(op.type) || isTeamSetting(op);
}

/**
 * A staff badge as a scanner reads it: "ZS", then 24 digits (about 80 bits,
 * unguessable with the server's rate limits). Digits pack two to a Code 128
 * symbol, so the barcode fits a 40mm label at a width scanners read well.
 * Scanners and keyboards may change case or add a dash or spaces.
 */
export const STAFF_BADGE_PATTERN = /^ZS[-\s]?(?:\d[\s]?){24}$/i;
export const isStaffBadge = (code: string): boolean => STAFF_BADGE_PATTERN.test(code.trim());
/** The one spelling a badge is stored and compared in: "ZS" and the 24 digits. */
export const normaliseStaffBadge = (code: string): string => `ZS${code.replace(/\D/g, '')}`;
