import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { isEnabled } from './entitlements';

export type Role = 'owner' | 'admin' | 'member';

export interface RequestIdentity {
  userId: string;
  accountId: string;
  role: Role;
  allowedEventIds: string[] | null;
}

/**
 * What a server module half receives. It is handed the account context rather
 * than being trusted to derive it — a module never reads the raw token, and
 * never chooses which account it is acting for.
 */
export interface ModuleContext {
  db: Database.Database;
  identity(req: FastifyRequest): RequestIdentity;
}

/**
 * What a module's public half receives. No identity: nobody is signed in. The
 * module resolves which account a request is for from its own data (a slug, a
 * token) and must check `isEnabled` before serving anything for it.
 */
export interface PublicModuleContext {
  db: Database.Database;
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
   * publish something to the open web — an events page, a calendar feed.
   * Responses here may be embedded cross-origin, so the gateway relaxes the
   * resource-isolation headers for this prefix only.
   */
  publicRoutes?: (ctx: PublicModuleContext) => FastifyPluginAsync;
}

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Mounts each server module under `/m/<id>` behind one gate.
 *
 * Enforcement lives here, once, rather than in each module: authentication,
 * the account's entitlement for this module, and the module's minimum role are
 * all checked before any module code runs. A module physically cannot forget
 * to check — which is the only way this stays true as modules are added.
 */
export function mountServerModules(
  app: FastifyInstance,
  db: Database.Database,
  modules: ServerModule[],
  identity: (req: FastifyRequest) => RequestIdentity,
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
            // switched it on. Distinguishing the two is safe — module ids are
            // public — and gives the client something actionable to show.
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

        await scope.register(mod.routes({ db, identity }));
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
export function mountPublicModules(app: FastifyInstance, db: Database.Database, modules: ServerModule[]): void {
  for (const mod of modules) {
    if (!mod.publicRoutes) continue;
    const ctx: PublicModuleContext = { db, isEnabled: (accountId) => isEnabled(db, accountId, mod.id) };
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
