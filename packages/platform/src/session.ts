import { computed, ref, shallowRef } from 'vue';
import { getStoredRefreshToken, isNative, storeRefreshToken } from './native';
import type { AccountSnapshot, HttpError, Role } from '@zollify/sdk';
import { emptyProfile, type ProfileUpdate, type TokenResponse } from '@zollify/shared';

/**
 * Session and token handling.
 *
 * The access token is held in memory only and never written to localStorage.
 * The refresh token never reaches JavaScript at all - the server sets it as an
 * httpOnly, Secure, SameSite cookie. That combination means an XSS bug can at
 * worst borrow the current tab's short-lived access token; it cannot exfiltrate
 * a 90-day refresh token. With runtime-loaded modules executing in this origin,
 * that distinction is the difference between a bad day and a breach.
 */

/**
 * The server's auth response. The refresh token is absent on web - the gateway
 * strips it and sets an httpOnly cookie instead - so only `accessToken` and
 * `user` are relied on here.
 */
export type LoginResult = Omit<TokenResponse, 'refreshToken'> & { refreshToken?: string };

/** Maps the server's AuthUser onto the snapshot modules see through the SDK. */
function toSnapshot(user: TokenResponse['user']): AccountSnapshot {
  return {
    accountId: user.accountId,
    accountName: user.accountName,
    userId: user.id,
    email: user.email,
    role: user.role as Role,
    allowedEventIds: user.allowedEventIds ?? null,
    profile: user.profile ?? emptyProfile(),
  };
}

/**
 * Adopts a fresh user record from the server - after the profile is edited,
 * for instance - without touching the tokens.
 */
export function applyUser(user: TokenResponse['user']): void {
  const next = toSnapshot(user);
  const person = people.get(next.userId);
  if (person) people.set(next.userId, { ...person, snapshot: next });
  // The profile and name are the account's: everyone on the device sees the change.
  if (account.value && account.value.userId !== next.userId) {
    setAccount({ ...account.value, accountName: next.accountName, profile: next.profile });
  } else setAccount(next);
  if (account.value?.userId === next.userId) remember(account.value);
}

/**
 * Reads the expiry out of the access token itself.
 *
 * The server does not report a lifetime separately, and hard-coding one here
 * would silently drift the moment ACCESS_TTL changes. The `exp` claim is not
 * trusted for authorisation - only to decide when to refresh - so decoding
 * without verifying is fine.
 */
function expiryFromJwt(token: string): number {
  try {
    const [, payload] = token.split('.');
    if (!payload) return 0;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// The device session: whoever signed this device in. It owns the refresh
// cookie, the realtime socket and the right to unlock others on this device.
const accessToken = shallowRef<string | null>(null);
const expiresAt = ref(0);
const account = shallowRef<AccountSnapshot | null>(null);
const accountListeners = new Set<(a: AccountSnapshot | null) => void>();

/**
 * People unlocked on a shared till (see till-lock.ts), by user id. Each holds
 * a short-lived token of their own, renewed with the device's grant for them;
 * none of them has a refresh token.
 */
export interface PersonSession {
  snapshot: AccountSnapshot;
  /** Null when unlocked offline: the person is known, but requests go as the device. */
  token: string | null;
  expiresAt: number;
  grant: string;
}
const people = new Map<string, PersonSession>();
/** Who is using the device: one of `people`, or null for the device session's own user. */
const activeUserId = shallowRef<string | null>(null);

/** Refresh this long before actual expiry, so an in-flight request never races it. */
const REFRESH_SKEW_MS = 30_000;

const active = (): PersonSession | null => (activeUserId.value ? (people.get(activeUserId.value) ?? null) : null);

/** The person using the app: an unlocked colleague on a shared till, otherwise the device session's user. */
export const currentAccount = computed(() => {
  void activeUserId.value;
  return account.value ? (active()?.snapshot ?? account.value) : null;
});
export const isAuthenticated = computed(() => account.value !== null);
/** Signed in from what this device remembers, the server not reached yet: data is local, syncing waits. */
export const signedInOffline = computed(() => account.value !== null && accessToken.value === null);

// ── Starting without the server ─────────────────────────────────────────────
//
// A booth restarts the app at a venue with no signal. The data is on the
// device (per account, see core/db.ts) and the refresh token is too, but the
// server is needed to turn it into a session - so the app used to open on the
// login screen and nothing could be sold until the signal came back.
//
// Now the device remembers who signed it in: the account snapshot only (ids,
// role, profile), never a token. Starting without the server resumes as that
// person; the first request that reaches the server renews the session or,
// if the server refuses it (removed, signed out elsewhere), ends it then. A
// refusal or a sign-out forgets the snapshot at once.
const REMEMBER_KEY = 'zollify.device-account';
/** Longest a remembered sign-in is used without the server - the web refresh token's default life. */
const REMEMBER_MS = 30 * 24 * 3600 * 1000;

function remember(snapshot: AccountSnapshot | null): void {
  try {
    if (snapshot) localStorage.setItem(REMEMBER_KEY, JSON.stringify({ snapshot, at: Date.now() }));
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* no storage: the app simply needs the server to start, as before */
  }
}

/**
 * Starts as the person who last signed this device in, when the server could
 * not be reached. False when nobody is remembered, or it was too long ago.
 */
export function resumeOffline(now = Date.now()): boolean {
  if (account.value) return false;
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return false;
    const { snapshot, at } = JSON.parse(raw) as { snapshot?: AccountSnapshot; at?: number };
    if (!snapshot?.accountId || !snapshot.userId || typeof at !== 'number' || now - at > REMEMBER_MS) return false;
    setAccount(snapshot);
    return true;
  } catch {
    return false;
  }
}

/** The live bearer token, for the one place (the realtime socket) that cannot use authFetch. */
export function getAccessToken(): string | null {
  return accessToken.value;
}

export function getAccount(): AccountSnapshot | null {
  return account.value ? (active()?.snapshot ?? account.value) : null;
}

/** Whoever signed the device in, whoever is using it now. */
export function getDeviceAccount(): AccountSnapshot | null {
  return account.value;
}

// ── People on a shared till ─────────────────────────────────────────────────

/** Makes an unlocked person the one using the app; null hands it back to the device session's user. */
export function setActivePerson(session: PersonSession | null): void {
  if (session) people.set(session.snapshot.userId, session);
  activeUserId.value = session?.snapshot.userId ?? null;
  notifyAccount();
}

/** A person's session, still held for syncing what they did, even when someone else is using the till. */
export function personSession(userId: string): PersonSession | null {
  return people.get(userId) ?? null;
}

/** The unlocked colleague using the device, or null when it is the device session's own user. */
export function activePersonId(): string | null {
  return activeUserId.value;
}

export function dropPerson(userId: string): void {
  people.delete(userId);
  if (activeUserId.value === userId) {
    activeUserId.value = null;
    notifyAccount();
  }
}

/** Builds a person's session from the server's unlock answer. */
export function personFrom(result: { accessToken: string; user: TokenResponse['user'] }, grant: string): PersonSession {
  return { snapshot: toSnapshot(result.user), token: result.accessToken, expiresAt: expiryFromJwt(result.accessToken) || Date.now() + 60_000, grant };
}

/** Called when a person's token cannot be renewed (they were removed, or their unlock ran out). */
let onPersonLost: (userId: string, wasActive: boolean) => void = () => {};
export function onPersonSessionLost(handler: (userId: string, wasActive: boolean) => void): void {
  onPersonLost = handler;
}

export function onAccountChange(handler: (a: AccountSnapshot | null) => void): () => void {
  accountListeners.add(handler);
  return () => accountListeners.delete(handler);
}

function setAccount(next: AccountSnapshot | null): void {
  account.value = next;
  notifyAccount();
}

function notifyAccount(): void {
  const next = getAccount();
  for (const listener of [...accountListeners]) {
    try {
      listener(next);
    } catch (err) {
      console.error('[zollify] account listener threw', err);
    }
  }
}

export function applyLogin(result: LoginResult): void {
  accessToken.value = result.accessToken;
  if (result.refreshToken) storeRefreshToken(result.refreshToken);
  // Fall back to a conservative minute if the token carries no usable exp, so a
  // malformed claim means "refresh soon" rather than "never refresh".
  expiresAt.value = expiryFromJwt(result.accessToken) || Date.now() + 60_000;
  setAccount(toSnapshot(result.user));
  remember(account.value);
}

export function clearSession(): void {
  accessToken.value = null;
  expiresAt.value = 0;
  people.clear();
  activeUserId.value = null;
  setAccount(null);
  remember(null);
}

/**
 * Ends the session on this device. The server revokes the refresh token and
 * clears its cookie; the local state is dropped regardless, so signing out
 * always works even with no connection - the token then dies of expiry.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${apiBase}/auth/logout`, { method: 'POST', credentials: 'same-origin', ...nativeAuthInit() });
  } catch {
    // Offline: the cookie stays until it expires, which is the honest outcome.
  }
  storeRefreshToken(null);
  clearSession();
}

// ── API base ────────────────────────────────────────────────────────────────

let apiBase = '/api';

/**
 * In the Android shell the refresh token travels in the body instead of a
 * cookie: the header tells the server so, and the stored token rides along.
 */
export function nativeHeaders(): Record<string, string> {
  return isNative() ? { 'x-zollify-client': 'native' } : {};
}
function nativeAuthInit(): RequestInit {
  if (!isNative()) return {};
  const refreshToken = getStoredRefreshToken();
  return {
    headers: { ...nativeHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(refreshToken ? { refreshToken } : {}),
  };
}

export function configureApiBase(base: string): void {
  apiBase = base.replace(/\/+$/, '');
}

export function getApiBase(): string {
  return apiBase;
}

// ── Refresh ─────────────────────────────────────────────────────────────────

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchanges the httpOnly refresh cookie for a new access token. Concurrent
 * callers share one request - otherwise a page that fires six requests on load
 * would rotate the refresh token six times and invalidate its own session.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const native = nativeAuthInit();
      // Every request waits on this one: it must not wait forever on a stalled connection.
      const answer = await withTimeout(REFRESH_TIMEOUT_MS, null, async (signal) => {
        const res = await fetch(`${apiBase}/auth/refresh`, {
          method: 'POST',
          credentials: 'same-origin',
          ...native,
          signal,
          headers: { accept: 'application/json', ...(native.headers as Record<string, string> | undefined) },
        });
        return { res, body: res.ok ? ((await res.json()) as LoginResult) : null };
      });
      const { res } = answer;
      if (!res.ok) {
        // Only a refusal ends the session. A 5xx is the gateway restarting or
        // a proxy with nothing behind it - signing the booth out for that would
        // drop the till mid-shift over a hiccup that fixes itself.
        if (res.status === 401 || res.status === 403 || res.status === 400) clearSession();
        return false;
      }
      const body = answer.body!;
      applyLogin(body);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function tokenIsFresh(): boolean {
  return accessToken.value !== null && Date.now() < expiresAt.value - REFRESH_SKEW_MS;
}

// ── Authenticated fetch ─────────────────────────────────────────────────────

/**
 * How long a request may take - answer and body - before it counts as failed.
 *
 * On mobile data a connection can stall without ever erroring: a cell
 * handover, a carrier dropping a connection it thinks is idle. The request
 * then waited forever, and since sync shares one run and every request
 * shares one token refresh, a single stalled request stopped all syncing
 * until the app was restarted - fine on Wi-Fi, "often fails" on data.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 20_000;

/** Options for a request to the server: `timeoutMs` overrides the default limit (0: none). */
export type ServerRequest = RequestInit & { timeoutMs?: number };

/** Thrown when the server did not answer in time; `timeout` tells it apart from a refusal. */
export interface TimeoutError extends Error {
  timeout: true;
}

function timeoutError(ms: number): TimeoutError {
  const err = new Error(`The server did not answer within ${Math.round(ms / 1000)} s - the connection may be weak.`) as TimeoutError;
  err.timeout = true;
  return err;
}

/**
 * Runs `run` with a signal that aborts after `ms`, or when the caller's own
 * signal does. Past the limit the call fails with a TimeoutError whatever
 * `run` is still waiting on - the abort tells fetch to let go, and the race
 * makes sure nothing waits on it anyway.
 */
async function withTimeout<T>(ms: number, outer: AbortSignal | null | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    if (ms > 0) {
      timer = setTimeout(() => {
        ctl.abort();
        reject(timeoutError(ms));
      }, ms);
    }
  });
  const work = run(ctl.signal);
  // Once the limit has answered, a late failure of the abandoned request is nobody's business.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

function httpError(status: number, body: unknown, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  err.body = body;
  return err;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return res.json();
  return res.text();
}

/**
 * Same-origin authenticated request. `credentials: 'same-origin'` keeps the
 * refresh cookie from ever being attached to a cross-origin request, and the
 * caller cannot override it.
 */
export async function authFetch(path: string, init: ServerRequest = {}): Promise<unknown> {
  return authFetchAs(activeUserId.value, path, init);
}

/**
 * As the device session's own user, whoever is using the app - for what only
 * the device may do: unlocking people, renewing their tokens.
 */
export function deviceFetch(path: string, init: ServerRequest = {}): Promise<unknown> {
  return authFetchAs(null, path, init);
}

/**
 * Renews an unlocked person's token with the device's grant for them. False
 * when it cannot be: their unlock ran out, or they were taken off the device.
 */
async function renewPerson(userId: string): Promise<boolean> {
  const p = people.get(userId);
  if (!p) return false;
  if (!p.token) return true; // unlocked offline: nothing to renew
  try {
    const { deviceId } = await import('./core/device');
    const res = (await deviceFetch('/auth/unlock/renew', { method: 'POST', body: JSON.stringify({ deviceId: await deviceId(), userId, grant: p.grant }) })) as {
      accessToken: string;
      user: TokenResponse['user'];
    };
    people.set(userId, personFrom(res, p.grant));
    if (activeUserId.value === userId) notifyAccount();
    return true;
  } catch (err) {
    const status = (err as HttpError).status;
    // 403: their unlock ran out; 404: they were taken off the device.
    if (status === 403 || status === 404) {
      const wasActive = activeUserId.value === userId;
      people.delete(userId);
      onPersonLost(userId, wasActive);
    }
    return false;
  }
}

/** A request as one person on the device - null for the device session's user. */
export async function authFetchAs(userId: string | null, path: string, options: ServerRequest = {}): Promise<unknown> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...init } = options;
  const person = (): PersonSession | null => (userId ? (people.get(userId) ?? null) : null);
  if (userId && !person()) throw httpError(401, null, 'Locked - enter the PIN again.');
  // Unlocked offline: requests go as the device, which never outranks them (see till-lock.ts).
  if (userId && !person()!.token) return authFetchAs(null, path, options);
  if (userId) {
    if (Date.now() >= person()!.expiresAt - REFRESH_SKEW_MS) await renewPerson(userId);
  } else if (!tokenIsFresh() && account.value !== null) await refreshAccessToken();

  const send = async (signal: AbortSignal): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    headers.set('accept', 'application/json');
    for (const [k, v] of Object.entries(nativeHeaders())) headers.set(k, v);
    const token = userId ? person()?.token : accessToken.value;
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${apiBase}${path}`, { ...init, headers, credentials: 'same-origin', signal });
  };

  if (userId && !person()) throw httpError(401, null, 'Locked - enter the PIN again.');
  // The limit covers the answer and its body; a retry after a refresh gets a limit of its own.
  const exchange = (): Promise<{ res: Response; body: unknown }> =>
    withTimeout(timeoutMs, init.signal, async (signal) => {
      const res = await send(signal);
      return { res, body: res.status === 401 ? null : await parseBody(res) };
    });
  let { res, body } = await exchange();

  // One retry after a refresh: covers a token that expired between the freshness
  // check and the request actually landing.
  if (res.status === 401 && (userId ? await renewPerson(userId) : await refreshAccessToken())) {
    ({ res, body } = await exchange());
  }
  if (res.status === 401 && body === null) body = await parseBody(res).catch(() => null);

  if (!res.ok) {
    const said = typeof body === 'object' && body !== null ? (body as { message?: unknown; error?: unknown }) : {};
    const message =
      typeof said.message === 'string' ? said.message : typeof said.error === 'string' ? said.error : `Request failed with ${res.status}`;
    throw httpError(res.status, body, message);
  }
  return body;
}

/** Saves account-wide profile changes and adopts the server's view of the account. */
export async function updateProfile(update: ProfileUpdate): Promise<void> {
  const res = (await authFetch('/account/profile', {
    method: 'PUT',
    body: JSON.stringify(update),
  })) as { user: TokenResponse['user'] };
  applyUser(res.user);
}
