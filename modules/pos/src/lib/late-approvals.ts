import { ref } from 'vue';
import { fmtPrice } from '@zollify/shared';
import { logDiagnostic } from './diagnostics';
import { sdk } from '../runtime';

/**
 * Card payments a terminal approved after the till had given up on them
 * (Cancel, retry, "Complete by hand", no answer in time). The customer's card
 * was charged and no sale was recorded for it, so the seller has to be told:
 * at once, and for as long as it takes someone to deal with it.
 *
 * Kept in this device's own settings, so the warning survives a reload and
 * needs no connection. The till shows the list as a banner until each entry
 * is marked as dealt with.
 */
export interface LateApproval {
  id: string;
  /** When the till learned of the approval. */
  at: number;
  /** The terminal's label, as the seller knows it. */
  terminal: string;
  /** What the card was charged, in the currency it was charged in. */
  amount: number;
  currency: string;
  /** The terminal's own reference, to find the payment on it for a refund. */
  txRef?: string;
}

const LATE_APPROVALS_KEY = 'payments.lateApprovals';

export const lateApprovals = ref<LateApproval[]>([]);

const save = (): Promise<void> => sdk().config.set(LATE_APPROVALS_KEY, lateApprovals.value.map((a) => ({ ...a })));

/** One sentence the seller can act on. */
export function lateApprovalText(a: LateApproval): string {
  const ref = a.txRef ? ` (ref ${a.txRef})` : '';
  return `Card charged, no sale recorded: ${a.terminal} approved ${fmtPrice(a.amount, a.currency)}${ref} after the payment was cancelled here. Record the sale by hand or refund it on the terminal.`;
}

/** Reads the warnings a previous session left behind, keeping any raised since this one started. */
export async function loadLateApprovals(): Promise<void> {
  const stored = (await sdk().config.get<LateApproval[]>(LATE_APPROVALS_KEY)) ?? [];
  const known = new Set(lateApprovals.value.map((a) => a.id));
  lateApprovals.value = [...(Array.isArray(stored) ? stored.filter((a) => !known.has(a.id)) : []), ...lateApprovals.value];
}

/** Warns the seller now and keeps the warning until it is dismissed. */
export async function reportLateApproval(approval: Omit<LateApproval, 'id' | 'at'>): Promise<void> {
  const entry: LateApproval = { ...approval, id: crypto.randomUUID(), at: Date.now() };
  // On screen first: saving must never be what stands between the seller and the warning.
  lateApprovals.value = [...lateApprovals.value, entry];
  logDiagnostic(`Terminal ${entry.terminal} approved a payment after the till gave up on it - not recorded (txRef=${entry.txRef ?? '-'})`);
  sdk().ui.toast(lateApprovalText(entry), { kind: 'error', timeoutMs: 15_000 });
  await save().catch((err) => logDiagnostic(`Could not save the late-approval warning: ${String(err)}`));
}

/** The seller dealt with it: recorded the sale by hand, or refunded the card. */
export async function dismissLateApproval(id: string): Promise<void> {
  lateApprovals.value = lateApprovals.value.filter((a) => a.id !== id);
  await save();
}
