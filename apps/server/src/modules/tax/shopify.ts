import { dayEndISO, dayStartISO, num, resolveMode, round2, sleep, SourceError, type SourceRow } from './types';

/**
 * Shopify Admin API orders client — pulls paid orders for a date range so
 * online and Shopify POS sales can be clustered and booked.
 *
 * Auth is a custom-app Admin API token, or a client id + secret exchanged for
 * a short-lived one. Orders are normalised to the same shape the CSV importer
 * produces: online orders go to one monthly cluster, POS orders to device
 * clusters.
 */

export interface ShopifyConfig {
  mode: 'live' | 'mock';
  shop: string;
  accessToken: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

export function loadShopifyConfig(env: Record<string, string>): ShopifyConfig {
  const shop = (env.SHOPIFY_SHOP ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const accessToken = env.SHOPIFY_ACCESS_TOKEN ?? '';
  const clientId = env.SHOPIFY_CLIENT_ID ?? '';
  const clientSecret = env.SHOPIFY_CLIENT_SECRET ?? '';
  const hasCreds = Boolean(shop && (accessToken || (clientId && clientSecret)));
  return { mode: resolveMode(env.SHOPIFY_MODE, hasCreds), shop, accessToken, clientId, clientSecret, apiVersion: env.SHOPIFY_API_VERSION || '2024-10' };
}

const MAX_RETRIES = 5;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export class ShopifyOrdersClient {
  private locationCache: Record<string, string> | null = null;
  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private accessTokenPromise: Promise<string> | null = null;

  constructor(readonly config: ShopifyConfig) {}

  get mode(): 'live' | 'mock' {
    return this.config.mode;
  }

  private get base(): string {
    return `https://${this.config.shop}/admin/api/${this.config.apiVersion}`;
  }

  get authMode(): 'static_token' | 'client_credentials' | 'none' {
    if (this.config.accessToken) return 'static_token';
    if (this.config.clientId && this.config.clientSecret) return 'client_credentials';
    return 'none';
  }

  async status(warmToken = false): Promise<{ mode: string; shop: string | null; ready: boolean; error?: string }> {
    const base = { mode: this.mode, shop: this.config.shop || null, ready: this.mode === 'mock' || this.authMode !== 'none' };
    if (this.mode === 'live' && warmToken && this.authMode === 'client_credentials') {
      try {
        await this.token();
        return { ...base, ready: true };
      } catch (err) {
        return { ...base, ready: false, error: err instanceof Error ? err.message : 'Shopify authentication failed.' };
      }
    }
    return base;
  }

  async listOrders(from: string, to: string): Promise<SourceRow[]> {
    if (this.config.mode === 'mock') return mockOrders(from, to);
    const locations = await this.locations();
    const params = new URLSearchParams({ status: 'any', limit: '250', processed_at_min: dayStartISO(from), processed_at_max: dayEndISO(to) });
    let url: string | null = `${this.base}/orders.json?${params.toString()}`;
    const out: SourceRow[] = [];
    for (let guard = 0; url && guard < 500; guard++) {
      const { json, link } = await this.get(url);
      for (const o of (json as { orders?: Record<string, unknown>[] }).orders ?? []) {
        const t = normalizeOrder(o, locations);
        if (t) out.push(t);
      }
      url = nextPageUrl(link);
    }
    return out;
  }

  private async locations(): Promise<Record<string, string>> {
    if (this.locationCache) return this.locationCache;
    try {
      const { json } = await this.get(`${this.base}/locations.json`);
      const list = ((json as { locations?: { id: unknown; name: string }[] }).locations ?? []);
      this.locationCache = Object.fromEntries(list.map((l) => [String(l.id), l.name]));
    } catch {
      this.locationCache = {};
    }
    return this.locationCache;
  }

  private async get(url: string): Promise<{ json: unknown; link: string }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': await this.token(), accept: 'application/json' } });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      if (!res.ok) throw new SourceError(`Shopify API ${res.status}: ${await res.text()}`, res.status);
      return { json: await res.json(), link: res.headers.get('link') ?? '' };
    }
  }

  private async token(): Promise<string> {
    if (this.config.accessToken) return this.config.accessToken;
    if (!this.config.clientId || !this.config.clientSecret) throw new SourceError('Missing Shopify credentials.', 401);
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) return this.accessToken;
    this.accessTokenPromise ??= this.fetchAccessToken().finally(() => {
      this.accessTokenPromise = null;
    });
    return this.accessTokenPromise;
  }

  private async fetchAccessToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret });
    const res = await fetch(`https://${this.config.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok) throw new SourceError(`Shopify token exchange ${res.status}: ${json.error_description ?? json.error ?? res.statusText}`, res.status);
    if (!json.access_token) throw new SourceError('Shopify token exchange returned no access_token.', 502);
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + (Number(json.expires_in) || 24 * 3600) * 1000;
    return this.accessToken;
  }
}

export function normalizeOrder(o: Record<string, unknown>, locations: Record<string, string> = {}): SourceRow | null {
  const fin = String(o.financial_status ?? '').toLowerCase();
  if (!['paid', 'partially_refunded', 'refunded'].includes(fin)) return null;
  const amount = round2(num(o.current_total_price ?? o.total_price));
  if (amount <= 0) return null;

  // web → online; a draft order is online too when its location is the Online
  // Store; pos / other draft → a device cluster. Location only as a fallback.
  const source = String(o.source_name ?? '').toLowerCase();
  const locName = o.location_id ? (locations[String(o.location_id)] ?? '') : '';
  const isOnline = source ? source === 'web' || (source === 'shopify_draft_order' && /online store/i.test(locName)) : !o.location_id;
  const terminal = isOnline ? 'Shopify Online' : locName || (source === 'shopify_draft_order' ? 'Shopify Draft' : 'Shopify POS');
  const gateways = o.payment_gateway_names;
  const gateway = String((Array.isArray(gateways) && gateways[0]) || o.gateway || o.source_name || '');
  const name = String(o.name ?? (o.order_number != null ? `#${o.order_number}` : ''));

  return {
    date: String(o.processed_at ?? o.created_at ?? new Date().toISOString()),
    type: 'Payment',
    amount,
    currency: String(o.currency ?? 'EUR'),
    terminal,
    card: gateway,
    ref: name,
    desc: `Shopify order ${name}`,
    source: 'shopify',
    orderNum: name,
    isManual: /manual|custom/i.test(gateway),
    isOnline,
  };
}

export function nextPageUrl(linkHeader: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m?.[1]) return m[1];
  }
  return null;
}

function mockOrders(from: string, to: string): SourceRow[] {
  const f = Date.parse(dayStartISO(from));
  const t = Date.parse(dayEndISO(to));
  if (Number.isNaN(f) || Number.isNaN(t) || t < f) return [];
  const span = Math.max(0, t - f);
  const online = [42.5, 19.9, 68.05, 27.0, 55.4];
  const out: SourceRow[] = online.map((amount, i) => ({
    date: new Date(f + Math.round((span * (i + 1)) / (online.length + 2))).toISOString(),
    type: 'Payment',
    amount,
    currency: 'EUR',
    terminal: 'Shopify Online',
    card: 'PayPal Express Checkout',
    ref: `#${3200 + i}`,
    desc: `Shopify order #${3200 + i}`,
    source: 'shopify',
    orderNum: `#${3200 + i}`,
    isManual: false,
    isOnline: true,
  }));
  out.push({
    date: new Date(f + Math.round(span / 2)).toISOString(),
    type: 'Payment',
    amount: 33.0,
    currency: 'EUR',
    terminal: 'Shopify POS — Booth',
    card: 'Shopify POS',
    ref: '#3299',
    desc: 'Shopify order #3299',
    source: 'shopify',
    orderNum: '#3299',
    isManual: false,
    isOnline: false,
  });
  return out;
}
