import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Loaded from file:// by Electron, so every asset path is relative.
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      onwarn(warning, warn) {
        // zod's own comments mention `@__PURE__` where Rollup cannot read it as an annotation;
        // Rollup drops those comments and nothing else changes. Other warnings still show.
        if (warning.code === 'INVALID_ANNOTATION' && /[\/]node_modules[\/]zod[\/]/.test(warning.id ?? '')) return;
        warn(warning);
      },
    },
  },
});
