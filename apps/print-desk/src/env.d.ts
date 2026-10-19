import type { CatalogRow, CopyProgress, PrintJob, PrintResult, Printer, Session, Settings } from '../electron/shared';
import type { LinkPoll, LinkStart } from '../electron/zollify';

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

/** What electron/preload.cjs exposes. */
export interface PrintDeskApi {
  settings: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> };
  pickFile(): Promise<string | null>;
  /** The path of a dropped file, '' when it has none. */
  pathOf(file: File): string;
  pickExe(): Promise<string | null>;
  zollify: {
    resume(): Promise<Session | null>;
    login(input: { server: string; email: string; password: string; code?: string }): Promise<Session>;
    linkStart(server: string): Promise<LinkStart>;
    linkPoll(id: string, pollSecret: string): Promise<LinkPoll>;
    logout(): Promise<void>;
    catalog(): Promise<CatalogRow[]>;
    setOnHand(items: { productId: string; variantId: string; onHand: number }[]): Promise<void>;
  };
  photocraft: {
    printers(): Promise<Printer[]>;
    /** An image's size in pixels, read by photocraft-cli. */
    size(file: string): Promise<{ width: number; height: number }>;
    print(jobs: PrintJob[]): Promise<PrintResult[]>;
    /** Copies left per item, from the print queue, until each job leaves it. */
    onQueue(cb: (progress: CopyProgress) => void): () => void;
  };
}

declare global {
  interface Window {
    printDesk: PrintDeskApi;
  }
}
