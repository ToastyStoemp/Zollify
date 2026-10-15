import { authFetch } from '../session';

/**
 * Free, keyless exchange-rate lookup - ported from ZollTool. Only ever
 * prefills a convention's rate; nothing applies it without the seller
 * seeing the number first.
 */
export async function fetchExchangeRate(base: string, target: string): Promise<number | null> {
  const from = base.trim().toUpperCase();
  const to = target.trim().toUpperCase();
  if (!from || !to) return null;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: Record<string, unknown> };
    const rate = data.rates?.[to];
    return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
  } catch {
    return null;
  }
}

/**
 * Real historical day rates - for converting what was actually collected in
 * a local currency back into the base currency for bookkeeping (History's
 * base-currency toggle), using the real market rate for the day a sale
 * happened - never an event's own `exchangeRate` (a pricing/rounding
 * convenience, e.g. a deliberate round-number 1:1, not a claim about the
 * real rate). Proxied through our own `/api/fx/rates` (server-core's
 * routes/fx.ts, backed by Frankfurter): Frankfurter sends no CORS headers,
 * so a page's own `fetch` to it is blocked by the browser outright.
 *
 * A settled historical date's rate never changes, so it's cached in
 * localStorage indefinitely once fetched - the same date range otherwise
 * re-fetches on every History page load, for numbers already known.
 */
const FX_CACHE_PREFIX = 'zollify.fxrate.';

function fxCacheKey(from: string, to: string, date: string): string {
  return `${FX_CACHE_PREFIX}${date}:${from}:${to}`;
}

function readFxCache(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as number) : null;
  } catch {
    return null;
  }
}

function writeFxCache(key: string, rate: number): void {
  try {
    localStorage.setItem(key, JSON.stringify(rate));
  } catch {
    /* private browsing, storage blocked, or full - just re-fetches next time */
  }
}

/**
 * Batches unique date lookups for one currency pair - e.g. every day a
 * History view's currently-visible transactions span. A date that fails or
 * has no rate is simply absent from the result map; callers should fall
 * back gracefully rather than treat that as an error. Dates already settled
 * in localStorage are served from there without a round trip; the rest go
 * in one request to `/api/fx/rates`.
 */
export async function fetchHistoricalRates(base: string, target: string, dates: string[]): Promise<Map<string, number>> {
  const from = base.trim().toUpperCase();
  const to = target.trim().toUpperCase();
  const result = new Map<string, number>();
  if (!from || !to) return result;

  const today = new Date().toISOString().slice(0, 10);
  const missing: string[] = [];
  for (const date of new Set(dates)) {
    if (from === to) {
      result.set(date, 1);
      continue;
    }
    const cached = date < today ? readFxCache(fxCacheKey(from, to, date)) : null;
    if (cached != null) result.set(date, cached);
    else missing.push(date);
  }
  if (!missing.length) return result;

  try {
    const query = new URLSearchParams({ from, to, dates: missing.join(',') });
    const body = (await authFetch(`/fx/rates?${query}`)) as { rates?: Record<string, unknown> };
    for (const [date, rate] of Object.entries(body.rates ?? {})) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) continue;
      result.set(date, rate);
      if (date < today) writeFxCache(fxCacheKey(from, to, date), rate);
    }
  } catch {
    /* offline or the server call failed - callers fall back gracefully */
  }
  return result;
}

/** Single-date convenience wrapper around {@link fetchHistoricalRates}. */
export async function fetchHistoricalRate(base: string, target: string, date: string): Promise<number | null> {
  const rates = await fetchHistoricalRates(base, target, [date]);
  return rates.get(date) ?? null;
}

/**
 * Today's market rate, for charging a card in another currency at the till
 * (POS's "charge cards in the base currency"). Tries our own `/api/fx/rates`
 * first, then the keyless lookup above. A booth is often offline, so the last
 * rate fetched is kept per pair and served when neither answers; `at` says how
 * old it is so the till can show it.
 */
const FX_LATEST_PREFIX = 'zollify.fxlatest.';

export async function fetchLatestRate(base: string, target: string): Promise<{ rate: number; at: number } | null> {
  const from = base.trim().toUpperCase();
  const to = target.trim().toUpperCase();
  if (!from || !to) return null;
  if (from === to) return { rate: 1, at: Date.now() };

  const key = `${FX_LATEST_PREFIX}${from}:${to}`;
  const today = new Date().toISOString().slice(0, 10);
  const rate = (await fetchHistoricalRates(from, to, [today])).get(today) ?? (await fetchExchangeRate(from, to));
  if (rate != null) {
    const fresh = { rate, at: Date.now() };
    try {
      localStorage.setItem(key, JSON.stringify(fresh));
    } catch {
      /* storage blocked - just no offline fallback */
    }
    return fresh;
  }
  try {
    const raw = localStorage.getItem(key);
    const cached = raw ? (JSON.parse(raw) as { rate?: unknown; at?: unknown }) : null;
    if (cached && typeof cached.rate === 'number' && Number.isFinite(cached.rate) && typeof cached.at === 'number') {
      return { rate: cached.rate, at: cached.at };
    }
  } catch {
    /* fall through */
  }
  return null;
}
