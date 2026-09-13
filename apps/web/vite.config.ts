import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

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
  },
});
