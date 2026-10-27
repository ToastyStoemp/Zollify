import type { ImageInfo, CatalogRow, CopyProgress, PrintJob, PrintResult, Printer, Session, Settings } from '../electron/shared';
import type { DevModeSummary } from '../electron/devmode';
import type { Material } from '../electron/materials';
import type { EventSold } from '../electron/reduce';
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
    /** Copies the last closed event sold per stock key; null when no event is closed. */
    lastEventSold(): Promise<EventSold | null>;
    /** Adds copies to each item's stock as Zollify has it now; each item's new count. */
    addOnHand(items: { productId: string; variantId: string; add: number }[]): Promise<{ key: string; onHand: number }[]>;
  };
  /** Zollify's materials, through the printer key. */
  materials: {
    /** Stores the key once Zollify accepts it ('' removes it). */
    setKey(key: string): Promise<Settings>;
    list(): Promise<Material[]>;
    /** Logs paper used; `job` names the copies, so the same copies sent again count once. */
    use(use: { material: string; qty: number; note?: string; job: string }): Promise<{ material: Material; duplicate: boolean }>;
  };
  photocraft: {
    printers(): Promise<Printer[]>;
    /** An image's size in pixels, read by photocraft-cli. */
    size(file: string): Promise<ImageInfo>;
    /** The settings of PhotoCraft's last print (File › Print), as an item's print params. */
    lastPrint(): Promise<Record<string, unknown>>;
    /** Driver settings hex (printerSettings) as label/value lines; null when it isn't driver settings. */
    describeSettings(hex: string): Promise<DevModeSummary[] | null>;
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
