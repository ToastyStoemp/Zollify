import type { FastifyInstance } from 'fastify';

/**
 * Moves the refresh token off the response body and into an httpOnly cookie.
 *
 * The ported `auth.ts` issues and rotates refresh tokens in the body, which is
 * ZollTool's original design. Rewriting that logic would mean re-deriving
 * single-use rotation, per-flavor TTLs and device carry-forward - all of which
 * already work. So this adapts the *transport* instead and leaves the proven
 * code alone:
 *
 *   - on the way out, a `refreshToken` in an auth response is set as a cookie
 *     and removed from the JSON body;
 *   - on the way in, a request with no `refreshToken` in its body gets the
 *     cookie's value injected before the route validates it.
 *
 * Why it matters here more than usual: runtime-loaded modules execute in this
 * origin. An XSS bug should at worst borrow a 15-minute access token, never
 * exfiltrate a 90-day refresh token - and JavaScript cannot read an httpOnly
 * cookie at all.
 */

export const REFRESH_COOKIE = 'zfy_rt';

/**
 * Scoped to the auth routes so the cookie is not attached to every API call.
 * A cookie sent on requests that never need it is just a wider blast radius.
 */
const COOKIE_PATH = '/api/auth';

/**
 * The cookie outlives the shortest server-side TTL on purpose. The
 * `refresh_tokens` row is the authority on validity - a cookie that survives
 * its row simply yields a 401, which is the correct outcome and avoids
 * duplicating the per-flavor TTL logic out here.
 */
const COOKIE_MAX_AGE_SEC = 90 * 24 * 3600;

/** Native shells keep the token in platform secure storage, not a cookie. */
const NATIVE_CLIENT_HEADER = 'x-zollify-client';

function wantsBodyToken(req: { headers: Record<string, unknown> }): boolean {
  return String(req.headers[NATIVE_CLIENT_HEADER] ?? '').toLowerCase() === 'native';
}

interface AuthPayload {
  refreshToken?: string;
  [key: string]: unknown;
}

function isAuthPath(url: string): boolean {
  return url.startsWith('/api/auth/');
}

export interface RefreshCookieOptions {
  /** Mirrors the gateway's HTTPS requirement; Secure is meaningless over plain HTTP. */
  secure: boolean;
}

export function registerRefreshCookie(app: FastifyInstance, opts: RefreshCookieOptions): void {
  /**
   * Inbound: let a cookie stand in for the body field the ported route expects.
   * A body token still wins, so a native client is unaffected.
   */
  app.addHook('preValidation', async (req) => {
    if (!isAuthPath(req.url)) return;

    const cookie = req.cookies?.[REFRESH_COOKIE];
    if (!cookie) return;

    const body = (req.body ?? {}) as AuthPayload;
    if (typeof body.refreshToken === 'string' && body.refreshToken.length > 0) return;

    req.body = { ...body, refreshToken: cookie };
  });

  /**
   * Outbound: bank the token in a cookie and take it out of the body.
   *
   * Runs on the serialised payload rather than in each route, so a new auth
   * route cannot forget to do it - the same reasoning as gating modules
   * centrally rather than per-module.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    if (!isAuthPath(req.url) || typeof payload !== 'string') return payload;

    const contentType = String(reply.getHeader('content-type') ?? '');
    if (!contentType.includes('application/json')) return payload;

    let parsed: AuthPayload;
    try {
      parsed = JSON.parse(payload) as AuthPayload;
    } catch {
      return payload;
    }
    if (typeof parsed !== 'object' || parsed === null) return payload;

    // Logging out clears the cookie so a stale value can't linger on the device.
    if (req.url.startsWith('/api/auth/logout')) {
      reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return payload;
    }

    const token = parsed.refreshToken;
    if (typeof token !== 'string' || token.length === 0) return payload;

    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: opts.secure,
      // Strict is safe because every refresh is a same-site call from our own
      // app; there is no cross-site flow that needs to carry this.
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: COOKIE_MAX_AGE_SEC,
    });

    if (wantsBodyToken(req)) return payload;

    delete parsed.refreshToken;
    const next = JSON.stringify(parsed);
    // Content-Length must follow the shortened body or the response truncates.
    reply.header('content-length', Buffer.byteLength(next));
    return next;
  });
}
