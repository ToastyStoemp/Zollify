// Types for module-vite.mjs, the plain-JS Vite config every module shares.
// With this file next to it, the `@ts-expect-error` above the import in each
// modules/*/vite.config.ts is no longer needed (those files are outside every
// tsconfig's `include`, so the leftover comments are harmless until removed).
import type { UserConfig } from 'vite';

/** Every host dependency a module may use; left external in a module bundle. */
export declare const HOST_EXTERNALS: string[];

/** Shared Vite config for a Zollify module; `dir` is the module's directory. */
export declare function moduleViteConfig(dir: string): UserConfig;
