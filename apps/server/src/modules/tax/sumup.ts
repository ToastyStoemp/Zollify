import { dayEndISO, dayStartISO, num, pick, round2, resolveMode, sleep, str, SourceError, type SourceRow } from './types';

/**
 * SumUp API client - pulls merchant transaction history for a date range and
 * normalises it into Payment/Fee rows.
 *
 *   GET /v2.1/merchants/{merchant_code}/transactions/history
 */

export interface SumupConfig {
  mode: 'live' | 'mock';
  apiUrl: string;
  apiKey: string;
  merchantCode: string;
}

export function loadSumupConfig(env: Record<string, string>): SumupConfig {
  const apiKey = env.SUMUP_API_KEY ?? '';
  const merchantCode = env.SUMUP_MERCHANT_CODE ?? '';
  return {
    mode: resolveMode(env.SUMUP_MODE, Boolean(apiKey && merchantCode)),
    apiUrl: (env.SUMUP_API_URL || 'https://api.sumup.com').replace(/\/+$/, ''),
    apiKey,
    merchantCode,
  };
}

const MAX_RETRIES = 4;

export class SumupClient {
  constructor(readonly config: SumupConfig) {}

  get mode(): 'live' | 'mock' {
    return this.config.mode;
  }

  get configured(): boolean {
    return Boolean(this.config.apiKey && this.config.merchantCode);
  }

  async listTransactions(from: string, to: string): Promise<SourceRow[]> {
    if (this.mode === 'mock') return mockTransactions(from, to);
    const rows = await this.history(from, to);
    return rows.flatMap(normalizeTransaction);
  }

  private async history(from: string, to: string): Promise<Record<string, unknown>[]> {
    if (!this.configured) throw new SourceError('Missing SumUp API key / merchant code.', 401);
    const out: Record<string, unknown>[] = [];
    let url: URL | null = new URL(`${this.config.apiUrl}/v2.1/merchants/${encodeURIComponent(this.config.merchantCode)}/transactions/history`);
    url.searchParams.set('oldest_time', dayStartISO(from));
    url.searchParams.set('newest_time', dayEndISO(to));
    url.searchParams.set('order', 'ascending');
    url.searchParams.set('limit', '100');
    for (let guard = 0; url && guard < 500; guard++) {
      const json = (await this.get(url.toString())) as { items?: Record<string, unknown>[]; links?: unknown };
      out.push(...(Array.isArray(json.items) ? json.items : []));
      url = nextPageUrl(json.links, this.config.apiUrl, this.config.merchantCode);
    }
    return out;
  }

  private async get(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json' } });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      if (!res.ok) throw new SourceError(`SumUp API ${res.status}: ${await res.text()}`, res.status);
      return res.json();
    }
  }
}

export function normalizeTransaction(row: Record<string, unknown>): SourceRow[] {
  const status = str(pick(row, ['status', 'simple_status'])).toUpperCase();
  const type = str(pick(row, ['type'])).toUpperCase();
  if (status && !['SUCCESSFUL', 'REFUNDED'].includes(status)) return [];
  if (type && !['PAYMENT', ''].includes(type)) return [];

  const amount = round2(num(pick(row, ['amount', 'transaction_amount'])));
  const refunded = round2(num(pick(row, ['refunded_amount'])));
  const netAmount = round2(amount - refunded);
  if (netAmount <= 0) return [];

  const paymentType = str(pick(row, ['payment_type'])).toUpperCase();
  const isOnline = paymentType === 'ECOM';
  const terminal = isOnline ? 'SumUp Online' : 'SumUp POS';
  const ref = str(pick(row, ['transaction_code', 'id', 'transaction_id']));
  const card = str(pick(row, ['card_type', 'card', 'payment_type', 'entry_mode'])) || paymentType || 'SumUp';
  const date = str(pick(row, ['timestamp', 'created_at', 'date'])) || new Date().toISOString();
  const currency = str(pick(row, ['currency'])) || 'EUR';
  const fee = round2(Math.abs(num(pick(row, ['fee', 'fee_amount', 'transaction_fee']))));
  const rows: SourceRow[] = [
    { date, type: 'Payment', amount: netAmount, currency, terminal, card, ref, desc: `SumUp transaction ${ref}`.trim(), source: 'sumup', isOnline },
  ];
  if (fee > 0) {
    rows.push({ date, type: 'Fee', amount: -fee, currency, terminal, card: 'SumUp fee', ref, desc: `SumUp fee ${ref}`.trim(), source: 'sumup', isOnline });
  }
  return rows;
}

export function nextPageUrl(links: unknown, apiUrl: string, merchantCode: string): URL | null {
  const next = Array.isArray(links) ? (links as { rel?: string; href?: string }[]).find((l) => l.rel === 'next' && l.href) : null;
  if (!next?.href) return null;
  const href = String(next.href);
  if (/^https?:\/\//i.test(href)) return new URL(href);
  const url = new URL(`${apiUrl}/v2.1/merchants/${encodeURIComponent(merchantCode)}/transactions/history`);
  const query = href.startsWith('?') ? href.slice(1) : href;
  for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  return url;
}

function mockTransactions(from: string, to: string): SourceRow[] {
  const f = Date.parse(dayStartISO(from));
  const t = Date.parse(dayEndISO(to));
  if (Number.isNaN(f) || Number.isNaN(t) || t < f) return [];
  const span = Math.max(0, t - f);
  const amounts = [18.5, 34.0, 52.75, 13.2, 89.99];
  return amounts.flatMap((amount, i) => {
    const date = new Date(f + Math.round((span * (i + 1)) / (amounts.length + 1))).toISOString();
    const ref = `SUMOCK${1000 + i}`;
    return [
      { date, type: 'Payment' as const, amount, currency: 'EUR', terminal: 'SumUp POS', card: i % 2 ? 'MASTERCARD' : 'VISA', ref, desc: `SumUp transaction ${ref}`, source: 'sumup' as const, isOnline: false },
      { date, type: 'Fee' as const, amount: -round2(amount * 0.0195), currency: 'EUR', terminal: 'SumUp POS', card: 'SumUp fee', ref, desc: `SumUp fee ${ref}`, source: 'sumup' as const, isOnline: false },
    ];
  });
}
