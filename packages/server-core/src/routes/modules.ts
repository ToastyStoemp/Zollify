import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { listForAccount, setEnabled } from '../modules/entitlements';
import { toDescriptor, type PublishedModule } from '../modules/registry';
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
): void {
  /**
   * The boot manifest: descriptors for every module this account has enabled
   * and this user's role may load. Filtering by role here means a helper's
   * device is never even told a bundle exists — the client's role check is
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

    setEnabled(db, who.accountId, parsed.data.moduleId, parsed.data.enabled);
    return { ok: true, moduleId: parsed.data.moduleId, enabled: parsed.data.enabled };
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
