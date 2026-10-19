import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Loaded from file:// by Electron, so every asset path is relative.
export default defineConfig({ base: './', plugins: [vue()], build: { outDir: 'dist' } });
