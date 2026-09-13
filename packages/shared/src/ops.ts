/** Sync op log — every local mutation becomes one op; the server just orders and fans them out. */

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
  /** uuidv7, client-generated, globally unique — the idempotency key. */
  opId: string;
  deviceId: string;
  /** Client wall clock (informational; LWW uses payload.updatedAt). */
  ts: number;
  type: OpType;
  payload: unknown;
}
