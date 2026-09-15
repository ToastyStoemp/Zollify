import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import type Database from 'better-sqlite3';

import { openDb } from './db';
import { authenticate, registerAuthRoutes, seedOwner, parseAllowedEvents, type JwtClaims } from './auth';
import { listForAccount, migrateEntitlements, seedDefaults } from './modules/entitlements';
import { loadModuleStore } from './modules/registry';
import { mountPublicModules, mountServerModules, type RequestIdentity, type ServerModule } from './modules/mount';
import { registerModuleRoutes } from './routes/modules';
import { registerRefreshCookie } from './refresh-cookie';
import { registerStatic } from './static';
import { registerSyncRoutes } from './routes/sync';
import { registerDeviceRoutes } from './routes/devices';
import { registerAccountRoutes } from './routes/account';
import { registerAdminRoutes } from './routes/admin';
import { registerLogRoutes } from './routes/logs';
import { registerUpdateRoutes } from './routes/updates';
import { Rooms, registerWs } from './ws';

export interface GatewayOptions {
  dataDir: string;
  jwtSecret: string;
  /** Directory holding published client module bundles. */
  moduleStoreDir: string;
  /**
   * Built web app to serve. Omitted in development, where Vite serves the app
   * and proxies the API here.
   */
  webDistDir?: string;
  /** Directory with the Android APKs + version.json for self-update; omit to serve none. */
  apkDir?: string;
  /** Server halves compiled into this deploy. */
  serverModules: ServerModule[];
  /** Modules a new account starts with. */
  defaultModules: string[];
  /** Exact origins allowed to call the API. Empty = same-origin only. */
  allowedOrigins: string[];
  /** Set false only for local HTTP development. */
  requireHttps: boolean;
  trustProxy: boolean;
  logLevel?: string;
}

/**
 * Derives the acting identity from the verified token — never from anything the
 * client sent in a body or query. Every module route receives the result of
 * this function, so a module cannot act for an account other than the caller's.
 */
function identityOf(db: Database.Database) {
  return (req: FastifyRequest): RequestIdentity => {
    const claims = req.user as JwtClaims | undefined;
    if (!claims) throw new Error('identityOf called on an unauthenticated request');

    const row = db
      .prepare('SELECT allowedEventIds FROM users WHERE id = ?')
      .get(claims.sub) as { allowedEventIds: string | null } | undefined;

    return {
      userId: claims.sub,
      accountId: claims.accountId,
      role: claims.role,
      allowedEventIds: parseAllowedEvents(row?.allowedEventIds),
    };
  };
}

export async function buildGateway(opts: GatewayOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'info',
      // Credentials and tokens must never reach the log, including when a
      // handler logs the whole request for debugging.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.totp',
          'req.body.recoveryCode',
          'req.body.apiKey',
        ],
        remove: true,
      },
    },
    trustProxy: opts.trustProxy,
    // Generous on purpose: a backup restore pushes hundreds of image
    // thumbnails and the ledger accepts invoice PDFs. Rate limiting and
    // authentication bound who can send this much, not the size itself.
    bodyLimit: 32 * 1024 * 1024,
  });

  const db = openDb(opts.dataDir);
  migrateEntitlements(db);
  await seedOwner(db);

  // An account seeded from OWNER_EMAIL never goes through /auth/register, so
  // nothing had switched on its starting modules and it opened to an empty
  // shell. Only accounts with no module rows at all are touched, so this can
  // never re-enable something an owner deliberately switched off.
  for (const row of db.prepare('SELECT id FROM accounts').all() as { id: string }[]) {
    if (listForAccount(db, row.id).length === 0) {
      seedDefaults(db, row.id, opts.defaultModules);
    }
  }

  // ── Transport & headers ───────────────────────────────────────────────────

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // blob: is required: runtime modules are executed as ES modules from a
        // blob URL. It is deliberately the only addition — no CDNs, no inline
        // script — so the only code that can run is code this server published
        // and the client hash-verified.
        scriptSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: opts.requireHttps
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  if (opts.requireHttps) {
    app.addHook('onRequest', async (req, reply) => {
      const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
      if (proto !== 'https') {
        return reply.code(403).send({ error: 'https_required', message: 'HTTPS is required.' });
      }
      return undefined;
    });
  }

  // The Android shell runs from http://localhost (Capacitor) and authenticates
  // with a bearer token in the body, never a cookie, so letting it in adds no
  // cookie-based cross-site surface.
  const NATIVE_ORIGINS = ['http://localhost', 'https://localhost', 'capacitor://localhost'];
  await app.register(cors, {
    // An empty allow-list means same-origin only, which is the deployed shape.
    origin: [...NATIVE_ORIGINS, ...opts.allowedOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Behind a proxy the real client is the forwarded address; otherwise every
    // request shares one bucket and the limiter protects nothing.
    keyGenerator: (req) => req.ip,
  });

  await app.register(jwt, { secret: opts.jwtSecret });
  // The cookie itself is signed by nothing: the refresh token is already a
  // 256-bit random value looked up by hash, so a signature would add ceremony
  // without adding security.
  await app.register(cookie);

  // ── Auth ──────────────────────────────────────────────────────────────────

  app.decorate('authenticate', authenticate);
  // Registered before the routes so its hooks see every auth request and
  // response, including ones added later.
  registerRefreshCookie(app, { secure: opts.requireHttps });
  registerAuthRoutes(app, db, opts.jwtSecret, opts.dataDir);

  // ── Sync, devices, admin ──────────────────────────────────────────────────
  // These declare their own absolute /api/... paths, so they register on the
  // root instance rather than inside the /api scope below.

  const rooms = new Rooms();
  registerSyncRoutes(app, db, rooms);
  registerDeviceRoutes(app, db);
  registerAccountRoutes(app, db);
  registerAdminRoutes(app, db);
  registerLogRoutes(app, db, opts.dataDir);
  if (opts.apkDir) registerUpdateRoutes(app, opts.apkDir);
  await registerWs(app, rooms, db);

  // ── Module plane ──────────────────────────────────────────────────────────

  const store = loadModuleStore(opts.moduleStoreDir);
  app.log.info({ modules: [...store.keys()] }, 'client module store loaded');

  const identity = identityOf(db);

  await app.register(
    async (api) => {
      api.addHook('onRequest', app.authenticate);
      registerModuleRoutes(api, db, store, identity, opts.moduleStoreDir);
      mountServerModules(api, db, opts.serverModules, identity);
    },
    { prefix: '/api' },
  );

  // Public halves: no session, resolved by the module from a slug or token.
  mountPublicModules(app, db, opts.serverModules);

  app.decorate('zollify', { db, store, seedDefaults: (accountId: string) => seedDefaults(db, accountId, opts.defaultModules) });

  /**
   * Liveness probe. Deliberately unauthenticated and free of detail: a load
   * balancer needs to know the process is up, and anyone else learns nothing
   * about the deployment from it.
   */
  app.get('/health', async () => ({ ok: true }));

  // Registered last so its not-found handler does not shadow API routes.
  if (opts.webDistDir) await registerStatic(app, { webDistDir: opts.webDistDir });

  return app;
}
