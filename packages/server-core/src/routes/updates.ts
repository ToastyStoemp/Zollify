import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Self-update for the Android app: a version manifest and one APK per
 * flavour, read from a directory the deploy fills (`apps/server/apk`,
 * written by `npm run android:pack` or `scripts/fetch-apks.mjs`). Nothing
 * here is committed to git — APKs are build output, not source.
 *
 * Public on purpose, like /api/health: an APK carries no account data, and a
 * device that cannot sign in (an expired session on an old build, say) still
 * needs to be able to update itself out of that state.
 *
 * The carbon flavour is deliberately never served: a myPOS Carbon terminal
 * takes its apps through myPOS's own channel.
 */
const FLAVORS = new Set(['compat', 'full']);

export function registerUpdateRoutes(app: FastifyInstance, apkDir: string): void {
  app.get('/api/updates/latest', async (_req, reply) => {
    const versionPath = join(apkDir, 'version.json');
    if (!existsSync(versionPath)) return reply.code(404).send({ error: 'No update published' });
    return JSON.parse(readFileSync(versionPath, 'utf-8')) as { versionCode: number; versionName: string };
  });

  app.get('/api/updates/download/:flavor', async (req, reply) => {
    const { flavor } = req.params as { flavor: string };
    if (!FLAVORS.has(flavor)) return reply.code(400).send({ error: 'Unknown flavor' });
    const apkPath = join(apkDir, `zollify-${flavor}.apk`);
    if (!existsSync(apkPath)) return reply.code(404).send({ error: 'Not built for this flavor' });
    reply.header('content-type', 'application/vnd.android.package-archive');
    reply.header('content-length', statSync(apkPath).size);
    reply.header('content-disposition', `attachment; filename="zollify-${flavor}.apk"`);
    return reply.send(createReadStream(apkPath));
  });
}
