import type Database from 'better-sqlite3';

/**
 * The one record of what the server keeps per account and what becomes of it
 * when the account is deleted, or its data wiped.
 *
 * Every table is declared here (core) or by the module that owns it, with an
 * action for each of the two: `erase`, or `retain` with a written reason and
 * period. Deletion and wipe both run from these declarations, and a test
 * compares them with the live schema - so a new table that is not declared
 * fails the build instead of quietly outliving its account, and nothing with a
 * reason to stay is removed by a list someone forgot to read.
 *
 * Why erase is the default: for a booth's sales data Zollify is the processor
 * and the merchant is the controller, who takes the records along (the backup
 * export) and keeps them for as long as their own bookkeeping law says. Once
 * the service ends, the processor's copy goes (GDPR Art. 28(3)(g)). `retain`
 * is for what Zollify itself, or the account that lives on, must keep.
 */

/** Kept on purpose: say why, and for how long. Both are required reading for a reviewer. */
export interface Retain {
  retain: { reason: string; period: string };
}

export type DataAction = 'erase' | Retain;

/** `delete`: the account ends. `wipe`: its booth data starts over, the account stays. */
export type ErasureMode = 'delete' | 'wipe';

export interface AccountTable {
  table: string;
  /**
   * SQL condition that picks the account's rows, with `@accountId` for the
   * account. Left out for the usual `accountId = @accountId`.
   */
  where?: string;
  /** What the rows are, in a few words. */
  holds: string;
  /** Whose personal data is in them: 'none', or who (merchant, staff, customers...). */
  personal: string;
  onDelete: DataAction;
  onWipe: DataAction;
}

/** A table that belongs to the server as a whole: no row of it is any one account's. */
export interface ServerTable {
  table: string;
  holds: string;
  /** Why no account's deletion has anything to remove from it. */
  reason: string;
}

const BY_ACCOUNT = 'accountId = @accountId';
const BY_USER = 'userId IN (SELECT id FROM users WHERE accountId = @accountId)';

/** A wipe resets the booth's data and nothing else (routes/account.ts): the account, its people and their devices go on. */
const STAYS_ON_WIPE: Retain = {
  retain: { reason: 'A wipe resets the booth data, not the account: its users, devices, sign-ins and settings stay', period: 'until the account is deleted' },
};

/** Declares a table that is erased both with the account and by a wipe - what most module tables are. */
export function erased(table: string, holds: string, personal: string): AccountTable {
  return { table, holds, personal, onDelete: 'erase', onWipe: 'erase' };
}

/** Declares a table that is erased with the account but is not booth data, so a wipe leaves it. */
function accountOnly(table: string, holds: string, personal: string, where?: string): AccountTable {
  return { table, holds, personal, onDelete: 'erase', onWipe: STAYS_ON_WIPE, ...(where ? { where } : {}) };
}

/**
 * Core's per-account tables, in the order they are erased: rows that point at
 * a user come before the users, and the account row goes last (below).
 */
export const CORE_ACCOUNT_TABLES: AccountTable[] = [
  erased('ops', 'The synced log: products, events, stock, sales, settings', 'merchant, staff; customers where a sale names one'),
  erased('images', 'Index of full-size product images on disk (written by older versions)', 'none'),
  erased('event_files', 'Index of files attached to events (tickets, floor plans)', 'merchant'),
  erased('metrics', 'Daily usage counters (logins, pushes, sales count)', 'none'),
  accountOnly('logs', 'Index of diagnostic logs a device uploaded', 'staff (device names)'),
  accountOnly('feedback', 'Bug reports and ideas sent from the app', 'staff (free text, user id)'),
  accountOnly('api_tokens', 'Hashed machine-access tokens', 'none'),
  accountOnly('webhooks', 'Webhook targets and what they listen for', 'merchant (URLs)'),
  accountOnly('notifications', 'In-app notes under the bell', 'merchant, staff'),
  accountOnly('reminders', 'The last day each reminder went out', 'none'),
  accountOnly('problems', 'Failures reported to the owners and admins', 'merchant'),
  accountOnly('problem_settings', 'Whether problems are emailed as a digest', 'none'),
  accountOnly('account_modules', 'Which modules the account switched on', 'none'),
  accountOnly('device_users', 'People added to a shared till, with their unlock state', 'staff'),
  accountOnly('device_revocations', 'When a removed device was signed out, so its old tokens are refused', 'none'),
  accountOnly('devices', 'Devices signed in to the account, with push token and time zone', 'staff'),
  accountOnly('refresh_tokens', 'Login sessions: device, IP address, rough location', 'staff', BY_USER),
  accountOnly('trusted_devices', 'Devices that may skip the 2FA code', 'staff', BY_USER),
  accountOnly('pin_misses', 'Wrong-PIN counter and lockout per user', 'staff', BY_USER),
  accountOnly('device_links', 'Waiting sign-ins by QR code (minutes-lived)', 'staff', BY_USER),
  accountOnly('google_links', 'Waiting Google sign-ins (minutes-lived), by email', 'staff', 'email IN (SELECT email FROM users WHERE accountId = @accountId)'),
  // An invite for a brand-new account has no accountId but still names the user who made or used it.
  accountOnly(
    'invites',
    'Invite codes made for or by the account',
    'staff',
    `${BY_ACCOUNT} OR createdBy IN (SELECT id FROM users WHERE accountId = @accountId) OR usedBy IN (SELECT id FROM users WHERE accountId = @accountId)`,
  ),
];

/** The account itself: erased after everything that points at it, modules' tables included. */
export const ACCOUNT_ROOT_TABLES: AccountTable[] = [
  accountOnly('users', 'Logins: email, password hash, 2FA secret, PIN, badge', 'staff'),
  accountOnly('accounts', 'The account: name, business profile, VAT details', 'merchant', 'id = @accountId'),
];

export const CORE_SERVER_TABLES: ServerTable[] = [
  { table: 'server_meta', holds: 'Whether the server was ever set up', reason: 'One flag for the whole server' },
  { table: 'server_settings', holds: 'Settings the server owner made in the admin panel, encrypted', reason: "The server's own configuration" },
  { table: 'file_removals', holds: 'Files a committed erasure still has to remove from disk', reason: 'A work queue, emptied as soon as the files are gone' },
];

/** Everything declared for a server: what core keeps and what each module said it keeps. */
export interface AccountData {
  /** Every per-account table, in erasure order. */
  tables: AccountTable[];
  serverTables: ServerTable[];
}

export function collectAccountData(modules: { id: string; accountData?: AccountTable[]; serverTables?: ServerTable[] }[]): AccountData {
  const data: AccountData = {
    tables: [...CORE_ACCOUNT_TABLES, ...modules.flatMap((m) => m.accountData ?? []), ...ACCOUNT_ROOT_TABLES],
    serverTables: [...CORE_SERVER_TABLES, ...modules.flatMap((m) => m.serverTables ?? [])],
  };
  checkAccountData(data);
  return data;
}

const isRetain = (action: DataAction): action is Retain => action !== 'erase';
const blank = (s: string | undefined): boolean => !s || !s.trim();

/** What is wrong with one table's declaration, if anything. */
function declarationProblem(t: AccountTable): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(t.table)) return 'is not a plain table name';
  if (blank(t.holds) || blank(t.personal)) return 'must say what it holds and whose personal data that is';
  for (const action of [t.onDelete, t.onWipe]) {
    if (isRetain(action) && (blank(action.retain.reason) || blank(action.retain.period))) return 'is retained without a written reason and period';
  }
  return null;
}

/**
 * Refuses a declaration nobody could review: a table declared twice, or one
 * retained without saying why and for how long. Run at boot, so a mistake
 * stops the server before it can lose or keep the wrong thing.
 */
export function checkAccountData(data: AccountData): void {
  const seen = new Set<string>();
  for (const t of data.tables) {
    const problem = declarationProblem(t);
    if (problem) throw new Error(`Account data: ${t.table} ${problem}`);
  }
  for (const { table } of [...data.tables, ...data.serverTables]) {
    if (seen.has(table)) throw new Error(`Account data: ${table} is declared twice`);
    seen.add(table);
  }
}

export const actionFor = (t: { onDelete: DataAction; onWipe: DataAction }, mode: ErasureMode): DataAction => (mode === 'delete' ? t.onDelete : t.onWipe);
const whereOf = (t: AccountTable): string => t.where ?? BY_ACCOUNT;

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** How many rows of a declared table belong to the account. */
export function accountRows(db: Database.Database, t: AccountTable, accountId: string): number {
  if (!tableExists(db, t.table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${whereOf(t)}`).get({ accountId }) as { n: number }).n;
}

/**
 * Removes the account's rows from every table whose action for this mode is
 * `erase`, in declared order. Call it inside a transaction. A table that does
 * not exist is skipped: a module whose migration failed must not be what
 * stops someone's data from being erased.
 */
export function eraseAccountRows(db: Database.Database, tables: AccountTable[], accountId: string, mode: ErasureMode): void {
  for (const t of tables) {
    if (actionFor(t, mode) !== 'erase' || !tableExists(db, t.table)) continue;
    db.prepare(`DELETE FROM ${t.table} WHERE ${whereOf(t)}`).run({ accountId });
  }
}
