import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import type Database from 'better-sqlite3';

import { openDb } from './db';
import { authenticate, registerAuthRoutes, seedOwner, parseAllowedEvents, type JwtClaims } from './auth';
import { isEnabled, listForAccount, migrateEntitlements, seedDefaults } from './modules/entitlements';
import { loadModuleStore } from './modules/registry';
import { moduleServices, mountPublicModules, mountServerModules, type ModuleServices, type RequestIdentity, type ServerModule } from './modules/mount';
import { registerModuleRoutes } from './routes/modules';
import { registerRefreshCookie } from './refresh-cookie';
import { registerDeviceLinkRoutes } from './device-link';
import { registerDeviceUserRoutes } from './device-users';
import { registerStatic } from './static';
import { appendOps, registerSyncRoutes } from './routes/sync';
import { registerDeviceRoutes } from './routes/devices';
import { registerAccountRoutes } from './routes/account';
import { registerAdminRoutes } from './routes/admin';
import { registerLogRoutes } from './routes/logs';
import { registerEventFileRoutes } from './routes/event-files';
import { registerUpdateRoutes } from './routes/updates';
import { registerShellUpdateRoutes } from './routes/shell-updates';
import { registerFxRoutes } from './routes/fx';
import { Rooms, registerWs } from './ws';
import { configureCaptchaKey } from './captcha';
import { createMailer, isPlainEmail, type Mailer } from './mailer';
import { createNotifier, registerNotificationRoutes, type Notify } from './notifications';
import { createWebhooks, migrateWebhooks, registerWebhookRoutes } from './webhooks';
import { checkDeployStatus } from './deploy-status';
import { createProblems, migrateProblems, registerProblemRoutes, type Problems } from './problems';

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
  /** Directory the host watches for a deploy request (Settings → Server admin → Update server). */
  deployDir?: string;
  /** Directory with the Android APKs + version.json for self-update; omit to serve none. */
  apkDir?: string;
  /** Directory with published shell content bundles (npm run publish:shell); omit to serve none. */
  shellStoreDir?: string;
  /** Server halves compiled into this deploy. */
  serverModules: ServerModule[];
  /** Modules a new account starts with. */
  defaultModules: string[];
  /** Exact origins allowed to call the API. Empty = same-origin only. */
  allowedOrigins: string[];
  /** Set false only for local HTTP development. */
  requireHttps: boolean;
  /** true trusts one proxy hop in front (the usual reverse proxy); a number trusts that many. */
  trustProxy: boolean | number;
  logLevel?: string;
  /** Outgoing email. Defaults to SMTP_URL + MAIL_FROM from the environment; disabled without them. */
  mailer?: Mailer;
}

/**
 * Derives the acting identity from the verified token - never from anything the
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
      // The live-sync socket carries its token in the query string.
      serializers: {
        req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: req.url.replace(/([?&](?:token|grant)=)[^&]*/g, '$1[redacted]'), remoteAddress: req.ip }),
      },
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
          'req.body.pollSecret',
        ],
        remove: true,
      },
    },
    // Trusting every X-Forwarded-For hop would let anyone pick their own IP and step around the rate limits.
    trustProxy: opts.trustProxy === false ? false : ((hops: number) => (_addr: string, hop: number) => hop < hops)(opts.trustProxy === true ? 1 : opts.trustProxy),
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
        // blob URL. The sha256 hash below allow-lists exactly one inline
        // script: index.html's `<script type="importmap">` (static, checked
        // into the repo, never user-influenced). No CDNs, no other inline
        // script - only code this server published and the client
        // hash-verified. Update this hash if that importmap's content changes.
        scriptSrc: ["'self'", 'blob:', "'sha256-p+LKqyd2jOipf8Tv+O1oSGQDPZXNY2HB85qyMMtjsjE='"],
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
      // The health probe comes from the container runtime and the deploy
      // script over plain loopback HTTP; it carries nothing worth protecting.
      if (req.url === '/health') return undefined;
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

  app.decorate('db', db);
  // Large bodies are for signed-in work (backups, invoice PDFs); without a token
  // nothing big is read, so nobody can make the server parse 32 MB for free.
  app.addHook('onRequest', async (req, reply) => {
    const size = Number(req.headers['content-length'] ?? 0);
    if (size > 256 * 1024 && !req.headers.authorization) return reply.code(413).send({ error: 'Request too large.' });
  });
  app.decorate('authenticate', authenticate);
  // Registered before the routes so its hooks see every auth request and
  // response, including ones added later.
  registerRefreshCookie(app, { secure: opts.requireHttps });
  configureCaptchaKey(opts.jwtSecret);
  registerAuthRoutes(app, db, opts.jwtSecret, opts.dataDir, {
    // Modules set up accounts their invites created (a store's artist gets "My stores").
    accountCreated: (e) => {
      for (const m of opts.serverModules) {
        try {
          m.onAccountCreated?.(services(m), e);
        } catch (err) {
          app.log.error({ err, moduleId: m.id }, 'onAccountCreated failed');
        }
      }
    },
  });
  registerDeviceLinkRoutes(app, db);
  registerDeviceUserRoutes(app, db, opts.jwtSecret);

  // ── Sync, devices, admin ──────────────────────────────────────────────────
  // These declare their own absolute /api/... paths, so they register on the
  // root instance rather than inside the /api scope below.

  const rooms = new Rooms();
  const ring = createNotifier(db, rooms);
  const rawMail = opts.mailer ?? createMailer({}, (err) => app.log.warn({ err }, 'email not sent'));
  // Every mail that names its account tells Problems how it went: one failure opens a warning, a success closes it.
  // A malformed recipient is the caller's mistake, not the mail server's, so it never counts.
  const mail: Mailer = {
    get enabled() {
      return rawMail.enabled;
    },
    async send(m) {
      const ok = await rawMail.send(m);
      if (m.accountId && rawMail.enabled && isPlainEmail(m.to)) {
        if (ok) problems.resolve(m.accountId, 'email', 'smtp');
        else problems.report(m.accountId, { kind: 'email', key: 'smtp', severity: 'error', message: 'Email could not be sent', detail: 'The mail server did not accept a message. Check SMTP_URL and MAIL_FROM.' });
      }
      return ok;
    },
  };
  migrateProblems(db);
  const problems: Problems = createProblems(db, { notify: (accountId, n) => notify(accountId, n), mail: () => mail, log: (err) => app.log.warn({ err }, 'problem not recorded') });
  app.addHook('onClose', async () => problems.stop());
  if (opts.deployDir) {
    // The host's deploy script writes how the last update and its backup went; the owner hears of a failure.
    const deployDir = opts.deployDir;
    const look = () => checkDeployStatus(db, deployDir, problems);
    const first = setTimeout(look, 5000);
    const timer = setInterval(look, 10 * 60_000);
    first.unref();
    timer.unref();
    app.addHook('onClose', async () => {
      clearTimeout(first);
      clearInterval(timer);
    });
  }
  // Webhooks hear every notification by its category, and modules add to the summaries.
  migrateWebhooks(db);
  const webhooks = createWebhooks(db, {
    notify: ring,
    contributors: () =>
      opts.serverModules
        .filter((m) => m.webhookReport)
        .map((m) => (accountId: string, period: { from: string; to: string; timeZone: string }) =>
          isEnabled(db, accountId, m.id) ? m.webhookReport!(services(m), accountId, period) : []),
    problems,
    log: (err) => app.log.warn({ err }, 'webhook failed'),
  });
  app.addHook('onClose', async () => webhooks.stop());
  const notify: Notify = (accountId, n) => {
    ring(accountId, n);
    webhooks.notification(accountId, n);
  };
  // One set of services per module, built once: notifications carry its id, server writes its name.
  const servicesByModule = new Map<string, ModuleServices>();
  const services = (mod: ServerModule): ModuleServices => {
    let s = servicesByModule.get(mod.id);
    if (!s) servicesByModule.set(mod.id, (s = moduleServices(mod, db, { notify, mail, webhooks, problems, writeOps: (accountId, origin, ops) => appendOps(db, rooms, accountId, origin, ops) })));
    return s;
  };
  registerSyncRoutes(app, db, rooms, (accountId, ops) => {
    webhooks.onOps(accountId, ops);
    for (const mod of opts.serverModules) {
      if (mod.onOps && isEnabled(db, accountId, mod.id)) mod.onOps(services(mod), accountId, ops);
    }
  }, problems);
  registerDeviceRoutes(app, db);
  registerAccountRoutes(app, db, opts.dataDir);
  registerNotificationRoutes(app, db);
  registerWebhookRoutes(app, db, webhooks, problems);
  registerProblemRoutes(app, db, problems);
  registerFxRoutes(app);
  registerAdminRoutes(app, db, opts.deployDir, opts.dataDir);
  registerLogRoutes(app, db, opts.dataDir);
  registerEventFileRoutes(app, db, opts.dataDir);
  if (opts.apkDir) registerUpdateRoutes(app, opts.apkDir);
  if (opts.shellStoreDir) registerShellUpdateRoutes(app, opts.shellStoreDir);
  await registerWs(app, rooms, db);

  // ── Module plane ──────────────────────────────────────────────────────────

  const store = loadModuleStore(opts.moduleStoreDir);
  app.log.info({ modules: [...store.keys()] }, 'client module store loaded');

  const identity = identityOf(db);

  await app.register(
    async (api) => {
      api.addHook('onRequest', app.authenticate);
      registerModuleRoutes(api, db, store, identity, opts.moduleStoreDir);
      mountServerModules(api, db, opts.serverModules, identity, services);
    },
    { prefix: '/api' },
  );

  // Public halves: no session, resolved by the module from a slug or token.
  mountPublicModules(app, db, opts.serverModules, services);

  app.decorate('zollify', { db, store, webhooks, problems, seedDefaults: (accountId: string) => seedDefaults(db, accountId, opts.defaultModules) });

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
