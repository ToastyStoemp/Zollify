#!/usr/bin/env node
/**
 * Builds each module and publishes it into the server's module store.
 *
 * Layout written is exactly what `loadModuleStore` reads:
 *
 *   <store>/<moduleId>/<version>/manifest.json
 *   <store>/<moduleId>/<version>/bundle.js
 *
 * Versions are written to their own directory and never overwritten, so a
 * published version's bytes are immutable — the client caches by
 * `<id>@<version>` and hash-verifies, and rollback is just pointing at the
 * older directory that is still there.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.ZOLLIFY_MODULE_STORE
  ? resolve(process.env.ZOLLIFY_MODULE_STORE)
  : join(root, 'apps', 'server', 'modules-store');

const MODULES = ['pos', 'customs', 'price-cards', 'sourcing', 'migration', 'shopify-sync', 'public-events', 'tax'];
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

/**
 * Reads the module's declared identity from its source rather than trusting a
 * second copy in package.json. The loader refuses a bundle whose declared id
 * differs from the one it was served as, so the manifest has to agree with
 * what `defineModule` actually says.
 */
function readDeclaration(moduleDir) {
  const source = readFileSync(join(moduleDir, 'src', 'index.ts'), 'utf8');
  const pick = (key) => {
    const m = new RegExp(`${key}:\\s*'([^']+)'`).exec(source);
    return m ? m[1] : null;
  };
  const requires = /requires:\s*\[([^\]]*)\]/.exec(source);

  return {
    moduleId: pick('id'),
    version: pick('version'),
    title: pick('title'),
    description: pick('description') ?? undefined,
    minRole: pick('minRole') ?? undefined,
    requires: requires
      ? requires[1]
          .split(',')
          .map((s) => s.trim().replace(/^'|'$/g, ''))
          .filter(Boolean)
      : undefined,
  };
}

let published = 0;

for (const id of MODULES) {
  const moduleDir = join(root, 'modules', id);
  if (!existsSync(moduleDir)) {
    console.warn(`skip ${id}: no such module directory`);
    continue;
  }

  console.log(`building ${id}…`);
  // Run Vite through Node directly rather than via npm. Node 24 refuses to
  // spawn npm.cmd without a shell, and reaching for shell:true to work around
  // that concatenates arguments unescaped — neither is worth it when the real
  // work is one binary we can call ourselves.
  execFileSync(process.execPath, [viteBin, 'build'], { cwd: moduleDir, stdio: 'inherit' });

  const bundlePath = join(moduleDir, 'dist', 'bundle.js');
  if (!existsSync(bundlePath)) {
    console.error(`skip ${id}: build produced no dist/bundle.js`);
    process.exitCode = 1;
    continue;
  }

  const decl = readDeclaration(moduleDir);
  if (!decl.moduleId || !decl.version) {
    console.error(`skip ${id}: could not read id/version from src/index.ts`);
    process.exitCode = 1;
    continue;
  }
  if (decl.moduleId !== id) {
    // Catching this here beats catching it in the browser: the loader would
    // refuse the bundle at boot with a much less obvious message.
    console.error(`skip ${id}: declares id "${decl.moduleId}" but lives in modules/${id}`);
    process.exitCode = 1;
    continue;
  }

  const outDir = join(store, decl.moduleId, decl.version);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(bundlePath, join(outDir, 'bundle.js'));

  const mapPath = `${bundlePath}.map`;
  if (existsSync(mapPath)) copyFileSync(mapPath, join(outDir, 'bundle.js.map'));

  const bytes = readFileSync(bundlePath);
  const integrity = createHash('sha256').update(bytes).digest('hex');

  writeFileSync(
    join(outDir, 'manifest.json'),
    `${JSON.stringify({ ...decl, bundle: 'bundle.js', integrity, sizeBytes: bytes.byteLength }, null, 2)}\n`,
    'utf8',
  );

  console.log(
    `published ${decl.moduleId}@${decl.version}  ${(bytes.byteLength / 1024).toFixed(1)} kB  sha256:${integrity.slice(0, 12)}…`,
  );
  published += 1;
}

console.log(`\n${published} module(s) published to ${store}`);
