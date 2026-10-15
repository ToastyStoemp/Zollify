import type { CashClosing, CashMovement, Transaction } from '@zollify/shared';

/**
 * The till register: what the tax office is told about each electronic till
 * (§ 146a Abs. 4 AO, the "Mitteilung über elektronische Aufzeichnungssysteme"
 * filed in Mein ELSTER) - one row per till serial number, with the device
 * behind it, when it took its first and last receipt, and the TSEs that
 * signed for it. Built from the synced records, so it covers every device
 * and needs nothing typed in.
 */

export interface TillTse {
  serial: string;
  /** How the TSE described itself when signing; fiskaly's cloud TSE and the Swissbit stick read differently. */
  algorithm: string;
  /** Not certified: a test TSE or fiskaly's TEST environment - never reported to the tax office. */
  test: boolean;
  firstSignedAt: number;
  lastSignedAt: number;
  signatures: number;
}

export interface TillRecord {
  till: string;
  /** Device ids that used this till serial number - more than one when a device was replaced under the same number. */
  deviceIds: string[];
  device: CashClosing['device'] | null;
  firstReceiptAt: number | null;
  lastReceiptAt: number | null;
  receipts: number;
  closings: number;
  tses: TillTse[];
}

export interface TillRegisterInput {
  closings: CashClosing[];
  transactions: Transaction[];
  movements?: CashMovement[];
}

export function tillRegister(input: TillRegisterInput): TillRecord[] {
  const byTill = new Map<string, TillRecord>();
  const row = (till: string): TillRecord => {
    let r = byTill.get(till);
    if (!r) {
      r = { till, deviceIds: [], device: null, firstReceiptAt: null, lastReceiptAt: null, receipts: 0, closings: 0, tses: [] };
      byTill.set(till, r);
    }
    return r;
  };
  const seen = (r: TillRecord, at: number, deviceId: string): void => {
    r.receipts++;
    r.firstReceiptAt = r.firstReceiptAt == null ? at : Math.min(r.firstReceiptAt, at);
    r.lastReceiptAt = r.lastReceiptAt == null ? at : Math.max(r.lastReceiptAt, at);
    if (deviceId && !r.deviceIds.includes(deviceId)) r.deviceIds.push(deviceId);
  };
  const signed = (r: TillRecord, tse: Transaction['tse'], at: number): void => {
    if (!tse || !('signed' in tse)) return;
    const s = tse.signed;
    let t = r.tses.find((x) => x.serial === s.serial);
    if (!t) {
      t = { serial: s.serial, algorithm: s.algorithm, test: s.test === true, firstSignedAt: at, lastSignedAt: at, signatures: 0 };
      r.tses.push(t);
    }
    t.signatures++;
    t.firstSignedAt = Math.min(t.firstSignedAt, at);
    t.lastSignedAt = Math.max(t.lastSignedAt, at);
  };

  for (const tx of input.transactions) {
    if (tx.receipt) {
      const r = row(tx.receipt.till);
      seen(r, tx.timestamp, tx.deviceId);
      signed(r, tx.tse, tx.timestamp);
    }
    if (tx.revertReceipt) {
      const r = row(tx.revertReceipt.till);
      const at = tx.revertedAt ?? tx.timestamp;
      seen(r, at, '');
      signed(r, tx.revertTse, at);
    }
  }
  for (const m of input.movements ?? []) {
    if (!m.receipt) continue;
    const r = row(m.receipt.till);
    seen(r, m.timestamp, m.deviceId);
    signed(r, m.tse, m.timestamp);
  }
  // The device behind the till, as the latest closing describes it.
  const latest = new Map<string, CashClosing>();
  for (const c of input.closings) {
    const r = row(c.till);
    r.closings++;
    if (c.deviceId && !r.deviceIds.includes(c.deviceId)) r.deviceIds.push(c.deviceId);
    const have = latest.get(c.till);
    if (!have || c.createdAt > have.createdAt) latest.set(c.till, c);
  }
  for (const [till, c] of latest) row(till).device = c.device;
  for (const r of byTill.values()) r.tses.sort((a, b) => a.firstSignedAt - b.firstSignedAt);
  return [...byTill.values()].sort((a, b) => (a.firstReceiptAt ?? 0) - (b.firstReceiptAt ?? 0) || a.till.localeCompare(b.till));
}
