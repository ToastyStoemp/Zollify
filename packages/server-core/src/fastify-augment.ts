import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PublishedModule } from './modules/registry';
import type { RequestIdentity } from './modules/mount';

/**
 * Decorators the gateway installs. Declared in one place so the ported route
 * files keep compiling unchanged - they were written against these and the
 * augmentation, not the routes, is what had to come across.
 */
declare module 'fastify' {
  interface FastifyInstance {
    authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void>;
    db: Database.Database;
    zollify: {
      db: Database.Database;
      store: Map<string, PublishedModule>;
      seedDefaults(accountId: string): void;
    };
  }

  interface FastifyRequest {
    identity?: RequestIdentity;
  }
}

export {};
