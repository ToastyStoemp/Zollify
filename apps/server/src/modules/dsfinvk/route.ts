import type { FastifyInstance } from 'fastify';
import { zipSync, strToU8 } from 'fflate';
import type { CashClosing } from '@zollify/shared';
import { parseProfile, reduceEvents, reduceMerges, reduceTransactions, type ModuleContext } from '@zollify/server-core';
import { buildDsfinvk, type DsfinvkResult } from './build';

/**
 * GET /api/m/pos/dsfinvk?from=YYYY-MM-DD&to=YYYY-MM-DD[&all=1][&download=1]
 *
 * The DSFinV-K export for a tax inspection, over every device of the
 * account. Without `download` it answers what the export would hold and
 * what is missing; with it, the ZIP. Owners and admins only: it is the
 * whole sales record.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function registerDsfinvk(app: FastifyInstance, ctx: ModuleContext): void {
  const opsFor = (accountId: string, types: string[]) =>
    (
      ctx.db
        .prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`)
        .all(accountId, ...types) as { opId: string; type: string; payload: string }[]
    ).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));

  function build(accountId: string, from: string, to: string, germanyOnly: boolean): DsfinvkResult {
    const txOps = opsFor(accountId, ['tx.create', 'tx.revert', 'product.merge']);
    const closings = new Map<string, CashClosing>();
    for (const op of opsFor(accountId, ['closing.create'])) {
      const c = op.payload as CashClosing;
      if (c?.id && !closings.has(c.id)) closings.set(c.id, c);
    }
    const row = ctx.db.prepare('SELECT name, profile FROM accounts WHERE id = ?').get(accountId) as { name: string; profile: string | null } | undefined;
    const artist = parseProfile(row?.profile).artist;
    return buildDsfinvk({
      closings: [...closings.values()],
      transactions: reduceTransactions(txOps, reduceMerges(txOps)),
      events: reduceEvents(opsFor(accountId, ['event.upsert', 'event.close'])),
      seller: {
        name: artist.companyName.trim() || artist.fullName.trim() || row?.name || '',
        street: artist.street,
        postCodeCity: artist.postCodeCity,
        country: artist.countryOfOrigin,
        vatId: artist.vatId,
      },
      from,
      to,
      germanyOnly,
    });
  }

  app.get<{ Querystring: { from?: string; to?: string; all?: string; download?: string } }>('/dsfinvk', async (req, reply) => {
    const who = ctx.identity(req);
    if (who.role !== 'owner' && who.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can export the till records.' });
    }
    const { from = '', to = '' } = req.query;
    if (!DAY.test(from) || !DAY.test(to) || from > to) return reply.code(400).send({ error: 'invalid', message: 'Give a date range: from and to as YYYY-MM-DD.' });
    const result = build(who.accountId, from, to, req.query.all !== '1');
    if (req.query.download !== '1') return { closings: result.closings, receipts: result.receipts, warnings: result.warnings };
    const zip = zipSync(Object.fromEntries(Object.entries(result.files).map(([name, text]) => [name, strToU8(text)])), { level: 6 });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="dsfinvk_${from}_${to}.zip"`)
      .send(Buffer.from(zip));
  });
}
