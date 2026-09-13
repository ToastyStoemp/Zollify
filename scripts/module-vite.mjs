import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';

/**
 * Every host dependency a module may use. These are left external and resolved
 * at runtime through the shell's import map, so a bundle carries only its own
 * code — and, critically, never a second copy of Vue or Dexie.
 *
 * Adding an entry here also means adding it to the import map in
 * `apps/web/index.html`; a specifier left external with nothing to resolve it
 * fails at import time with a bare-specifier error, which is easy to misread as
 * a broken bundle.
 */
export const HOST_EXTERNALS = ['vue', 'dexie', '@zollify/sdk', '@zollify/ui', '@zollify/shared'];

/**
 * Folds the module's CSS into its JS bundle.
 *
 * A runtime module is fetched as one file and executed from a blob URL, so a
 * separately-emitted stylesheet would simply never be loaded and every module
 * would render unstyled. Injecting a <style> on import keeps the bundle
 * genuinely self-contained, which is the property the whole delivery model
 * depends on.
 *
 * The element is tagged with the module id so unloading can take its styles
 * with it, rather than leaving them to accumulate across enable/disable cycles.
 */
function inlineCss(moduleName) {
  return {
    name: 'zollify:inline-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let css = '';
      for (const [fileName, asset] of Object.entries(bundle)) {
        if (asset.type === 'asset' && fileName.endsWith('.css')) {
          css += String(asset.source);
          delete bundle[fileName];
        }
      }
      if (!css) return;

      const entry = Object.values(bundle).find(
        (chunk) => chunk.type === 'chunk' && chunk.isEntry,
      );
      if (!entry) return;

      const inject = `
(function(){
  if (typeof document === 'undefined') return;
  var id = ${JSON.stringify(`zollify-style-${moduleName}`)};
  if (document.getElementById(id)) return;
  var el = document.createElement('style');
  el.id = id;
  el.setAttribute('data-zollify-module', ${JSON.stringify(moduleName)});
  el.textContent = ${JSON.stringify(css)};
  document.head.appendChild(el);
})();
`;
      entry.code = inject + entry.code;
    },
  };
}

/**
 * Shared Vite config for a Zollify module.
 *
 * Output is a single ES bundle named `bundle.js`, which is what the registry
 * publishes and the loader executes from a blob URL.
 */
export function moduleViteConfig(dir) {
  const moduleName = dir.split(/[\\/]/).pop();
  return {
    plugins: [vue(), inlineCss(moduleName)],
    build: {
      target: 'es2022',
      outDir: resolve(dir, 'dist'),
      emptyOutDir: true,
      // Sourcemaps are published alongside the bundle; they make a failure in a
      // runtime-loaded module diagnosable instead of a stack of blob offsets.
      sourcemap: true,
      lib: {
        entry: resolve(dir, 'src/index.ts'),
        formats: ['es'],
        fileName: () => 'bundle.js',
      },
      rollupOptions: {
        external: (id) =>
          HOST_EXTERNALS.includes(id) || HOST_EXTERNALS.some((ext) => id.startsWith(`${ext}/`)),
        output: {
          // One file: the loader fetches exactly one URL per module, so a
          // half-downloaded install cannot leave a module partially present.
          inlineDynamicImports: true,
        },
      },
    },
  };
}
