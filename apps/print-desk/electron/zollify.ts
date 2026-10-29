import { randomUUID } from 'node:crypto';
import { catalogRows, demandForecast, lastClosedEventSold, type DemandForecast, type EventSold, type PulledOp } from './reduce.js';
import type { CatalogRow, Session } from './shared.js';
import { stockKey } from './shared.js';
import type { Material, MaterialUse } from './materials.js';

/** Zollify's answer to a login or refresh: a native client gets the refresh token in the body. */
interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: { email: string; accountId: string };
}

export interface LoginInput {
  server: string;
  email: string;
  password: string;
  /** Authenticator code, when the account has 2FA. */
  code?: string;
}

export interface LinkStart {
  id: string;
  pollSecret: string;
  /** What the QR shows: the shell's #/link URL with the current code. */
  qr: string;
}
export interface LinkPoll {
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** A rotated code's new QR value, while pending. */
  qr?: string;
  session?: Session;
}

export class ZollifyError extends Error {
  constructor(
    message: string,
    readonly needs2fa = false,
    /** The HTTP status Zollify answered with, when it answered. */
    readonly status = 0,
  ) {
    super(message);
  }
}

/**
 * A Zollify client for one machine: signs in like the Android shell (refresh
 * token in the body, access token 15 minutes), reads the catalogue from the
 * sync log and pushes inventory counts back as `inventory.set` ops.
 */
export class Zollify {
  private access = '';
  session: Session | null = null;

  constructor(
    public server: string,
    public refreshToken: string,
    readonly deviceId: string,
    /** Called whenever the refresh token rotates, so it can be stored. */
    readonly onRefresh: (token: string) => void,
  ) {}

  private url(path: string): string {
    return `${this.server.replace(/\/+$/, '')}${path}`;
  }

  private async auth(path: string, body: Record<string, unknown>): Promise<TokenResponse> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zollify-client': 'native' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string; needs2fa?: boolean };
    if (!res.ok || !json.accessToken || !json.refreshToken || !json.user) throw new ZollifyError(json.error ?? `Sign-in failed (${res.status})`, !!json.needs2fa);
    this.access = json.accessToken;
    this.refreshToken = json.refreshToken;
    this.onRefresh(json.refreshToken);
    this.session = { accountId: json.user.accountId, email: json.user.email };
    return json as TokenResponse;
  }

  async login(input: LoginInput): Promise<Session> {
    this.server = input.server;
    await this.auth('/api/auth/login', { email: input.email, password: input.password, code: input.code || undefined, deviceId: this.deviceId, deviceName: 'Print Desk', flavor: 'full' });
    return this.session as Session;
  }

  /** Resumes with the stored refresh token; null when there is none or it no longer works. */
  async resume(): Promise<Session | null> {
    if (!this.server || !this.refreshToken) return null;
    try {
      await this.auth('/api/auth/refresh', { refreshToken: this.refreshToken });
      return this.session;
    } catch {
      return null;
    }
  }

  /** Sign in by QR, step one: a request this device polls, and the code the QR shows (as the web shell encodes it). */
  async linkStart(server: string): Promise<LinkStart> {
    this.server = server;
    const res = await fetch(this.url('/api/auth/link/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zollify-client': 'native' },
      body: JSON.stringify({ deviceId: this.deviceId, deviceName: 'Print Desk', flavor: 'full' }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; pollSecret?: string; code?: string; error?: string };
    if (!res.ok || !json.id || !json.pollSecret || !json.code) throw new ZollifyError(json.error ?? 'Could not start sign-in by QR.');
    return { id: json.id, pollSecret: json.pollSecret, qr: this.qrUrl(json.code) };
  }

  /** Sign in by QR, step two: what the other device decided; the session once it approved. */
  async linkPoll(id: string, pollSecret: string): Promise<LinkPoll> {
    const res = await fetch(this.url('/api/auth/link/poll'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zollify-client': 'native' },
      body: JSON.stringify({ id, pollSecret }),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { status?: string; code?: string };
    if (res.ok && json.status === 'approved' && json.accessToken && json.refreshToken && json.user) {
      this.access = json.accessToken;
      this.refreshToken = json.refreshToken;
      this.onRefresh(json.refreshToken);
      this.session = { accountId: json.user.accountId, email: json.user.email };
      return { status: 'approved', session: this.session };
    }
    if (res.ok && json.status === 'pending') return { status: 'pending', ...(json.code ? { qr: this.qrUrl(json.code) } : {}) };
    // The server is busy or down: not the code's fault, keep waiting.
    if (res.status >= 500 || res.status === 429) return { status: 'pending' };
    return { status: json.status === 'denied' ? 'denied' : 'expired' };
  }

  private qrUrl(code: string): string {
    return `${this.server.replace(/\/+$/, '')}/#/link?c=${encodeURIComponent(code)}`;
  }

  async logout(): Promise<void> {
    if (this.refreshToken) {
      await fetch(this.url('/api/auth/logout'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zollify-client': 'native' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      }).catch(() => {});
    }
    this.access = '';
    this.refreshToken = '';
    this.session = null;
    this.onRefresh('');
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const res = await fetch(this.url(path), { ...init, headers: { authorization: `Bearer ${this.access}`, 'content-type': 'application/json' } });
    if (res.status === 401 && retry) {
      await this.auth('/api/auth/refresh', { refreshToken: this.refreshToken });
      return this.request<T>(path, init, false);
    }
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new ZollifyError((json as { message?: string }).message ?? json.error ?? `${path} failed (${res.status})`, false, res.status);
    return json;
  }

  /** The whole op log, reduced to one row per sellable item with its counted stock. */
  async catalog(): Promise<CatalogRow[]> {
    return catalogRows(await this.pullAll());
  }

  /** What each item is expected to sell, for planning a print run (`today` as YYYY-MM-DD). */
  async forecast(today: string): Promise<DemandForecast> {
    return demandForecast(await this.pullAll(), today);
  }

  /** What the last closed event sold, per item; null when no event is closed. */
  async lastEventSold(): Promise<EventSold | null> {
    return lastClosedEventSold(await this.pullAll());
  }

  /** The op log pulled so far, for `account`, up to server sequence `seq`: each pull fetches only what is new. */
  private log: { account: string; seq: number; ops: PulledOp[] } = { account: '', seq: 0, ops: [] };
  private pulling: Promise<PulledOp[]> = Promise.resolve([]);

  /** Every op this user may read, in order. One pull at a time, so two never append the same ops. */
  private pullAll(): Promise<PulledOp[]> {
    this.pulling = this.pulling.catch(() => []).then(() => this.pullNew());
    return this.pulling;
  }
  private async pullNew(): Promise<PulledOp[]> {
    const account = this.session?.accountId ?? '';
    if (this.log.account !== account) this.log = { account, seq: 0, ops: [] };
    let since = this.log.seq;
    for (;;) {
      const page = await this.request<{ ops: { serverSeq: number; type: string; payload: unknown }[]; latestSeq: number }>(`/api/sync/pull?since=${since}&limit=1000`);
      this.log.ops.push(...page.ops);
      const last = page.ops.at(-1)?.serverSeq ?? since;
      this.log.seq = last;
      if (!page.ops.length || last >= page.latestSeq) break;
      since = last;
    }
    return this.log.ops;
  }

  /**
   * Adds printed copies to the stock as Zollify has it now (pulled just before), not as this app
   * last saw it: a count made elsewhere in the meantime is kept. Returns each item's new count.
   */
  async addOnHand(items: { productId: string; variantId: string; add: number }[]): Promise<{ key: string; onHand: number }[]> {
    const now = new Map(catalogRows(await this.pullAll()).map((r) => [r.key, r.onHand]));
    const next = items.map((i) => ({ ...i, key: stockKey(i.productId, i.variantId), onHand: (now.get(stockKey(i.productId, i.variantId)) ?? 0) + i.add }));
    await this.setOnHand(next);
    return next.map(({ key, onHand }) => ({ key, onHand }));
  }

  /** The account's materials with what is on hand, through the sign-in (Sourcing's printing calls). */
  async printingMaterials(): Promise<Material[]> {
    return (await this.request<{ materials: Material[] }>('/api/m/sourcing/printing/materials')).materials;
  }

  /** Logs a material used, through the sign-in; a resent id counts once, as with the printer key. */
  async printingUse(use: MaterialUse): Promise<{ material: Material; duplicate: boolean }> {
    return this.request('/api/m/sourcing/printing/usage', { method: 'POST', body: JSON.stringify(use) });
  }

  /** Counts stock: each item's new on-hand figure, as the web app's stock count does. */
  async setOnHand(items: { productId: string; variantId: string; onHand: number }[]): Promise<void> {
    if (!items.length) return;
    const now = Date.now();
    const ops = items.map((i) => ({
      opId: randomUUID(),
      deviceId: this.deviceId,
      ts: now,
      type: 'inventory.set',
      payload: { productId: i.productId, variantId: i.variantId, onHand: Math.max(0, Math.floor(i.onHand)), updatedAt: now },
    }));
    const res = await this.request<{ accepted: number; refused?: string[] }>('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: this.deviceId, deviceName: 'Print Desk', flavor: 'full', ops }),
    });
    if (res.refused?.length) throw new ZollifyError('Zollify refused the stock update: this user may not change inventory.');
  }
}
