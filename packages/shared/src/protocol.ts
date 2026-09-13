import { z } from 'zod';

/** Wire protocol between app and sync server — validated with zod on both sides. */

export const OpTypeSchema = z.enum([
  'tx.create',
  'tx.revert',
  'product.upsert',
  'product.delete',
  'product.merge',
  'event.upsert',
  'event.close',
  'stock.set',
  'discount.upsert',
  'discount.delete',
  'image.meta',
  'setting.upsert',
]);

export const OpSchema = z.object({
  opId: z.string().min(16),
  deviceId: z.string().min(1),
  ts: z.number(),
  type: OpTypeSchema,
  payload: z.unknown(),
});
export type WireOp = z.infer<typeof OpSchema>;

/** An op as stored/fanned out by the server: ordered per account. */
export const ServerOpSchema = OpSchema.extend({
  serverSeq: z.number(),
});
export type ServerOp = z.infer<typeof ServerOpSchema>;

// ── Sync ─────────────────────────────────────────────────────────────────────

export const PushRequestSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().optional(),
  /** 'carbon' | 'compat' | 'full' | 'web' — lets other devices on the account
   *  find e.g. a Carbon terminal to target for a remote payment trigger. */
  flavor: z.string().optional(),
  ops: z.array(OpSchema).max(500),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

/** A device the account has seen, for pickers like "which Carbon to target". */
export interface DeviceSummary {
  id: string;
  name: string | null;
  flavor: string | null;
  lastSeenAt: number;
}

export interface PushResponse {
  accepted: number;
  duplicates: number;
  latestSeq: number;
}

export interface PullResponse {
  ops: ServerOp[];
  latestSeq: number;
  /**
   * Account-wide log epoch. Bumped when the server rewrites its op-log in place
   * (e.g. baking product merges into the stored payloads). A client that sees an
   * epoch different from the one it last stored must discard all local synced
   * data and re-pull from seq 0 — the payloads it cached are no longer current.
   */
  epoch?: number;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export const RegisterRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  /** Required unless the server runs with REGISTRATION_OPEN=1. */
  inviteCode: z.string().optional(),
  /** Name for the new account (ignored when the invite joins an existing one). */
  accountName: z.string().min(1).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(16),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

// ── Diagnostic logs (client → server → /admin download) ─────────────────────

export const LogUploadSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().optional(),
  flavor: z.string().optional(),
  appVersion: z.string().optional(),
  /** Why this was sent, e.g. "payment-failed" or "manual" — free text. */
  reason: z.string().optional(),
  log: z.string().min(1).max(2_000_000),
});
export type LogUpload = z.infer<typeof LogUploadSchema>;

export type UserRole = 'owner' | 'admin' | 'member';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  accountId: string;
  accountName: string;
  /** Event ids a restricted "helper" is limited to; null/absent = full access. */
  allowedEventIds?: string[] | null;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/** WS doorbell message — tells clients to pull over HTTP; carries no data itself. */
export interface NudgeMessage {
  type: 'nudge';
  latestSeq: number;
}

// ── Customer display (ephemeral cart relay over the sync WS) ────────────────

/** Self-contained cart snapshot a register broadcasts for customer displays. */
export interface DisplayCart {
  deviceName: string;
  eventName: string;
  currency: string;
  lines: Array<{ title: string; variantLabel?: string; qty: number; lineTotal: number }>;
  discounts: Array<{ name: string; amount: number }>;
  total: number;
  /** Set right after a completed sale — displays show a thank-you state. */
  paid?: { total: number };
  ts: number;
}

/**
 * Sent register → server (no `from`), rebroadcast server → account room with
 * `from` = the register's deviceId. Never persisted.
 */
export interface DisplayCartMessage {
  type: 'display.cart';
  from?: string;
  cart: DisplayCart;
}

// ── Remote payment trigger (register → satellite Carbon terminal) ──────────
// Unlike DisplayCartMessage (broadcast to the whole account room), these are
// point-to-point: `to` names the exact target device, and the server relays
// only to that device rather than everyone. Never persisted.

export interface PaymentTriggerMessage {
  type: 'payment.trigger';
  /** Stamped by the server from the sender's own deviceId. */
  from?: string;
  /** Target Carbon's deviceId. */
  to: string;
  requestId: string;
  amount: number;
  currency: string;
  reference: string;
}

export interface PaymentResultMessage {
  type: 'payment.result';
  /** Stamped by the server from the sender's own deviceId. */
  from?: string;
  /** Target register's deviceId. */
  to: string;
  requestId: string;
  approved: boolean;
  txRef?: string;
  cardBrand?: string;
  authCode?: string;
  error?: string;
}

// ── Admin (owner-only) ───────────────────────────────────────────────────────

export interface AdminOverview {
  accounts: number;
  users: number;
  devices: number;
  ops: number;
  transactions: number;
  activeToday: number;
}

export interface AdminAccount {
  id: string;
  name: string;
  createdAt: number;
  userCount: number;
  deviceCount: number;
  opCount: number;
  txTotal: number;
  /** Most recent op received or device seen, whichever is later (0 = never). */
  lastActivityAt: number;
}

export interface AdminAccountDetail {
  account: AdminAccount;
  users: { id: string; email: string; role: UserRole; createdAt: number; lastLoginAt: number | null }[];
  devices: { id: string; name: string | null; createdAt: number; lastSeenAt: number }[];
}

export interface AdminMetricRow {
  accountId: string;
  accountName: string;
  day: string;
  logins: number;
  syncPushes: number;
  opsReceived: number;
  txCount: number;
}

export interface AdminLogEntry {
  id: string;
  accountId: string;
  accountName: string;
  deviceId: string;
  deviceName: string | null;
  flavor: string | null;
  appVersion: string | null;
  reason: string | null;
  size: number;
  createdAt: number;
}
