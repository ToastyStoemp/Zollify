import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Host entries published at stable, unhashed paths so `index.html` can carry a
 * static import map. They re-export the shell's own copies, so Rollup shares
 * one chunk between the shell and any runtime module — which is what keeps a
 * single Vue instance across the boundary.
 */
const HOST_ENTRIES = ['vue', 'dexie', 'sdk', 'ui', 'shared'] as const;
const hostInputs = Object.fromEntries(
  HOST_ENTRIES.map((name) => [`host-${name}`, resolve(__dirname, `src/host/${name}.ts`)]),
);

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5180,
    proxy: {
      // Same-origin in production; proxied in dev so the session cookie and
      // CORS rules behave identically in both.
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
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
