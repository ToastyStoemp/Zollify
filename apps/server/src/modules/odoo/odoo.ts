/**
 * Odoo's JSON-RPC API (`/jsonrpc`), the way Odoo 15 to 18 all speak it: one
 * `authenticate` to turn a login and API key into a uid, then `execute_kw`
 * calls against models. The API key is an Odoo "developer" key from the
 * person's preferences; it stands in for the password and never changes the
 * person's own sessions.
 */

/** No upstream call may hang a request forever; the tax clients use the same cap. */
const FETCH_TIMEOUT_MS = 20_000;

export class OdooError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OdooError';
  }
}

export interface OdooConnection {
  url: string;
  db: string;
  login: string;
  apiKey: string;
}

export type Domain = (string | [string, string, unknown])[];

export class OdooClient {
  private uid: number | null = null;
  private seq = 0;

  constructor(private readonly conn: OdooConnection) {}

  /** The server this talks to, for caches keyed per Odoo. */
  get host(): string {
    return this.conn.url;
  }

  private async rpc<T>(service: 'common' | 'object', method: string, args: unknown[]): Promise<T> {
    const res = await fetch(`${this.conn.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: ++this.seq, params: { service, method, args } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new OdooError(`Odoo HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { result?: T; error?: { message?: string; data?: { message?: string; name?: string } } };
    if (body.error) {
      // Odoo's own message names the model and the rule that refused; the outer one is just "Odoo Server Error".
      throw new OdooError(body.error.data?.message?.split('\n')[0] || body.error.message || 'Odoo refused the call');
    }
    return body.result as T;
  }

  /** The uid for this login, fetched once. False from Odoo means wrong login, key or database. */
  async authenticate(): Promise<number> {
    if (this.uid) return this.uid;
    const uid = await this.rpc<number | false>('common', 'authenticate', [this.conn.db, this.conn.login, this.conn.apiKey, {}]);
    if (!uid) throw new OdooError('Odoo did not accept the login, API key or database name.', 401);
    this.uid = uid;
    return uid;
  }

  /** Server version, for a connection test. */
  version(): Promise<{ server_version?: string }> {
    return this.rpc('common', 'version', []);
  }

  async call<T>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const uid = await this.authenticate();
    return this.rpc<T>('object', 'execute_kw', [this.conn.db, uid, this.conn.apiKey, model, method, args, kwargs]);
  }

  searchRead<T>(model: string, domain: Domain, fields: string[], kwargs: Record<string, unknown> = {}): Promise<T[]> {
    return this.call<T[]>(model, 'search_read', [domain], { fields, ...kwargs });
  }

  create(model: string, values: Record<string, unknown>, kwargs: Record<string, unknown> = {}): Promise<number> {
    return this.call<number | number[]>(model, 'create', [values], kwargs).then((r) => (Array.isArray(r) ? r[0]! : r));
  }

  write(model: string, ids: number[], values: Record<string, unknown>, kwargs: Record<string, unknown> = {}): Promise<boolean> {
    return this.call<boolean>(model, 'write', [ids, values], kwargs);
  }
}

// ── Odoo records as this module reads them ───────────────────────────────────

/** A many2one as Odoo returns it: [id, display name], or false when unset. */
export type Many2one = [number, string] | false;
export const m2oId = (v: Many2one): number | null => (v ? v[0] : null);
export const m2oName = (v: Many2one): string => (v ? v[1] : '');

export interface OdooProduct {
  id: number;
  name: string;
  display_name: string;
  default_code: string | false;
  barcode: string | false;
  lst_price: number;
  product_tmpl_id: Many2one;
  qty_available: number;
  active: boolean;
}
