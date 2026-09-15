import { dayEndISO, dayStartISO, num, pick, round2, resolveMode, sleep, str, SourceError, type KvCache, type SourceRow } from './types';

/**
 * myPOS Banking API client (via the myPOS API Gateway). Pulls the merchant's
 * settled card transactions and verifies a cluster against them.
 *
 * Dual auth on every request:
 *   1. POST {gateway}/api/v1/oauth/token   integration creds → Bearer
 *   2. POST {gateway}/api/v1/auth/session  Bearer + merchant creds → X-Session
 *   3. GET  {gateway}/accounting/v1/transactions?…  with both plus partner and
 *      application ids.
 *
 * Ported from ZollTax. Raw-shape assumptions are isolated in normalize() and
 * extractRows(); with no credentials, mock mode returns a fixture.
 */

export interface MyposConfig {
  mode: 'live' | 'mock';
  gatewayUrl: string;
  clientId: string;
  clientSecret: string;
  merchantClientId: string;
  merchantClientSecret: string;
  partnerId: string;
  applicationId: string;
  scope: string;
  account?: string;
}

export function loadMyposConfig(env: Record<string, string>): MyposConfig {
  const clientId = env.MYPOS_CLIENT_ID ?? '';
  const clientSecret = env.MYPOS_CLIENT_SECRET ?? '';
  const merchantClientId = env.MYPOS_MERCHANT_CLIENT_ID ?? '';
  const merchantClientSecret = env.MYPOS_MERCHANT_CLIENT_SECRET ?? '';
  const partnerId = env.MYPOS_PARTNER_ID ?? '';
  const applicationId = env.MYPOS_APPLICATION_ID ?? '';
  const hasCreds = Boolean(clientId && clientSecret && merchantClientId && merchantClientSecret && partnerId && applicationId);
  return {
    mode: resolveMode(env.MYPOS_MODE, hasCreds),
    // Production by default: the demo gateway rejects live credentials.
    gatewayUrl: (env.MYPOS_GATEWAY_URL || 'https://api-gateway.mypos.com').replace(/\/+$/, ''),
    clientId,
    clientSecret,
    merchantClientId,
    merchantClientSecret,
    partnerId,
    applicationId,
    scope: env.MYPOS_SCOPE ?? '',
    account: env.MYPOS_ACCOUNT || undefined,
  };
}

const MAX_RETRIES = 4;

interface Lease {
  value: string;
  expiresAt: number;
}

export interface MyposAccount {
  account_number: string;
  iban?: string;
  currency?: string;
  name?: string;
}

export class MyposClient {
  private token: Lease | null = null;
  private session: Lease | null = null;
  private deviceNames: Record<string, string> | null = null;

  constructor(
    readonly config: MyposConfig,
    private readonly cache: KvCache,
  ) {}

  get mode(): 'live' | 'mock' {
    return this.config.mode;
  }

  async listAccounts(): Promise<MyposAccount[]> {
    if (this.config.mode === 'mock') {
      return [{ account_number: 'MOCK-EUR', iban: 'IE00MOCK', currency: 'EUR', name: 'Mock EUR Account' }];
    }
    const json = (await this.get(`${this.config.gatewayUrl}/accounting/v1/accounts`)) as { items?: MyposAccount[] };
    return json?.items ?? [];
  }

  async listTransactions(opts: { from: string; to: string; account?: string; accounts?: string[] }): Promise<SourceRow[]> {
    if (this.config.mode === 'mock') return mockTransactions(opts.from, opts.to);
    const rows = await this.fetchAllRows(opts);
    const txns = rows.map(normalize).filter((r): r is SourceRow => r !== null);
    await this.applyDeviceNames(txns);
    return txns;
  }

  /**
   * Devices are grouped by serial (stable across TID changes) and named once
   * from the Terminals API, then remembered, so the API is hit at most once
   * per device ever.
   */
  private async applyDeviceNames(txns: SourceRow[]): Promise<void> {
    const names = (this.deviceNames ??= this.cache.get<Record<string, string>>('mypos-devices') ?? {});
    const groups = new Map<string, SourceRow[]>();
    for (const t of txns) {
      const serial = t.serial || t.terminal;
      if (!serial) continue;
      (groups.get(serial) ?? groups.set(serial, []).get(serial)!).push(t);
    }
    let changed = false;
    for (const [serial, group] of groups) {
      if (!names[serial]) {
        const recent = group.reduce((a, b) => (b.date > a.date ? b : a));
        names[serial] = (await this.lookupTerminalName(recent.terminal)) || recent.terminal || serial;
        changed = true;
      }
      for (const t of group) t.terminal = names[serial]!;
    }
    if (changed) this.cache.set('mypos-devices', names);
  }

  private async lookupTerminalName(tid: string): Promise<string> {
    if (!tid) return '';
    try {
      const d = (await this.get(`${this.config.gatewayUrl}/pos/v1/terminals/${encodeURIComponent(tid)}`)) as { terminal_name?: string };
      return String(d?.terminal_name ?? '').replace(/^myPOS\s+/i, '').trim();
    } catch {
      return '';
    }
  }

  private async accessToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.token && this.token.expiresAt > now + 30_000) return this.token.value;
    if (!this.config.clientId || !this.config.clientSecret) throw new SourceError('Missing myPOS integration client id / secret.');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret });
    if (this.config.scope) body.set('scope', this.config.scope);
    const res = await fetch(`${this.config.gatewayUrl}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (!res.ok) throw new SourceError(`myPOS OAuth token request failed (${res.status}): ${await res.text()}`, res.status);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SourceError('myPOS OAuth response had no access_token.');
    this.token = { value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async sessionId(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.session && this.session.expiresAt > now + 30_000) return this.session.value;
    if (!this.config.merchantClientId || !this.config.merchantClientSecret) throw new SourceError('Missing myPOS merchant client id / secret.');
    const token = await this.accessToken(force);
    const res = await fetch(`${this.config.gatewayUrl}/api/v1/auth/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: this.config.merchantClientId, client_secret: this.config.merchantClientSecret }),
    });
    if (!res.ok) throw new SourceError(`myPOS session request failed (${res.status}): ${await res.text()}`, res.status);
    const json = (await res.json()) as { session?: string; expires_in?: number };
    if (!json.session) throw new SourceError('myPOS session response had no session id.');
    this.session = { value: json.session, expiresAt: now + (json.expires_in ?? 300) * 1000 };
    return this.session.value;
  }

  private async accountNumbers(): Promise<string[]> {
    return (await this.listAccounts()).map((a) => String(a.account_number)).filter(Boolean);
  }

  private async fetchAllRows(opts: { from: string; to: string; account?: string; accounts?: string[] }): Promise<Record<string, unknown>[]> {
    const acct = opts.account ?? this.config.account;
    const accounts = opts.accounts?.length ? opts.accounts : acct ? [acct] : await this.accountNumbers();
    // A window fully in the past never changes, so it is cached for good.
    const stable = opts.to < new Date().toISOString().slice(0, 10);
    await this.sessionId();
    const perAccount = await Promise.all(accounts.map((a) => this.fetchAccountRows(a, opts.from, opts.to, stable)));
    return perAccount.flat();
  }

  private async fetchAccountRows(accountNumber: string, from: string, to: string, stable: boolean): Promise<Record<string, unknown>[]> {
    const key = `mypos-tx:${accountNumber}:${from}:${to}`;
    const cached = this.cache.get<{ fetchedAt: number; rows: Record<string, unknown>[] }>(key);
    if (cached && (stable || Date.now() - cached.fetchedAt < 10 * 60 * 1000)) return cached.rows;
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= 200; page++) {
      const url = new URL(`${this.config.gatewayUrl}/accounting/v1/transactions`);
      url.searchParams.set('account_number', accountNumber);
      url.searchParams.set('from_date', from);
      url.searchParams.set('to_date', to);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', '500');
      const json = await this.get(url.toString());
      const pageRows = extractRows(json);
      rows.push(...pageRows);
      if (!hasNextPage(json, pageRows.length)) break;
    }
    this.cache.set(key, { fetchedAt: Date.now(), rows });
    return rows;
  }

  private async get(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const session = await this.sessionId();
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-session': session,
          'x-partner-id': this.config.partnerId,
          'x-application-id': this.config.applicationId,
          accept: 'application/json',
        },
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      if ((res.status === 401 || res.status === 403) && attempt < 1) {
        await this.sessionId(true);
        continue;
      }
      if (!res.ok) throw new SourceError(`myPOS Banking API ${res.status}: ${await res.text()}`, res.status);
      return res.json();
    }
  }
}

/** Folds rows into { currency, count, gross, fees, net } for verification. */
export function summarize(txns: SourceRow[], fallbackCurrency = 'EUR') {
  const currency = txns[0]?.currency ?? fallbackCurrency;
  const gross = round2(txns.reduce((s, t) => s + (t.type === 'Fee' ? 0 : t.amount), 0));
  const fees = round2(txns.reduce((s, t) => s + (t.type === 'Fee' ? Math.abs(t.amount) : 0), 0));
  const count = txns.filter((t) => t.type !== 'Fee').length;
  return { currency, count, gross, fees, net: round2(gross - fees) };
}

export function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  const o = (json ?? {}) as Record<string, unknown>;
  for (const key of ['data', 'transactions', 'content', 'items', 'results']) {
    if (Array.isArray(o[key])) return o[key] as Record<string, unknown>[];
  }
  return [];
}

function hasNextPage(json: unknown, rowsThisPage: number): boolean {
  const o = (json ?? {}) as Record<string, unknown>;
  const pg = (o.pagination ?? o.meta ?? o) as Record<string, unknown>;
  if (typeof pg.has_next_page === 'boolean') return pg.has_next_page;
  if (typeof pg.has_more === 'boolean') return pg.has_more;
  if (typeof pg.hasNextPage === 'boolean') return pg.hasNextPage;
  const page = num(pick(pg, ['page', 'current_page', 'currentPage']));
  const total = num(pick(pg, ['total_pages', 'totalPages', 'pageCount']));
  if (page && total) return page < total;
  return rowsThisPage >= 100;
}

/**
 * Only rows with a terminal id are card-terminal activity - that filter drops
 * bank transfers, payouts and the merchant's own card spending. A Credit is a
 * sale, a Debit its fee; transaction_amount is already signed.
 */
export function normalize(row: Record<string, unknown>): SourceRow | null {
  const terminal = str(pick(row, ['terminal_id', 'terminalId']));
  if (!terminal) return null;
  const amount = round2(num(pick(row, ['transaction_amount', 'amount', 'value'])));
  if (!amount) return null;
  const isFee = str(pick(row, ['sign'])).toLowerCase() === 'debit';
  return {
    ref: str(pick(row, ['payment_reference', 'reference', 'id'])),
    date: str(pick(row, ['date', 'dateTime', 'created_at'])) || new Date().toISOString(),
    amount,
    currency: str(pick(row, ['transaction_currency', 'currency'])) || 'EUR',
    type: isFee ? 'Fee' : 'Payment',
    terminal,
    serial: str(pick(row, ['serial_number'])) || undefined,
    card: str(pick(row, ['pan', 'card'])),
    desc: str(pick(row, ['description', 'billing_descriptor'])),
    source: 'mypos',
    isOnline: false,
  };
}

function mockTransactions(from: string, to: string): SourceRow[] {
  const f = Date.parse(dayStartISO(from));
  const t = Date.parse(dayEndISO(to));
  if (Number.isNaN(f) || Number.isNaN(t) || t < f) return [];
  const span = Math.max(0, t - f);
  const amounts = [24.9, 49.5, 12.0, 68.05, 41.06, 31.68];
  const n = Math.min(amounts.length, span > 2 * 86_400_000 ? 6 : 3);
  const rows: SourceRow[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(f + Math.round((span * (i + 1)) / (n + 1))).toISOString();
    const amount = amounts[i]!;
    rows.push({ ref: `MPMOCK${i + 1}`, date: at, amount, currency: 'EUR', type: 'Payment', terminal: 'Mock terminal', card: 'Visa', desc: 'Mock sale', source: 'mypos', isOnline: false });
    rows.push({ ref: `MPMOCK${i + 1}`, date: at, amount: -round2(amount * 0.011), currency: 'EUR', type: 'Fee', terminal: 'Mock terminal', card: '', desc: 'Mock fee', source: 'mypos', isOnline: false });
  }
  return rows;
}
