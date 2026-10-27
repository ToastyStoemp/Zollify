import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { buildStamp } from '../../scripts/build-version.mjs';

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
 * Build stamp shown in the sidebar and attached to diagnostic uploads,
 * MAJOR.MINOR.PATCH-<commit> - worked out in scripts/build-version.mjs, which
 * publish-shell.mjs uses too, so the app and the server agree on it.
 */
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
      onwarn(warning, warn) {
        // zod's own comments mention `@__PURE__` where Rollup cannot read it as an annotation;
        // Rollup drops those comments and nothing else changes. Other warnings still show.
        if (warning.code === 'INVALID_ANNOTATION' && /[\\/]node_modules[\\/]zod[\\/]/.test(warning.id ?? '')) return;
        warn(warning);
      },
    },
  },
});
