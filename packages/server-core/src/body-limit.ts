import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { checkClaims, type JwtClaims } from './auth';

const ANONYMOUS_LIMIT = 256 * 1024;

async function hasValidCredential(app: FastifyInstance, req: FastifyRequest): Promise<boolean> {
  const apiToken = /^Bearer\s+(zt_[A-Za-z0-9]+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (apiToken) {
    const row = app.db.prepare('SELECT scopes FROM api_tokens WHERE tokenHash = ? AND revokedAt IS NULL')
      .get(createHash('sha256').update(apiToken).digest('hex')) as { scopes: string } | undefined;
    return !!row?.scopes.split(/[\s,]+/).some((scope) => scope === 'data:read' || scope === 'data:write');
  }
  if (!req.headers.authorization) return false;
  try {
    await req.jwtVerify();
    return checkClaims(app.db, req.user as JwtClaims, req.method, req.url) === null;
  } catch {
    return false;
  }
}

/** Bound bytes before parsing, including chunked requests and forged headers. */
export function registerAnonymousBodyLimit(app: FastifyInstance): void {
  app.addHook('preParsing', async (req, reply, payload) => {
    // WebSocket upgrades have no HTTP body stream.
    if (req.method === 'GET' || req.method === 'HEAD' || !payload) return payload;
    if (await hasValidCredential(app, req)) return payload;
    if (Number(req.headers['content-length'] ?? 0) > ANONYMOUS_LIMIT) {
      reply.code(413).send({ error: 'Request too large.' });
      return payload;
    }
    let bytes = 0;
    const limited = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > ANONYMOUS_LIMIT) {
          callback(Object.assign(new Error('Request too large.'), { statusCode: 413 }));
        } else {
          callback(null, chunk);
        }
      },
    });
    payload.on('error', (error) => limited.destroy(error));
    limited.on('close', () => {
      payload.unpipe(limited);
    });
    return payload.pipe(limited);
  });
}
