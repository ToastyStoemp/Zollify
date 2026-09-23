#!/usr/bin/env node
/**
 * Builds apps/web and publishes it as a downloadable content bundle for
 * @capgo/capacitor-updater - the Android shell fetches this at runtime and
 * swaps its own WebView content, so a routine UI/logic change no longer
 * needs a new APK. A native change (new plugin, permission, manifest edit)
 * still does; this only ever replaces JS/HTML/CSS.
 *
 * Layout written is exactly what packages/server-core/src/routes/shell-updates.ts reads:
 *
 *   <store>/latest.json                     - { version }, the one mutable pointer
 *   <store>/<version>/bundle.zip
 *   <store>/<version>/manifest.json         - { version, integrity, sizeBytes }
 *
 * Versions are written to their own directory and never overwritten - same
 * rollback story as publish-modules.mjs: pointing latest.json at an older
 * directory that is still there.
 */
import archiver from 'archiver';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'apps', 'web');
const distDir = join(webDir, 'dist');
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const store = process.env.ZOLLIFY_SHELL_STORE
  ? resolve(process.env.ZOLLIFY_SHELL_STORE)
  : join(root, 'apps', 'server', 'shell-store');

/**
 * Identical to apps/web/vite.config.ts's buildStamp() - the published version
 * has to match what that same build baked into __ZOLLIFY_VERSION__, or the
 * app's own "build" display and the server's idea of "latest" would disagree.
 *
 * ZOLLIFY_COMMIT first, `git rev-parse` only as a local-dev fallback: the
 * Docker build context has no .git at all (.dockerignore excludes it), so
 * git always failed silently there, producing the same bare version on
 * every build - and since a version's directory is immutable, that meant
 * exactly one real publish ever, followed by silent no-ops on every deploy
 * since (confirmed live: production was still serving "0.1.0" with nothing
 * newer, weeks of commits later).
 */
function buildStamp() {
  const version = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf8')).version;
  let sha = process.env.ZOLLIFY_COMMIT && process.env.ZOLLIFY_COMMIT !== 'unknown' ? process.env.ZOLLIFY_COMMIT.slice(0, 7) : '';
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      /* no git, and no env override either - version stays bare */
    }
  }
  return sha ? `${version}+${sha}` : version;
}

function zipDist(outPath) {
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolvePromise);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(distDir, false);
    void archive.finalize();
  });
}

async function main() {
  // ZOLLIFY_SKIP_BUILD=1 for callers that already built apps/web/dist
  // themselves (the Docker build stage runs `npm run build -w @zollify/web`
  // right before this) - rebuilding again here would just burn CI time on an
  // identical output.
  if (process.env.ZOLLIFY_SKIP_BUILD) {
    console.log('ZOLLIFY_SKIP_BUILD set - using the existing apps/web/dist');
  } else {
    console.log('building apps/web…');
    // Same reasoning as publish-modules.mjs: Node 24 refuses to spawn npm.cmd
    // without shell:true, and shell:true then needs argument escaping - calling
    // Vite's own binary directly sidesteps both (confirmed live: `npm run
    // build:web` via execFileSync fails here with EINVAL).
    execFileSync(process.execPath, [viteBin, 'build'], { cwd: webDir, stdio: 'inherit' });
  }

  if (!existsSync(distDir)) {
    console.error('apps/web/dist was not produced - build failed');
    process.exitCode = 1;
    return;
  }

  const version = buildStamp();
  const outDir = join(store, version);
  if (existsSync(outDir)) {
    console.log(`${version} is already published - nothing to do (versions are immutable).`);
    return;
  }
  mkdirSync(outDir, { recursive: true });

  const zipPath = join(outDir, 'bundle.zip');
  await zipDist(zipPath);

  const bytes = readFileSync(zipPath);
  const integrity = createHash('sha256').update(bytes).digest('hex');

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ version, integrity, sizeBytes: bytes.byteLength }, null, 2)}\n`, 'utf8');
  writeFileSync(join(store, 'latest.json'), `${JSON.stringify({ version }, null, 2)}\n`, 'utf8');

  console.log(`published shell@${version}  ${(bytes.byteLength / 1024).toFixed(1)} kB  sha256:${integrity.slice(0, 12)}…`);
  console.log(`\nlatest.json now points at ${version} in ${store}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
