import type Database from 'better-sqlite3';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountData } from './account-data';

/**
 * Looking at what the database and the data directory still hold about an
 * account, straight from the schema - no list of tables to keep up to date.
 *
 * The erasure tests use this to prove that deleting an account leaves nothing
 * behind: they fill every table, delete, and ask what still mentions the
 * account. Nothing calls it while the server runs.
 */

interface Column {
  name: string;
  type: string;
}

/** Who an account is in the data: its id, its users' ids and their emails. */
export interface AccountNeedles {
  accountId: string;
  userIds: string[];
  emails: string[];
}

/** The account, and the one user the made-up rows are written for. */
export interface SeedIdentity {
  accountId: string;
  userId: string;
  email: string;
}

/** Every table in the database, alphabetically. */
export function allTables(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function columnsOf(db: Database.Database, table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Column[];
}

export function needlesOf(db: Database.Database, accountId: string): AccountNeedles {
  const users = db.prepare('SELECT id, email FROM users WHERE accountId = ?').all(accountId) as { id: string; email: string }[];
  return { accountId, userIds: users.map((u) => u.id), emails: users.map((u) => u.email) };
}

/** Rows of one table in which any column carries one of the given identifiers. */
function rowsMentioning(db: Database.Database, table: string, needles: string[]): number {
  const columns = columnsOf(db, table);
  const inAnyColumn = (param: string): string => columns.map((c) => `instr(CAST("${c.name}" AS TEXT), ${param}) > 0`).join(' OR ');
  const where = needles.map((_, i) => `(${inAnyColumn(`@n${i}`)})`).join(' OR ');
  const params = Object.fromEntries(needles.map((n, i) => [`n${i}`, n]));
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(params) as { n: number }).n;
}

/**
 * Per table, how many rows mention the account anywhere - in a key column or
 * inside a JSON document. Tables with none are left out.
 */
export function accountFootprint(db: Database.Database, who: AccountNeedles): Record<string, number> {
  const needles = [who.accountId, ...who.userIds, ...who.emails].filter(Boolean);
  const found: Record<string, number> = {};
  for (const table of allTables(db)) {
    const n = rowsMentioning(db, table, needles);
    if (n > 0) found[table] = n;
  }
  return found;
}

const USER_COLUMNS = new Set(['userId', 'createdBy', 'usedBy']);
/** Columns read as JSON, some by an index: they need a document, not a word. */
const JSON_COLUMNS = new Set(['payload', 'doc']);

/** The first value each `CHECK (column IN ('a', 'b'))` of a table allows, by column. */
function allowedValues(db: Database.Database, table: string): Record<string, string> {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
  const allowed: Record<string, string> = {};
  for (const m of sql.matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(\s*'([^']*)'/gi)) allowed[m[1]] = m[2];
  return allowed;
}

function seedValue(column: Column, who: SeedIdentity, table: string, allowed: Record<string, string>): unknown {
  if (column.name === 'accountId') return who.accountId;
  if (USER_COLUMNS.has(column.name)) return who.userId;
  if (column.name === 'email') return who.email;
  if (column.name in allowed) return allowed[column.name];
  if (JSON_COLUMNS.has(column.name)) return JSON.stringify({ seed: table });
  const type = column.type.toUpperCase();
  if (type.includes('INT') || type.includes('REAL')) return 1;
  if (type.includes('BLOB')) return Buffer.from('seed');
  // Told apart per account, so two seeded accounts never collide on a unique column - by a
  // piece of the id too short to be mistaken for the account when the footprint is taken.
  return `seed-${table}-${column.name}-${who.accountId.slice(0, 8)}`;
}

/** Whether a table points at an account by a column this seeding knows how to fill. */
const refersToAccount = (columns: Column[]): boolean => columns.some((c) => c.name === 'accountId' || c.name === 'userId' || c.name === 'email');

/** One made-up row for the account in one table; a row that is already there is left as it is. */
function seedTable(db: Database.Database, table: string, columns: Column[], who: SeedIdentity): void {
  const allowed = allowedValues(db, table);
  const names = columns.map((c) => `"${c.name}"`).join(', ');
  const marks = columns.map(() => '?').join(', ');
  try {
    db.prepare(`INSERT INTO ${table} (${names}) VALUES (${marks})`).run(...columns.map((c) => seedValue(c, who, table, allowed)));
  } catch (err) {
    const hasRow = rowsMentioning(db, table, [who.accountId, who.userId, who.email]) > 0;
    if (!hasRow) throw new Error(`Could not seed a row in ${table}: ${(err as Error).message}`);
  }
}

/**
 * Puts one made-up row for the account in every table that points at an
 * account, user or email, so a deletion has something to remove everywhere.
 * Throws when a table ends up without a row - a constraint this seeding does
 * not know yet - so a test never passes on a table it silently skipped.
 * Returns the tables it filled.
 */
export function seedEveryAccountTable(db: Database.Database, who: SeedIdentity): string[] {
  const seeded: string[] = [];
  for (const table of allTables(db)) {
    const columns = columnsOf(db, table);
    if (table === 'accounts' || !refersToAccount(columns)) continue;
    seedTable(db, table, columns, who);
    seeded.push(table);
  }
  return seeded;
}

/**
 * The tables of the live database that nobody declared, and the declared ones
 * that do not exist: both must be empty, or a table can outlive its account
 * (or a declaration its table) without anyone having decided so.
 */
export function undeclaredTables(db: Database.Database, data: AccountData): { undeclared: string[]; missing: string[] } {
  const declared = new Set([...data.tables, ...data.serverTables].map((t) => t.table));
  const live = new Set(allTables(db));
  return { undeclared: [...live].filter((t) => !declared.has(t)), missing: [...declared].filter((t) => !live.has(t)) };
}

/** Server-wide declarations whose table has an accountId column after all - a per-account table filed wrongly. */
export function misfiledServerTables(db: Database.Database, data: AccountData): string[] {
  return data.serverTables.map((t) => t.table).filter((table) => columnsOf(db, table).some((c) => c.name === 'accountId'));
}

/** Every file under the data directory except the database itself, as paths relative to it. */
export function dataFiles(dataDir: string, under = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dataDir, under), { withFileTypes: true })) {
    const rel = under ? `${under}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...dataFiles(dataDir, rel));
    else if (!rel.startsWith('zollify.db')) out.push(rel);
  }
  return out.sort();
}
