import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { listForAccount, setEnabled } from '../modules/entitlements';
import { loadModuleStore, toDescriptor, type PublishedModule } from '../modules/registry';
import type { RequestIdentity } from '../modules/mount';

const RANK = { member: 0, admin: 1, owner: 2 } as const;

const ToggleBody = z.object({
  moduleId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
  enabled: z.boolean(),
});

/**
 * The module plane's own API: what this account may load, and switching modules
 * on and off. Mounted behind the gateway's authentication hook.
 */
export function registerModuleRoutes(
  app: FastifyInstance,
  db: Database.Database,
  store: Map<string, PublishedModule>,
  identity: (req: FastifyRequest) => RequestIdentity,
  storeDir?: string,
): void {
  /**
   * Re-scans the module store.
   *
   * The catalogue is read once at boot, so publishing a module used to require
   * restarting the gateway - which in turn drops every open connection. The map
   * is mutated in place rather than replaced, because the routes below close
   * over this exact reference.
   */
  if (storeDir) {
    app.post('/modules/reload', async (req, reply) => {
      const who = identity(req);
      if (RANK[who.role] < RANK.owner) {
        return reply.code(403).send({ error: 'forbidden', message: 'Only an owner can reload the module store.' });
      }

      const fresh = loadModuleStore(storeDir);
      store.clear();
      for (const [id, mod] of fresh) store.set(id, mod);

      app.log.info({ modules: [...store.keys()] }, 'module store reloaded');
      return { modules: [...store.keys()].sort() };
    });
  }

  /**
   * The boot manifest: descriptors for every module this account has enabled
   * and this user's role may load. Filtering by role here means a helper's
   * device is never even told a bundle exists - the client's role check is
   * then a second line, not the only one.
   */
  app.get('/modules/manifest', async (req) => {
    const who = identity(req);
    const enabled = listForAccount(db, who.accountId).filter((m) => m.enabled);

    const descriptors = enabled
      .map((m) => store.get(m.moduleId))
      .filter((m): m is PublishedModule => m !== undefined)
      .filter((m) => !m.minRole || RANK[who.role] >= RANK[m.minRole])
      .map(toDescriptor);

    return { sdk: '0.1.0', modules: descriptors };
  });

  /** The catalogue, with each entry's enabled state for this account. */
  app.get('/modules/available', async (req) => {
    const who = identity(req);
    const state = new Map(listForAccount(db, who.accountId).map((m) => [m.moduleId, m.enabled]));

    return {
      modules: [...store.values()]
        .filter((m) => !m.minRole || RANK[who.role] >= RANK[m.minRole])
        .map((m) => ({ ...toDescriptor(m), enabled: state.get(m.moduleId) ?? false })),
    };
  });

  app.post('/modules/toggle', async (req, reply) => {
    const who = identity(req);
    // Only an owner or admin changes what the account runs; a helper switching
    // modules on would be privilege escalation by the back door.
    if (RANK[who.role] < RANK.admin) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins can change modules.' });
    }

    const parsed = ToggleBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'moduleId and enabled are required.' });
    }
    if (!store.has(parsed.data.moduleId)) {
      return reply.code(404).send({ error: 'unknown_module', message: 'No such module is published.' });
    }

    const { moduleId, enabled } = parsed.data;
    const visible = (m: PublishedModule): boolean => !m.minRole || RANK[who.role] >= RANK[m.minRole];
    // Switching a module on also switches on the published modules it
    // requires (e.g. a customs country module brings the Customs hub along);
    // switching one off also switches off whatever requires it, so nothing
    // is left enabled that the client loader would only skip.
    const affected = enabled ? requiredBy(store, moduleId) : dependentsOf(store, moduleId);
    const changed = [moduleId, ...[...affected].filter((id) => visible(store.get(id)!))];

    const tx = db.transaction(() => {
      for (const id of changed) setEnabled(db, who.accountId, id, enabled);
    });
    tx();
    return { ok: true, moduleId, enabled, changed };
  });

  /**
   * Serves a bundle. The path is resolved from the in-memory store rather than
   * from the URL, so no amount of traversal in the request can reach a file the
   * registry didn't publish.
   */
  app.get<{ Params: { moduleId: string; version: string } }>(
    '/modules/:moduleId/:version/bundle.js',
    async (req, reply) => {
      const who = identity(req);
      const published = store.get(req.params.moduleId);

      if (!published || published.version !== req.params.version) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (published.minRole && RANK[who.role] < RANK[published.minRole]) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      return reply
        .header('content-type', 'text/javascript; charset=utf-8')
        // Immutable per version: the client caches by <id>@<version> and a
        // version's bytes never change, so this can be cached hard.
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(createReadStream(published.filePath));
    },
  );
}

/** Every published module `moduleId` transitively requires (core capabilities like `catalog` aren't in the store and drop out). */
export function requiredBy(store: Map<string, PublishedModule>, moduleId: string): Set<string> {
  const found = new Set<string>();
  const visit = (id: string): void => {
    for (const dep of store.get(id)?.requires ?? []) {
      if (dep === moduleId || found.has(dep) || !store.has(dep)) continue;
      found.add(dep);
      visit(dep);
    }
  };
  visit(moduleId);
  return found;
}

/** Every published module that transitively requires `moduleId`. */
export function dependentsOf(store: Map<string, PublishedModule>, moduleId: string): Set<string> {
  const found = new Set<string>();
  const visit = (id: string): void => {
    for (const m of store.values()) {
      if (m.moduleId === moduleId || found.has(m.moduleId) || !(m.requires ?? []).includes(id)) continue;
      found.add(m.moduleId);
      visit(m.moduleId);
    }
  };
  visit(moduleId);
  return found;
}
