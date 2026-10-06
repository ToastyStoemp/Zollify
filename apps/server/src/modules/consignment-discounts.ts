import type { FastifyInstance } from 'fastify';
import {
  ArtistDiscountInputSchema,
  artistDiscountRuleId,
  commissionFor,
  consignmentLines,
  fmtPrice,
  localDay,
  type ArtistDiscount,
  type DiscountRule,
  type Transaction,
  type WebhookMessage,
  type WireOp,
} from '@zollify/shared';
import { isEnabled, reduceDiscounts, type ModuleContext, type ModuleServices } from '@zollify/server-core';
import { MODULE_ID, accountName, consignorRow, consignorRows, parseDoc, replay, toConsignor, type ConsignorRow } from './consignment';
import { booksSettings } from './consignment-books';

/**
 * Artists' own discounts, and what consignment tells webhooks.
 *
 * An artist may put their work in a store on discount - within the store's
 * limit, or not at all if the store says so. The discount is written into
 * the store's data as an ordinary discount rule (managed by
 * 'consignment-artist'), so every till applies it, offline too. The store
 * can end it from its Discounts screen; the artist hears.
 *
 * Webhooks: an artist's account hears each sale of their work in a store
 * ('consigned-sale'), and both sides' daily and weekly summaries gain a line
 * about consignment.
 */

const MANAGED_BY = 'consignment-artist';
const prefix = (consignorId: string): string => `artist:${consignorId}:`;

/** The rules one artist has running in a store, as the artist sees them. */
export function discountsFor(svc: Pick<ModuleServices, 'db'>, storeAccountId: string, consignorId: string): ArtistDiscount[] {
  const ops = (
    svc.db
      .prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('discount.upsert', 'discount.delete') AND json_extract(payload, '$.id') LIKE ? ORDER BY seq")
      .all(storeAccountId, `${prefix(consignorId)}%`) as { opId: string; type: string; payload: string }[]
  ).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));
  return reduceDiscounts(ops)
    .filter((r) => !r.deletedAt && r.id.startsWith(prefix(consignorId)))
    .map((r) => ({
      id: r.id.slice(prefix(consignorId).length),
      name: r.name,
      percent: r.percent ?? 0,
      productIds: r.productIds,
      ...(r.validFrom ? { validFrom: r.validFrom } : {}),
      ...(r.validUntil ? { validUntil: r.validUntil } : {}),
      eventIds: r.eventIds ?? [],
      updatedAt: r.updatedAt,
    }));
}

/** Ends every artist discount in a store - when the store stops allowing them. */
export function endArtistDiscounts(svc: ModuleServices, storeAccountId: string): number {
  const ids = (
    svc.db
      .prepare("SELECT DISTINCT json_extract(payload, '$.id') AS id FROM ops WHERE accountId = ? AND type = 'discount.upsert' AND json_extract(payload, '$.id') LIKE 'artist:%'")
      .all(storeAccountId) as { id: string }[]
  ).map((r) => r.id);
  const live = new Set(
    consignorRows(svc.db, storeAccountId).flatMap((c) => discountsFor(svc, storeAccountId, c.id).map((d) => artistDiscountRuleId(c.id, d.id))),
  );
  const doomed = ids.filter((id) => live.has(id));
  if (doomed.length) svc.writeOps(storeAccountId, doomed.map((id) => ({ type: 'discount.delete', payload: { id, deletedAt: Date.now() } })));
  return doomed.length;
}

export function registerArtistDiscounts(app: FastifyInstance, ctx: ModuleContext): void {
  const { db } = ctx;
  const linkOf = (req: Parameters<ModuleContext['identity']>[0], storeAccountId: string, consignorId: string): ConsignorRow | null => {
    const row = consignorRow(db, storeAccountId, consignorId);
    if (!row || row.linkedAccountId !== ctx.identity(req).accountId || !isEnabled(db, storeAccountId, MODULE_ID)) return null;
    return row;
  };

  /** What the artist may do here, what they have running, and what it can apply to. */
  app.get<{ Params: { storeAccountId: string; consignorId: string } }>('/links/:storeAccountId/:consignorId/discounts', async (req, reply) => {
    const row = linkOf(req, req.params.storeAccountId, req.params.consignorId);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const settings = booksSettings(db, row.accountId);
    const { products, events } = replay(db, row.accountId);
    const doc = parseDoc(row.doc);
    return {
      allowed: settings.artistDiscounts,
      maxPct: settings.artistDiscountMaxPct,
      discounts: discountsFor(ctx, row.accountId, row.id),
      items: products.filter((p) => p.consignorId === row.id).map((p) => ({ productId: p.id, title: p.title })),
      stores: events.filter((e) => !e.deletedAt && doc.storeIds.includes(e.id)).map((e) => ({ id: e.id, name: e.name })),
    };
  });

  app.put<{ Params: { storeAccountId: string; consignorId: string; id: string } }>('/links/:storeAccountId/:consignorId/discounts/:id', async (req, reply) => {
    const row = linkOf(req, req.params.storeAccountId, req.params.consignorId);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!/^[\w-]{1,60}$/.test(req.params.id)) return reply.code(400).send({ error: 'invalid_request' });
    const settings = booksSettings(db, row.accountId);
    const store = accountName(db, row.accountId) ?? 'The store';
    if (!settings.artistDiscounts) return reply.code(403).send({ error: 'not_allowed', message: `${store} does not let artists set their own discounts.` });
    const body = ArtistDiscountInputSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: body.error.issues[0]?.message ?? 'Check the discount.' });
    const d = body.data;
    if (d.percent > settings.artistDiscountMaxPct) return reply.code(400).send({ error: 'too_deep', message: `${store} allows at most ${settings.artistDiscountMaxPct}% off.` });
    if (d.validFrom && d.validUntil && d.validUntil < d.validFrom) return reply.code(400).send({ error: 'invalid_request', message: 'The last day is before the first.' });
    const { products, events } = replay(db, row.accountId);
    const mine = new Set(products.filter((p) => p.consignorId === row.id).map((p) => p.id));
    if (d.productIds.some((id) => !mine.has(id))) return reply.code(400).send({ error: 'invalid_request', message: 'Only your own items.' });
    const doc = parseDoc(row.doc);
    const venues = new Set(events.filter((e) => doc.storeIds.includes(e.id)).map((e) => e.id));
    if (d.eventIds.some((id) => !venues.has(id))) return reply.code(400).send({ error: 'invalid_request', message: 'Only stores that carry your work.' });

    const ruleId = artistDiscountRuleId(row.id, req.params.id);
    const existed = discountsFor(ctx, row.accountId, row.id).some((x) => x.id === req.params.id);
    const rule: DiscountRule = {
      id: ruleId,
      name: `${doc.name}: ${d.name}`,
      type: 'nth_pct',
      nth: 1,
      percent: d.percent,
      productIds: d.productIds,
      variantIds: [],
      // Without picked items it covers all of the artist's work; with them, those only.
      ...(d.productIds.length ? {} : { consignorIds: [row.id] }),
      ...(d.validFrom ? { validFrom: d.validFrom } : {}),
      ...(d.validUntil ? { validUntil: d.validUntil } : {}),
      ...(d.eventIds.length ? { eventIds: d.eventIds } : {}),
      managedBy: MANAGED_BY,
      updatedAt: Date.now(),
    };
    ctx.writeOps(row.accountId, [{ type: 'discount.upsert', payload: rule }]);
    const when = d.validFrom || d.validUntil ? ` (${d.validFrom ?? 'now'} to ${d.validUntil ?? 'open-ended'})` : '';
    ctx.notify(row.accountId, {
      kind: 'discounts',
      title: `${doc.name} ${existed ? 'changed' : 'set'} a discount: ${d.percent}% off${d.productIds.length ? ` ${d.productIds.length} item${d.productIds.length === 1 ? '' : 's'}` : ' their work'}`,
      body: `${d.name}${when}. It applies at the till already; you can end it under Discounts.`,
      link: '/discounts',
      minRole: 'admin',
    });
    return { discount: { ...d, id: req.params.id, updatedAt: rule.updatedAt } satisfies ArtistDiscount };
  });

  app.delete<{ Params: { storeAccountId: string; consignorId: string; id: string } }>('/links/:storeAccountId/:consignorId/discounts/:id', async (req, reply) => {
    const row = linkOf(req, req.params.storeAccountId, req.params.consignorId);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const d = discountsFor(ctx, row.accountId, row.id).find((x) => x.id === req.params.id);
    if (!d) return reply.code(404).send({ error: 'not_found' });
    ctx.writeOps(row.accountId, [{ type: 'discount.delete', payload: { id: artistDiscountRuleId(row.id, d.id), deletedAt: Date.now() } }]);
    ctx.notify(row.accountId, { kind: 'discounts', title: `${parseDoc(row.doc).name} ended a discount`, body: d.name, link: '/discounts', minRole: 'admin' });
    return { ok: true };
  });
}

// ── Following the store's devices ───────────────────────────────────────────

/** The store ended an artist's discount from its own Discounts screen: the artist hears. */
export function followStoreDiscounts(svc: ModuleServices, storeAccountId: string, ops: WireOp[]): void {
  for (const op of ops) {
    if (op.type !== 'discount.delete') continue;
    const id = (op.payload as { id?: string } | null)?.id ?? '';
    const m = /^artist:([^:]+):/.exec(id);
    if (!m) continue;
    const row = consignorRow(svc.db, storeAccountId, m[1]!);
    if (!row?.linkedAccountId) continue;
    const rule = reduceDiscounts(
      (svc.db.prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type = 'discount.upsert' AND json_extract(payload, '$.id') = ? ORDER BY seq").all(storeAccountId, id) as {
        opId: string;
        type: string;
        payload: string;
      }[]).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown })),
    )[0];
    svc.notify(row.linkedAccountId, {
      kind: 'discounts',
      title: `${accountName(svc.db, storeAccountId) ?? 'The store'} ended your discount`,
      body: rule?.name ?? '',
      link: '/m/consignment?tab=mine',
      minRole: 'admin',
    });
  }
}

/** Each sale of an artist's work in a store, to the artist's webhooks. */
export function announceConsignedSales(svc: ModuleServices, storeAccountId: string, ops: WireOp[]): void {
  const sales = ops
    .filter((o) => o.type === 'tx.create')
    .map((o) => o.payload as Transaction)
    .filter((t) => t?.items?.some((i) => i.consignorId) && Date.now() - t.timestamp < 24 * 3600 * 1000)
    .slice(0, 20);
  if (!sales.length) return;
  const store = accountName(svc.db, storeAccountId) ?? 'A store';
  const rows = new Map<string, ConsignorRow | undefined>();
  const rowOf = (id: string) => {
    if (!rows.has(id)) rows.set(id, consignorRow(svc.db, storeAccountId, id));
    return rows.get(id);
  };
  for (const tx of sales) {
    const byArtist = new Map<string, typeof tx.items>();
    for (const i of tx.items) if (i.consignorId) byArtist.set(i.consignorId, [...(byArtist.get(i.consignorId) ?? []), i]);
    for (const [consignorId, items] of byArtist) {
      const row = rowOf(consignorId);
      if (!row?.linkedAccountId) continue;
      const doc = parseDoc(row.doc);
      const currency = tx.baseCurrency ?? tx.currency;
      let share = 0;
      const lines = items.map((i) => {
        const gross = i.baseLineTotal ?? i.lineTotal;
        const pct = typeof i.commissionPct === 'number' ? i.commissionPct : commissionFor(doc, tx.eventId);
        share += Math.round(gross * (100 - pct)) / 100;
        return `${i.qty} × ${i.title}${i.variantLabel ? ` (${i.variantLabel})` : ''} - ${fmtPrice(gross, currency)}`;
      });
      svc.webhooks.emit(row.linkedAccountId, 'consigned-sale', {
        title: `Sold at ${store}: ${fmtPrice(share, currency)} for you`,
        body: lines.join('\n'),
        tone: 'good',
      } satisfies WebhookMessage);
    }
  }
}

/** Consignment's lines in a daily or weekly webhook summary, for a store and for an artist. */
export function consignmentSummary(svc: ModuleServices, accountId: string, period: { from: string; to: string; timeZone: string }): WebhookMessage['fields'] {
  const fields: NonNullable<WebhookMessage['fields']> = [];
  const inPeriod = (at: number): boolean => {
    const d = localDay(at, period.timeZone);
    return d >= period.from && d <= period.to;
  };

  // As a store: what the artists' work brought in.
  const consignors = consignorRows(svc.db, accountId).map((r) => toConsignor(svc.db, r));
  if (consignors.length) {
    const lines = consignmentLines(replay(svc.db, accountId).transactions, consignors).filter((l) => inPeriod(l.at));
    const byCurrency = new Map<string, { gross: number; commission: number; units: number }>();
    for (const l of lines) {
      const a = byCurrency.get(l.currency) ?? { gross: 0, commission: 0, units: 0 };
      a.gross += l.gross;
      a.commission += l.commission;
      a.units += l.qty;
      byCurrency.set(l.currency, a);
    }
    for (const [c, a] of byCurrency) fields.push({ name: "Artists' work", value: `${a.units} items, ${fmtPrice(a.gross, c)} - commission ${fmtPrice(a.commission, c)}` });
  }

  // As an artist: what sold in the stores they consign with.
  const links = svc.db.prepare('SELECT * FROM consignors WHERE linkedAccountId = ?').all(accountId) as ConsignorRow[];
  const parts: string[] = [];
  for (const row of links) {
    if (!isEnabled(svc.db, row.accountId, MODULE_ID)) continue;
    const doc = parseDoc(row.doc);
    const lines = consignmentLines(replay(svc.db, row.accountId).transactions, [{ id: row.id, commissionPct: doc.commissionPct, storeCommission: doc.storeCommission }]).filter((l) => inPeriod(l.at));
    if (!lines.length) continue;
    const units = lines.reduce((s, l) => s + l.qty, 0);
    const share = lines.reduce((s, l) => s + l.artistShare, 0);
    parts.push(`${accountName(svc.db, row.accountId) ?? 'A store'}: ${units} item${units === 1 ? '' : 's'}, ${fmtPrice(share, lines[0]!.currency)} for you`);
  }
  if (parts.length) fields.push({ name: 'Sold in stores', value: parts.join('\n') });
  return fields;
}
