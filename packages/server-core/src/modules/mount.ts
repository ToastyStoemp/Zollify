import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { isEnabled } from './entitlements';
import type { Mailer } from '../mailer';
import type { Notify } from '../notifications';
import type { ServerOpInput } from '../routes/sync';
import type { WebhookMessage, WireOp } from '@zollify/shared';
import type { Webhooks } from '../webhooks';
import type { ModuleProblems, ProblemInput } from '../problems';

export type Role = 'owner' | 'admin' | 'member';

export interface RequestIdentity {
  userId: string;
  accountId: string;
  role: Role;
  allowedEventIds: string[] | null;
}

/**
 * What a server module half receives. It is handed the account context rather
 * than being trusted to derive it - a module never reads the raw token, and
 * never chooses which account it is acting for.
 */
/** What every part of a server module gets, signed in or not. */
export interface ModuleServices {
  db: Database.Database;
  /** Raises an in-app notification for an account (shown under the bell). */
  notify: Notify;
  /** Outgoing email; `mail.enabled` is false on a server without SMTP. */
  mail: Mailer;
  /**
   * Writes changes into an account's synced data, as the server, and rings
   * its devices. For acting on someone's behalf across accounts - an artist
   * restocking their shelf in a store, say. Returns how many were written.
   */
  writeOps(accountId: string, ops: ServerOpInput[]): number;
  /** Posts to the account's webhooks that listen for the event (Discord, Slack, JSON). */
  webhooks: Pick<Webhooks, 'emit'>;
  /**
   * Tells the account's owners and admins something failed (`report`), and that it works again
   * (`resolve`): same kind and key is one problem. Never throws; absent in a bare test harness,
   * so call it through `reportProblem` / `resolveProblem`.
   */
  problems?: ModuleProblems;
}

export interface ModuleContext extends ModuleServices {
  identity(req: FastifyRequest): RequestIdentity;
}

/**
 * What a module's public half receives. No identity: nobody is signed in. The
 * module resolves which account a request is for from its own data (a slug, a
 * token) and must check `isEnabled` before serving anything for it.
 */
export interface PublicModuleContext extends ModuleServices {
  isEnabled(accountId: string): boolean;
}

export interface ServerModule {
  id: string;
  /** Minimum role for every route in this module. Per-route checks may narrow further. */
  minRole?: Role;
  /** Called once at boot to create tables this module owns. */
  migrate?(db: Database.Database): void;
  routes: (ctx: ModuleContext) => FastifyPluginAsync;
  /**
   * Unauthenticated routes, mounted under `/p/<id>`. For the few modules that
   * publish something to the open web - an events page, a calendar feed.
   * Responses here may be embedded cross-origin, so the gateway relaxes the
   * resource-isolation headers for this prefix only.
   */
  publicRoutes?: (ctx: PublicModuleContext) => FastifyPluginAsync;
  /**
   * Called after an account's devices pushed ops, for accounts with the
   * module switched on - so a module can follow changes as they happen
   * (an artist editing a product a store shares, say). Must not throw.
   */
  onOps?(ctx: ModuleServices, accountId: string, ops: WireOp[]): void;
  /** Lines the module adds to an account's daily and weekly webhook summaries. */
  webhookReport?(ctx: ModuleServices, accountId: string, period: { from: string; to: string; timeZone: string }): WebhookMessage['fields'];
  /**
   * A new account was just created with an invite code. Called for every
   * module, enabled or not, so a module that issued the invite (a store
   * inviting an artist) can set the account up. Must not throw.
   */
  onAccountCreated?(ctx: ModuleServices, e: { accountId: string; userId: string; inviteCode: string }): void;
}

/** Builds the per-module services: notifications carry the module's id, server writes its name. */
export function moduleServices(
  mod: Pick<ServerModule, 'id'>,
  db: Database.Database,
  base: { notify: Notify; mail: Mailer; webhooks: Pick<Webhooks, 'emit'>; problems?: ModuleProblems; writeOps(accountId: string, origin: string, ops: ServerOpInput[]): number },
): ModuleServices {
  return {
    db,
    notify: (accountId, n) => base.notify(accountId, { ...n, moduleId: mod.id }),
    mail: base.mail,
    webhooks: base.webhooks,
    ...(base.problems ? { problems: base.problems } : {}),
    writeOps: (accountId, ops) => base.writeOps(accountId, mod.id, ops),
  };
}

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Mounts each server module under `/m/<id>` behind one gate.
 *
 * Enforcement lives here, once, rather than in each module: authentication,
 * the account's entitlement for this module, and the module's minimum role are
 * all checked before any module code runs. A module physically cannot forget
 * to check - which is the only way this stays true as modules are added.
 */
export function mountServerModules(
  app: FastifyInstance,
  db: Database.Database,
  modules: ServerModule[],
  identity: (req: FastifyRequest) => RequestIdentity,
  services: (mod: ServerModule) => ModuleServices,
): void {
  for (const mod of modules) {
    try {
      mod.migrate?.(db);
    } catch (err) {
      app.log.error({ err, moduleId: mod.id }, 'module migration failed; module not mounted');
      continue;
    }

    void app.register(
      async (scope) => {
        scope.addHook('preHandler', async (req, reply) => {
          const who = identity(req);

          if (!isEnabled(db, who.accountId, mod.id)) {
            // 402 rather than 404: the module exists, this account has not
            // switched it on. Distinguishing the two is safe - module ids are
            // public - and gives the client something actionable to show.
            return reply.code(402).send({
              error: 'module_not_enabled',
              moduleId: mod.id,
              message: `The "${mod.id}" module is not enabled for this account.`,
            });
          }

          if (mod.minRole && RANK[who.role] < RANK[mod.minRole]) {
            return reply.code(403).send({ error: 'forbidden', message: 'Insufficient role.' });
          }

          return undefined;
        });

        await scope.register(mod.routes({ ...services(mod), identity }));
      },
      { prefix: `/m/${mod.id}` },
    );
  }
}

/**
 * Mounts each module's public half under `/p/<id>`, outside authentication.
 *
 * Isolation headers are loosened here, once: a Shopify page must be able to
 * load `/p/public-events/<slug>/embed.js` and fetch its JSON, which the
 * app-wide `same-origin` resource policy and closed CORS would refuse. Nothing
 * under `/p/` carries a session, so the wider exposure costs nothing.
 */
export function mountPublicModules(
  app: FastifyInstance,
  db: Database.Database,
  modules: ServerModule[],
  services: (mod: ServerModule) => ModuleServices,
): void {
  for (const mod of modules) {
    if (!mod.publicRoutes) continue;
    const ctx: PublicModuleContext = { ...services(mod), isEnabled: (accountId) => isEnabled(db, accountId, mod.id) };
    void app.register(
      async (scope) => {
        scope.addHook('onSend', async (_req, reply) => {
          reply.header('cross-origin-resource-policy', 'cross-origin');
          reply.header('access-control-allow-origin', '*');
        });
        await scope.register(mod.publicRoutes!(ctx));
      },
      { prefix: `/p/${mod.id}` },
    );
  }
}

/** Reports a failure for an account, if the context has the problems service. Never throws. */
export function reportProblem(svc: Pick<ModuleServices, 'problems'>, accountId: string, input: ProblemInput): void {
  try {
    svc.problems?.report(accountId, input);
  } catch {
    /* reporting a problem must never be one */
  }
}

/** The source works again: closes its problem. Never throws. */
export function resolveProblem(svc: Pick<ModuleServices, 'problems'>, accountId: string, kind: string, key?: string): void {
  try {
    svc.problems?.resolve(accountId, kind, key);
  } catch {
    /* as above */
  }
}
