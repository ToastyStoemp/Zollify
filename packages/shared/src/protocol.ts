import { z } from 'zod';
import { VatProfileSchema, VatProfileUpdateSchema, type VatProfile } from './vat';

/** Wire protocol between app and sync server - validated with zod on both sides. */

export const OpTypeSchema = z.enum([
  'tx.create',
  'tx.revert',
  'product.upsert',
  'product.delete',
  'product.merge',
  'event.upsert',
  'event.close',
  'stock.set',
  /** A claim is still `stock.set`; this carries the inventory count above it. */
  'inventory.set',
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
  /** 'carbon' | 'compat' | 'full' | 'web' - lets other devices on the account
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
   * data and re-pull from seq 0 - the payloads it cached are no longer current.
   */
  epoch?: number;
  /**
   * Nothing past this page: the client may move its cursor straight to
   * `latestSeq`. Set when the pull skipped the caller's own ops (`device`),
   * where the newest ops may all be its own and so never appear in a page.
   */
  caughtUp?: boolean;
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
  /** Why this was sent, e.g. "payment-failed" or "manual" - free text. */
  reason: z.string().optional(),
  log: z.string().min(1).max(2_000_000),
});
export type LogUpload = z.infer<typeof LogUploadSchema>;

export type UserRole = 'owner' | 'admin' | 'member';

/** Who is behind the booth - printed on customs paperwork and receipts. */
export const ArtistDetailsSchema = z.object({
  companyName: z.string().max(120).default(''),
  fullName: z.string().max(120).default(''),
  street: z.string().max(160).default(''),
  postCodeCity: z.string().max(120).default(''),
  countryOfOrigin: z.string().max(80).default(''),
  phone: z.string().max(40).default(''),
  email: z.string().max(160).default(''),
  /** VAT/tax identifier, shown on customs invoices. */
  vatId: z.string().max(40).default(''),
  /** EORI number, required on EU export declarations. */
  eori: z.string().max(40).default(''),
});
export type ArtistDetails = z.infer<typeof ArtistDetailsSchema>;
/**
 * A change to some artist fields. Built without the defaults: in zod 4
 * `.partial()` keeps them, so an update naming one field blanked the rest.
 */
const ArtistDetailsUpdateSchema = z.object(
  Object.fromEntries(Object.entries(ArtistDetailsSchema.shape).map(([k, v]) => [k, v.unwrap()])) as {
    [K in keyof typeof ArtistDetailsSchema.shape]: ReturnType<(typeof ArtistDetailsSchema.shape)[K]['unwrap']>;
  },
).partial();

/** Account-wide settings that every device shares; kept on the server, not synced as ops. */
export interface AccountProfile {
  /** When first-run setup was finished or skipped; null shows the wizard. */
  setupCompletedAt: number | null;
  artist: ArtistDetails;
  /** ISO code new events and the cash-up fall back to. */
  defaultCurrency: string;
  /** Small-business VAT exemptions, by country - see resolveEventVat. */
  vat?: VatProfile;
  /** Staff see sales totals (takings, stats, expected cash). Off: they see single sales only, and cash up blind. */
  staffSeesTotals?: boolean;
}

/** Whether this person may see sales totals: owners and admins always, staff when the account allows it. */
export function seesSalesTotals(who: { role: string; profile?: Pick<AccountProfile, 'staffSeesTotals'> } | null | undefined): boolean {
  if (!who) return false;
  return who.role !== 'member' || who.profile?.staffSeesTotals === true;
}

export const CurrencyCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);

export const ProfileUpdateSchema = z.object({
  /** Renames the account; owner only. */
  name: z.string().trim().min(1).max(80).optional(),
  artist: ArtistDetailsUpdateSchema.optional(),
  defaultCurrency: CurrencyCodeSchema.optional(),
  setupCompleted: z.boolean().optional(),
  vat: VatProfileUpdateSchema.optional(),
  staffSeesTotals: z.boolean().optional(),
});
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

export function emptyProfile(): AccountProfile {
  return { setupCompletedAt: null, artist: ArtistDetailsSchema.parse({}), defaultCurrency: 'CHF', vat: VatProfileSchema.parse({}), staffSeesTotals: false };
}

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  accountId: string;
  accountName: string;
  /** Event ids a restricted "helper" is limited to; null/absent = full access. */
  allowedEventIds?: string[] | null;
  profile?: AccountProfile;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/** WS doorbell message - tells clients to pull over HTTP; carries no data itself. */
export interface NudgeMessage {
  type: 'nudge';
  latestSeq: number;
}

/** WS doorbell: the account has a new notification. Carries nothing; devices fetch over HTTP. */
export interface NotificationMessage {
  type: 'notification';
}

/** A short note for an account, shown under the shell's bell. */
export interface AppNotification {
  id: string;
  moduleId: string | null;
  title: string;
  body: string;
  /** In-app path to open, e.g. "/m/consignment?tab=mine". */
  link: string | null;
  createdAt: number;
  readAt: number | null;
}

/**
 * Sent once, right when a device connects (or reconnects) - the shell content
 * only ever changes by redeploying the whole server, so a fresh connection is
 * exactly when there might be something new to check for. Same doorbell
 * shape as NudgeMessage: carries no version, the client re-checks over HTTP.
 */
export interface ShellUpdateMessage {
  type: 'shell.update';
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
  /**
   * Set right after a completed sale - displays show a thank-you state.
   * `receiptUrl` is the customer's online receipt; each display decides for
   * itself whether to show it as a QR code.
   */
  paid?: { total: number; receiptUrl?: string };
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

/**
 * Device → server: whether this connection is showing a customer display.
 * Only subscribed connections receive cart snapshots; a connection that never
 * says either way (an older build) keeps receiving them all, as before.
 */
export interface DisplaySubscribeMessage {
  type: 'display.subscribe';
  on: boolean;
}

/**
 * Server → every device of the account: how many customer displays are
 * listening right now. A register with none to talk to stops broadcasting its
 * cart; one appearing gets the current cart at once.
 */
export interface DisplayListenersMessage {
  type: 'display.listeners';
  count: number;
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
  /** Commit this server runs, when known. */
  commit?: string;
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
