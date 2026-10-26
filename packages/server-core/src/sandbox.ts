import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseProfile, toAuthUser, type JwtClaims, type UserRow } from './auth';
import type { ServerModule } from './modules/mount';

/**
 * Sandbox accounts: throwaway accounts for trying everything out - a test
 * store and a test artist consigning to it, say - where every setting works
 * for real but nothing reaches real money or real people unmarked. Cards go
 * only to the pretend terminal (the app), emails say [TEST] (app.ts), payout
 * files are marked test (consignment), and a sandbox only ever links with
 * another sandbox, so test data never crosses into a real account.
 */

export function isSandbox(db: Database.Database, accountId: string | null | undefined): boolean {
  if (!accountId) return false;
  const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(accountId) as { profile: string | null } | undefined;
  return parseProfile(row?.profile).sandbox === true;
}

/** Whether two accounts may be linked: both sandboxes, or neither. */
export const sameWorld = (db: Database.Database, a: string, b: string): boolean => isSandbox(db, a) === isSandbox(db, b);

/** Marks an email from a sandbox as a test, once. */
export function testMail<T extends { subject: string; text: string }>(m: T): T {
  if (m.subject.startsWith('[TEST]')) return m;
  return { ...m, subject: `[TEST] ${m.subject}`, text: `This comes from a Zollify test account - nothing in it is a real order, sale or payment.\n\n${m.text}` };
}

const Body = z.object({ on: z.boolean() });

/**
 * Switches an account to a sandbox and back. Admins only. Refused while the
 * account is linked to an account on the other side (a real store, for a
 * sandbox artist), as the modules report their links (accountRelations).
 */
export function registerSandboxRoute(app: FastifyInstance, db: Database.Database, modules: Pick<ServerModule, 'accountRelations'>[]): void {
  app.post('/api/account/sandbox', { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'forbidden', message: 'Only an admin can make this a test account.' });
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', message: 'Say on or off.' });
    const on = body.data.on;
    const partners = new Set<string>();
    for (const m of modules) {
      for (const r of m.accountRelations?.(db) ?? []) {
        if (r.from === claims.accountId) partners.add(r.to);
        if (r.to === claims.accountId) partners.add(r.from);
      }
    }
    if ([...partners].some((id) => isSandbox(db, id) !== on)) {
      return reply.code(409).send({
        error: 'linked',
        message: on
          ? 'This account is linked with real accounts (consignment). Unlink them first - a test account only links with other test accounts.'
          : 'This account is linked with test accounts (consignment). Unlink them first - a real account never links with a test account.',
      });
    }
    const row = db.prepare('SELECT profile FROM accounts WHERE id = ?').get(claims.accountId) as { profile: string | null } | undefined;
    const { sandbox: _was, ...profile } = parseProfile(row?.profile);
    db.prepare('UPDATE accounts SET profile = ? WHERE id = ?').run(JSON.stringify(on ? { ...profile, sandbox: true } : profile), claims.accountId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claims.sub) as UserRow;
    return { user: toAuthUser(db, user) };
  });
}
