/**
 * Host-provided Vue Router.
 *
 * A module that calls `useRoute()` or `useRouter()` must reach the shell's
 * router, and those look it up by a symbol private to one copy of the library:
 * a copy inlined in the bundle would find nothing. An inlined copy also reads
 * `process.env.NODE_ENV` as it loads, which does not exist in a browser, so
 * the whole bundle failed to import from its blob URL.
 */
export * from 'vue-router';
