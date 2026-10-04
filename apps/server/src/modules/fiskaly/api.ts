/**
 * fiskaly SIGN DE (cloud TSE), API v2 - the calls Zollify needs.
 *
 * The request and response shapes follow fiskaly's API reference
 * (workspace.fiskaly.com/api/sign-de) and a transaction response captured
 * from fiskaly's TEST environment (see the tests). What gets signed is sent
 * as `schema.raw` - Zollify's own DSFinV-K processData - so the signed bytes
 * are exactly what the receipt and the tax export show, and the signed
 * values are read back from fiskaly's own receipt QR string (qr_code_data).
 */

export const FISKALY_BASE = 'https://kassensichv-middleware.fiskaly.com/api/v2';

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

export class FiskalyError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface FiskalyAuth {
  token: string;
  /** ms */
  expiresAt: number;
  /** "TEST" or "LIVE" */
  env: string;
}

/** A finished transaction, as signed. */
export interface SignedTx {
  number: number;
  signatureCounter: number;
  /** ms */
  time: number;
  signature: string;
  info: { serial: string; publicKey: string; algorithm: string; timeFormat: string; certified: boolean };
  /** Exactly what was signed, from fiskaly's receipt QR string. */
  exact: { clientId: string; processType: string; processData: string; start: string; finish: string };
}

export class FiskalyApi {
  constructor(
    private readonly fetch: Fetch,
    private readonly base = FISKALY_BASE,
  ) {}

  private async call(method: string, path: string, token: string | null, body?: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const msg = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
        throw new FiskalyError(`fiskaly: ${msg}`, res.status);
      }
      return data;
    } catch (err) {
      if (err instanceof FiskalyError) throw err;
      throw new FiskalyError(ctrl.signal.aborted ? 'fiskaly did not answer in time.' : `fiskaly could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async auth(apiKey: string, apiSecret: string): Promise<FiskalyAuth> {
    const r = await this.call('POST', '/auth', null, { api_key: apiKey, api_secret: apiSecret });
    const claims = (r.access_token_claims ?? {}) as { env?: string };
    const expiresIn = Number(r.access_token_expires_in) || 300;
    return { token: String(r.access_token ?? ''), expiresAt: Date.now() + expiresIn * 1000, env: String(claims.env ?? 'TEST') };
  }

  /** Creates a TSS; its admin PUK is only ever shown here. */
  async createTss(token: string, tssId: string): Promise<{ adminPuk: string; state: string }> {
    const r = await this.call('PUT', `/tss/${tssId}`, token, { metadata: { created_by: 'Zollify' } });
    return { adminPuk: String(r.admin_puk ?? ''), state: String(r.state ?? '') };
  }

  async getTss(token: string, tssId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/tss/${tssId}`, token);
  }

  /** CREATED → UNINITIALIZED can take a while (fiskaly: allow at least 30 s); → INITIALIZED and → DISABLED (for good) need admin auth. */
  async setTssState(token: string, tssId: string, state: 'UNINITIALIZED' | 'INITIALIZED' | 'DISABLED'): Promise<void> {
    await this.call('PATCH', `/tss/${tssId}`, token, { state }, state === 'UNINITIALIZED' ? 60_000 : 15_000);
  }

  async setAdminPin(token: string, tssId: string, adminPuk: string, pin: string): Promise<void> {
    await this.call('PATCH', `/tss/${tssId}/admin`, token, { admin_puk: adminPuk, new_admin_pin: pin });
  }

  async adminLogin(token: string, tssId: string, pin: string): Promise<void> {
    await this.call('POST', `/tss/${tssId}/admin/auth`, token, { admin_pin: pin });
  }

  async adminLogout(token: string, tssId: string): Promise<void> {
    await this.call('POST', `/tss/${tssId}/admin/logout`, token, {});
  }

  /** The id fiskaly has for a till's serial number, if the till is registered with the TSS. */
  async findClient(token: string, tssId: string, serial: string): Promise<string | null> {
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const r = await this.call('GET', `/tss/${tssId}/client?limit=${limit}&offset=${offset}`, token);
      const data = Array.isArray(r.data) ? (r.data as { _id?: unknown; serial_number?: unknown }[]) : [];
      const hit = data.find((c) => c.serial_number === serial);
      if (hit) return String(hit._id);
      if (data.length < limit) return null;
    }
  }

  /** Registers a till (its serial number) with the TSS. Needs admin auth. */
  async createClient(token: string, tssId: string, clientId: string, serial: string): Promise<void> {
    await this.call('PUT', `/tss/${tssId}/client/${clientId}`, token, { serial_number: serial });
  }

  async startTx(token: string, tssId: string, txId: string, clientId: string): Promise<{ number: number; time: number }> {
    const r = await this.call('PUT', `/tss/${tssId}/tx/${txId}?tx_revision=1`, token, { state: 'ACTIVE', client_id: clientId });
    return { number: Number(r.number), time: Number(r.time_start) * 1000 };
  }

  async finishTx(token: string, tssId: string, txId: string, clientId: string, processType: string, processData: string, env: string): Promise<SignedTx> {
    const r = await this.call('PUT', `/tss/${tssId}/tx/${txId}?tx_revision=2`, token, {
      state: 'FINISHED',
      client_id: clientId,
      schema: { raw: { process_type: processType, process_data: Buffer.from(processData, 'utf8').toString('base64') } },
    });
    return parseFinished(r, env);
  }
}

/**
 * A FINISHED transaction: the signed values come from fiskaly's receipt QR
 * string, verbatim - "V0;client;processType;processData;tx;counter;start;
 * end;algorithm;timeFormat;signature;publicKey" - so the receipt carries
 * exactly what fiskaly signed.
 */
export function parseFinished(r: Record<string, unknown>, env: string): SignedTx {
  const sig = (r.signature ?? {}) as { value?: string; counter?: number; algorithm?: string; public_key?: string };
  const log = (r.log ?? {}) as { timestamp?: number; timestamp_format?: string };
  const qr = typeof r.qr_code_data === 'string' ? r.qr_code_data.split(';') : [];
  if (qr.length < 12 || !sig.value) throw new FiskalyError('fiskaly returned no signature.');
  return {
    number: Number(qr[4] ?? r.number),
    signatureCounter: Number(qr[5] ?? sig.counter),
    time: Number(log.timestamp ?? r.time_end) * 1000,
    signature: qr[10] || sig.value,
    info: {
      serial: String(r.tss_serial_number ?? ''),
      publicKey: qr[11] || String(sig.public_key ?? ''),
      algorithm: qr[8] || String(sig.algorithm ?? ''),
      timeFormat: qr[9] || String(log.timestamp_format ?? 'unixTime'),
      certified: env === 'LIVE',
    },
    exact: { clientId: qr[1]!, processType: qr[2]!, processData: qr[3]!, start: qr[6]!, finish: qr[7]! },
  };
}
