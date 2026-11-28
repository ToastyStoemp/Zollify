import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// The Vue plugin is here only so component tests can import a .vue file; a
// test that needs a DOM asks for it itself with `// @vitest-environment happy-dom`.
export default defineConfig({ plugins: [vue()] });
