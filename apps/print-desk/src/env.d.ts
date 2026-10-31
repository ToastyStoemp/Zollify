import type { ImageInfo, CatalogRow, CopyProgress, PrintJob, PrintResult, Printer, Session, Settings } from '../electron/shared';
import type { DiscountRule, Product } from '@zollify/shared';
import type { CardRow, CardSize, CardStyle, CardTheme, PriceFormat, SheetOptions } from '../electron/cards';
import type { DevModeSummary } from '../electron/devmode';
import type { Material, PaperAccess } from '../electron/materials';
import type { DemandForecast, EventSold } from '../electron/reduce';
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
    /** What each item is expected to sell, for the next event (`today` as YYYY-MM-DD). */
    forecast(today: string): Promise<DemandForecast>;
    /** Adds copies to each item's stock as Zollify has it now; each item's new count. */
    addOnHand(items: { productId: string; variantId: string; add: number }[]): Promise<{ key: string; onHand: number }[]>;
    /** Every live product and discount rule, for price cards. */
    priceData(): Promise<{ products: Product[]; discounts: DiscountRule[] }>;
  };
  /** Price cards, drawn by photocraft-cli into the cards folder. */
  cards: {
    pickPng(): Promise<string | null>;
    pickFolder(): Promise<string | null>;
    /** The folder card and sheet PSDs go to (made when missing). */
    dir(): Promise<string>;
    /** Draws a card PSD and its preview PNG; `mascot` is a PNG path or '' for none. */
    draw(card: { id: string; title: string; subtitle: string; rows: CardRow[]; theme: CardTheme; mascot: string; size?: CardSize; style?: CardStyle; noHeading?: boolean }, fmt: PriceFormat): Promise<{ file: string; preview: string; width: number; height: number; layout: string }>;
    /** Sets text layers by name in a card PSD; layers not found are named in `missing`. */
    setTexts(file: string, texts: Record<string, string>): Promise<{ updated: number; missing: string[]; preview: string }>;
    /** A4 sheet PSDs of the cards, in order, each with a preview PNG. */
    sheets(cards: { key: string; file: string; width: number; height: number; group?: string }[], opts?: SheetOptions): Promise<{ file: string; preview: string }[]>;
    /** A sheet as a PDF beside it. */
    pdf(file: string): Promise<string>;
    /** Prints sheets on A4 with the global print settings' printer. */
    print(files: string[]): Promise<PrintResult[]>;
    /** A PNG as a data: URL. */
    image(file: string): Promise<string>;
    /** Opens a file in its default app (PhotoCraft for a PSD); '' or why it could not. */
    open(file: string): Promise<string>;
  };
  /** Zollify's materials, through the printer key. */
  materials: {
    /** Stores the key once Zollify accepts it ('' removes it). */
    setKey(key: string): Promise<Settings>;
    /** The materials, through the sign-in or else the printer key, and how. */
    list(): Promise<PaperAccess>;
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
