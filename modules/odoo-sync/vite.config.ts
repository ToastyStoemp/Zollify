import { defineConfig } from 'vite';
// @ts-expect-error - plain-JS shared config, intentionally not typed
import { moduleViteConfig } from '../../scripts/module-vite.mjs';

export default defineConfig(moduleViteConfig(__dirname));
