/**
 * Host-provided Vue.
 *
 * Runtime module bundles mark `vue` external and resolve it through the import
 * map to this file. Because it re-exports the same module the shell itself
 * imports, Rollup emits one shared chunk — so there is exactly one Vue
 * instance. Two copies would silently break reactivity across the boundary,
 * which is the single nastiest failure mode in a plugin architecture.
 */
export * from 'vue';
