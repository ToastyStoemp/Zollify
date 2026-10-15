import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Real historical exchange rates for converting a sale's charged local
 * amount back into the account's base currency for bookkeeping - the real
 * market rate for the day it happened, never an event's own pricing rate
 * (which can be a deliberate round-number convenience, e.g. 1:1).
 *
 * Proxied server-side rather than called directly from the browser because
 * the upstream, Frankfurter (frankfurter.app, ECB-rate-based, free, keyless,
 * full history), does not send CORS headers - a page's own `fetch` to it is
 * blocked by the browser regardless of origin.
 */
const UPSTREAM = 'https://api.frankfurter.app';

/** A settled historical date's rate never changes; today's/latest can still move. */
const cache = new Map<string, number>();

function cacheKey(date: string, from: string, to: string): string {
  return `${date}:${from}:${to}`;
}

async function lookupRate(date: string, from: string, to: string, isSettled: boolean): Promise<number | null> {
  if (from === to) return 1;
  const key = cacheKey(date, from, to);
  if (isSettled) {
    const cached = cache.get(key);
    if (cached != null) return cached;
  }

  const res = await fetch(`${UPSTREAM}/${isSettled ? date : 'latest'}?from=${from}&to=${to}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { rates?: Record<string, unknown> };
  const rate = body.rates?.[to];
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return null;
  if (isSettled) cache.set(key, rate);
  return rate;
}

export function registerFxRoutes(app: FastifyInstance): void {
  app.get('/api/fx/rates', { preHandler: app.authenticate }, async (req: FastifyRequest, reply) => {
    const query = req.query as { from?: string; to?: string; dates?: string };
    const from = query.from?.trim().toUpperCase();
    const to = query.to?.trim().toUpperCase();
    const dates = query.dates?.split(',').map((d) => d.trim()).filter(Boolean) ?? [];
    if (!from || !to || !dates.length) {
      return reply.code(400).send({ error: 'invalid_params', message: 'from, to and dates are required.' });
    }
    // These go into the upstream URL and the cache key: strict shapes and a bounded count.
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || dates.length > 400 || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
      return reply.code(400).send({ error: 'invalid_params', message: 'Use three-letter currency codes and YYYY-MM-DD dates (at most 400).' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const unique = [...new Set(dates)];
    const rates: Record<string, number> = {};
    await Promise.all(
      unique.map(async (date) => {
        const rate = await lookupRate(date, from, to, date < today);
        if (rate != null) rates[date] = rate;
      }),
    );
    return { rates };
  });
}
