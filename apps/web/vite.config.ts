import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Host entries published at stable, unhashed paths so `index.html` can carry a
 * static import map. They re-export the shell's own copies, so Rollup shares
 * one chunk between the shell and any runtime module - which is what keeps a
 * single Vue instance across the boundary.
 */
const HOST_ENTRIES = ['vue', 'dexie', 'sdk', 'ui', 'shared'] as const;
const hostInputs = Object.fromEntries(
  HOST_ENTRIES.map((name) => [`host-${name}`, resolve(__dirname, `src/host/${name}.ts`)]),
);

/**
 * Build stamp shown in the sidebar and attached to diagnostic uploads:
 * version + short commit.
 *
 * ZOLLIFY_COMMIT first, `git rev-parse` only as a local-dev fallback: inside
 * the server's Docker build .git isn't even in the build context
 * (.dockerignore excludes it), so git always failed silently there and this
 * baked a bare, sha-less version into every Docker-built bundle - the same
 * bug that left scripts/publish-shell.mjs's published version frozen, since
 * that script computes this identically and treats a version as immutable
 * once its directory exists.
 */
function buildStamp(): string {
  const version = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;
  let sha = process.env.ZOLLIFY_COMMIT && process.env.ZOLLIFY_COMMIT !== 'unknown' ? process.env.ZOLLIFY_COMMIT.slice(0, 7) : '';
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      /* no git, and no env override either - version stays bare */
    }
  }
  return sha ? `${version}+${sha}` : version;
}

export default defineConfig({
  define: { __ZOLLIFY_VERSION__: JSON.stringify(buildStamp()) },
  plugins: [vue()],
  server: {
    // Pre-transform every lazy screen at startup, so the first visit to a page
    // pays only the network hop rather than a cold transform of its import graph.
    warmup: { clientFiles: ['./src/views/*.vue', './src/components/*.vue', '../../modules/*/src/views/*.vue'] },
    port: 5180,
    proxy: {
      // Same-origin in production; proxied in dev so the session cookie and
      // CORS rules behave identically in both.
      '/api': { target: 'http://localhost:8787', changeOrigin: false, ws: true },
      // Public module halves (events page, feed, widget) live on the gateway too.
      '/p': { target: 'http://localhost:8787', changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        ...hostInputs,
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name.startsWith('host-')
            ? `host/${chunk.name.replace('host-', '')}.js`
            : 'assets/[name]-[hash].js',
      },
      // Host entries are referenced only by the import map, never by an import
      // in the graph, so their exports must survive tree-shaking.
      preserveEntrySignatures: 'allow-extension',
    },
  },
});
