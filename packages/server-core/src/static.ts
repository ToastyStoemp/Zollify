import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the built web app.
 *
 * In development Vite serves the app and proxies `/api` here, so this does
 * nothing. In a deployment the gateway is the only thing listening and has to
 * serve the shell as well as the API - otherwise there is no way to reach the
 * app at all.
 */

export interface StaticOptions {
  /** Directory holding the built web app (`apps/web/dist`). */
  webDistDir: string;
}

export async function registerStatic(app: FastifyInstance, opts: StaticOptions): Promise<void> {
  if (!existsSync(join(opts.webDistDir, 'index.html'))) {
    app.log.warn(
      { webDistDir: opts.webDistDir },
      'no built web app found; serving the API only. Run `npm run build -w @zollify/web`.',
    );
    return;
  }

  const assetsDir = join(opts.webDistDir, 'assets');
  const hasAssets = existsSync(assetsDir);

  /**
   * Hashed build output, mounted separately so it can be cached hard.
   *
   * Vite gives every file here a content hash, so a given URL's bytes never
   * change and a year-long immutable cache is safe.
   *
   * Two mounts rather than one with custom header logic: @fastify/static writes
   * headers straight onto the raw response via `send`, so a Fastify onSend hook
   * cannot override them. Using the plugin's own options is the only way that
   * actually takes effect.
   */
  if (hasAssets) {
    await app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      maxAge: '365d',
      immutable: true,
      // The root mount below owns reply.sendFile, so the SPA fallback resolves
      // index.html from the dist root rather than from inside /assets.
      decorateReply: false,
    });
  }

  /**
   * Everything else: index.html and the unhashed host import-map entries.
   *
   * Deliberately not cached long. index.html must always be revalidated, or a
   * deploy leaves browsers pinned to the previous build, still requesting
   * chunks that no longer exist; and `/host/*.js` changes whenever the shell is
   * rebuilt. ETag and Last-Modified keep revalidation cheap.
   */
  await app.register(fastifyStatic, {
    root: opts.webDistDir,
    maxAge: 0,
    decorateReply: true,
  });

  /**
   * SPA fallback. The app uses hash routing, so deep links rarely reach the
   * server - but a stray path should still land on the app rather than a bare
   * 404. API routes are excluded: a mistyped API path must fail as an API
   * error, not silently return HTML the caller then tries to parse as JSON.
   */
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: 'No such endpoint.' });
    }
    return reply.sendFile('index.html');
  });
}
