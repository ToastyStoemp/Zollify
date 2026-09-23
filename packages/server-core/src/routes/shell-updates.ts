import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Content-only self-update for the Android shell, via @capgo/capacitor-updater:
 * a version pointer and one zip of apps/web/dist, read from a directory
 * `npm run publish:shell` (scripts/publish-shell.mjs) fills. Nothing here is
 * committed to git - the zip is build output, not source.
 *
 * Unlike /api/updates/* (a full APK, gated to compat/full - see that file's
 * own docs), this is available to every flavour including carbon: the whole
 * point is a myPOS Carbon terminal picking up a UI/logic fix without going
 * through myPOS's own app channel at all. From the OS's (and myPOS's) point
 * of view the installed APK never changes - only content it already fetches
 * over plain HTTPS, same as any other API call this app makes.
 *
 * Public on purpose, like /api/health and /api/updates/*: a device that
 * cannot sign in still needs to be able to update its way out of that state.
 */
export function registerShellUpdateRoutes(app: FastifyInstance, shellStoreDir: string): void {
  app.get('/api/shell/latest', async (_req, reply) => {
    const latestPath = join(shellStoreDir, 'latest.json');
    if (!existsSync(latestPath)) return reply.code(404).send({ error: 'No shell bundle published' });
    const { version } = JSON.parse(readFileSync(latestPath, 'utf-8')) as { version: string };

    const manifestPath = join(shellStoreDir, version, 'manifest.json');
    if (!existsSync(manifestPath)) return reply.code(404).send({ error: 'Published version is missing its manifest' });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version: string; integrity: string; sizeBytes: number };

    return { ...manifest, url: `/api/shell/${manifest.version}/bundle.zip` };
  });

  app.get('/api/shell/:version/bundle.zip', async (req, reply) => {
    // Resolved against a literal, existence-checked subdirectory of a fixed
    // root - `version` never reaches the filesystem as anything but one path
    // segment name, so `../` components can't escape shellStoreDir.
    const { version } = req.params as { version: string };
    const zipPath = join(shellStoreDir, version, 'bundle.zip');
    if (!zipPath.startsWith(shellStoreDir) || !existsSync(zipPath)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('content-type', 'application/zip');
    reply.header('content-length', statSync(zipPath).size);
    // Immutable per version, same reasoning as the module-bundle route: a
    // version's bytes never change once published.
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    reply.header('content-disposition', `attachment; filename="zollify-shell-${version}.zip"`);
    return reply.send(createReadStream(zipPath));
  });
}
