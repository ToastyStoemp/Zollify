import { computed, ref, shallowRef } from 'vue';
import { getStoredRefreshToken, isNative, storeRefreshToken } from './native';
import type { AccountSnapshot, HttpError, Role } from '@zollify/sdk';
import { emptyProfile, type ProfileUpdate, type TokenResponse } from '@zollify/shared';

/**
 * Session and token handling.
 *
 * The access token is held in memory only and never written to localStorage.
 * The refresh token never reaches JavaScript at all — the server sets it as an
 * httpOnly, Secure, SameSite cookie. That combination means an XSS bug can at
 * worst borrow the current tab's short-lived access token; it cannot exfiltrate
 * a 90-day refresh token. With runtime-loaded modules executing in this origin,
 * that distinction is the difference between a bad day and a breach.
 */

/**
 * The server's auth response. The refresh token is absent on web — the gateway
 * strips it and sets an httpOnly cookie instead — so only `accessToken` and
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
 * Adopts a fresh user record from the server — after the profile is edited,
 * for instance — without touching the tokens.
 */
export function applyUser(user: TokenResponse['user']): void {
  setAccount(toSnapshot(user));
}

/**
 * Reads the expiry out of the access token itself.
 *
 * The server does not report a lifetime separately, and hard-coding one here
 * would silently drift the moment ACCESS_TTL changes. The `exp` claim is not
 * trusted for authorisation — only to decide when to refresh — so decoding
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

const accessToken = shallowRef<string | null>(null);
const expiresAt = ref(0);
const account = shallowRef<AccountSnapshot | null>(null);
const accountListeners = new Set<(a: AccountSnapshot | null) => void>();

/** Refresh this long before actual expiry, so an in-flight request never races it. */
const REFRESH_SKEW_MS = 30_000;

export const currentAccount = computed(() => account.value);
export const isAuthenticated = computed(() => account.value !== null);

/** The live bearer token, for the one place (the realtime socket) that cannot use authFetch. */
export function getAccessToken(): string | null {
  return accessToken.value;
}

export function getAccount(): AccountSnapshot | null {
  return account.value;
}

export function onAccountChange(handler: (a: AccountSnapshot | null) => void): () => void {
  accountListeners.add(handler);
  return () => accountListeners.delete(handler);
}

function setAccount(next: AccountSnapshot | null): void {
  account.value = next;
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
  setAccount(null);
}

/**
 * Ends the session on this device. The server revokes the refresh token and
 * clears its cookie; the local state is dropped regardless, so signing out
 * always works even with no connection — the token then dies of expiry.
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
 * callers share one request — otherwise a page that fires six requests on load
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
        // a proxy with nothing behind it — signing the booth out for that would
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
  if (!tokenIsFresh() && account.value !== null) await refreshAccessToken();

  const send = async (): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    headers.set('accept', 'application/json');
    for (const [k, v] of Object.entries(nativeHeaders())) headers.set(k, v);
    if (accessToken.value) headers.set('authorization', `Bearer ${accessToken.value}`);
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${apiBase}${path}`, { ...init, headers, credentials: 'same-origin' });
  };

  let res = await send();

  // One retry after a refresh: covers a token that expired between the freshness
  // check and the request actually landing.
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await send();
  }

  const body = await parseBody(res);
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `Request failed with ${res.status}`;
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
