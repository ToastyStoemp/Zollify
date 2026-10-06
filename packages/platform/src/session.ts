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
}

export function clearSession(): void {
  accessToken.value = null;
  expiresAt.value = 0;
  people.clear();
  activeUserId.value = null;
  setAccount(null);
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
      const res = await fetch(`${apiBase}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        ...native,
        headers: { accept: 'application/json', ...(native.headers as Record<string, string> | undefined) },
      });
      if (!res.ok) {
        // Only a refusal ends the session. A 5xx is the gateway restarting or
        // a proxy with nothing behind it - signing the booth out for that would
        // drop the till mid-shift over a hiccup that fixes itself.
        if (res.status === 401 || res.status === 403 || res.status === 400) clearSession();
        return false;
      }
      const body = (await res.json()) as LoginResult;
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
export async function authFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  return authFetchAs(activeUserId.value, path, init);
}

/**
 * As the device session's own user, whoever is using the app - for what only
 * the device may do: unlocking people, renewing their tokens.
 */
export function deviceFetch(path: string, init: RequestInit = {}): Promise<unknown> {
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
export async function authFetchAs(userId: string | null, path: string, init: RequestInit = {}): Promise<unknown> {
  const person = (): PersonSession | null => (userId ? (people.get(userId) ?? null) : null);
  if (userId && !person()) throw httpError(401, null, 'Locked - enter the PIN again.');
  // Unlocked offline: requests go as the device, which never outranks them (see till-lock.ts).
  if (userId && !person()!.token) return authFetchAs(null, path, init);
  if (userId) {
    if (Date.now() >= person()!.expiresAt - REFRESH_SKEW_MS) await renewPerson(userId);
  } else if (!tokenIsFresh() && account.value !== null) await refreshAccessToken();

  const send = async (): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    headers.set('accept', 'application/json');
    for (const [k, v] of Object.entries(nativeHeaders())) headers.set(k, v);
    const token = userId ? person()?.token : accessToken.value;
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${apiBase}${path}`, { ...init, headers, credentials: 'same-origin' });
  };

  if (userId && !person()) throw httpError(401, null, 'Locked - enter the PIN again.');
  let res = await send();

  // One retry after a refresh: covers a token that expired between the freshness
  // check and the request actually landing.
  if (res.status === 401 && (userId ? await renewPerson(userId) : await refreshAccessToken())) {
    res = await send();
  }

  const body = await parseBody(res);
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
