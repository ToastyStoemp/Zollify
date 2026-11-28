/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  /** 'remote' switches the loader to the registry + cache path; anything else uses bundled modules. */
  readonly VITE_MODULE_SOURCE?: 'bundled' | 'remote';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/** Set by public/webview-check.js, the classic script that runs before the app; absent when that file did not load. */
interface Window {
  zollifyStartCheck?: { mounted(): void };
}

/** Version + short commit, stamped by vite.config.ts at build time. */
declare const __ZOLLIFY_VERSION__: string;
