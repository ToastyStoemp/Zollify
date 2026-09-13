import type { Component } from 'vue';
import type Dexie from 'dexie';
import type { AccountProfile, DiscountRule, EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';

/**
 * Roles carried forward from ZollTool unchanged. A `member` with
 * `allowedEventIds` set is what the product calls a "helper": scoped to
 * specific events, with restricted catalog pricing.
 */
export type Role = 'owner' | 'admin' | 'member';

export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({
  member: 0,
  admin: 1,
  owner: 2,
});

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ── Identity ────────────────────────────────────────────────────────────────

export interface AccountSnapshot {
  accountId: string;
  accountName: string;
  userId: string;
  email: string;
  role: Role;
  /** null = unrestricted. A non-empty list marks a helper, scoped to these events. */
  allowedEventIds: string[] | null;
  /** Account-wide profile shared by every device: who the booth is. */
  profile: AccountProfile;
}

// ── Shell contributions ─────────────────────────────────────────────────────

/** Lazily-loaded route component. Kept async so a module's screens stay out of its entry chunk. */
export type ComponentLoader = () => Promise<Component | { default: Component }>;

export interface RouteDef {
  /**
   * Path relative to the module's mount point. '' is the module's index.
   * The shell mounts these under `/m/<moduleId>/…`, so two modules can never
   * collide on a route and a module cannot claim a core path.
   */
  path: string;
  name: string;
  component: ComponentLoader;
  /** Hidden entirely from users below this role. Defaults to the module's minRole. */
  minRole?: Role;
  title?: string;
}

/**
 * Where a nav entry sits in the sidebar. Groups are named by the job someone is
 * doing, not by which package the screen came from — a seller looking for the
 * till should not need to know it is a module.
 */
export type NavGroup = 'selling' | 'stock' | 'events' | 'suppliers' | 'account';

export interface NavItem {
  /** Route name registered via `routes.add`. */
  routeName: string;
  label: string;
  /** Sidebar group. Omitted entries land under "Add-ons". */
  group?: NavGroup;
  /** Lucide icon name, resolved by the shell so modules ship no icon payload. */
  icon?: string;
  /** Lower sorts earlier. Core items occupy 0–99; modules should use 100+. */
  order?: number;
  minRole?: Role;
}

export interface SettingsPanel {
  id: string;
  label: string;
  component: ComponentLoader;
  minRole?: Role;
  order?: number;
}

// ── Cross-module events ─────────────────────────────────────────────────────

export interface SaleLine {
  productId: string;
  /** Variant id, or null for the product itself. */
  variantId?: string | null;
  sku: string | null;
  name: string;
  qty: number;
  /** Major units (12.50), matching the payment provider contracts. */
  unitPrice: number;
  /**
   * What this line actually contributed to the total, after discounts were
   * spread across the basket.
   *
   * Carried explicitly rather than recomputed from `unitPrice × qty`: with a
   * discount applied those two disagree, and a receipt whose lines do not add
   * up to its total is the first thing anyone notices.
   */
  lineTotal: number;
  taxRate: number | null;
}

/**
 * Emitted by POS after a completed checkout. This is the contract that lets Tax
 * book revenue without importing POS — the reason it lives in the SDK and not
 * in either module.
 */
export interface SaleEvent {
  saleId: string;
  eventId: string | null;
  at: number;
  /** What the customer was charged in. */
  currency: string;
  total: number;
  /**
   * The event's own currency and the equivalent figure in it, when the sale was
   * charged in a converted local currency.
   *
   * Both are recorded because they answer different questions: `total` is what
   * the terminal took, `baseTotal` is what the books count. Deriving one from
   * the other later would use whatever rate is current then, not the rate that
   * was actually applied.
   */
  baseCurrency?: string;
  baseTotal?: number;
  exchangeRate?: number;
  lines: SaleLine[];
  payment: {
    provider: string;
    approved: boolean;
    /**
     * How the money actually moved. A terminal provider is always card; a
     * manual sale says which, because an external terminal the app never
     * talks to is still a card sale and must not land in the cash count.
     */
    method?: 'cash' | 'card';
    txRef?: string;
    cardBrand?: string;
  };
}

export interface CoreEvents {
  sale: SaleEvent;
  'catalog:changed': { productIds: string[] };
  'event:activated': { eventId: string | null };
  'sync:completed': { at: number; pulled: number; pushed: number };
}

export type EventName = keyof CoreEvents | (string & {});
export type EventPayload<K extends EventName> = K extends keyof CoreEvents ? CoreEvents[K] : unknown;
export type Unsubscribe = () => void;

export interface EventBus {
  on<K extends EventName>(name: K, handler: (payload: EventPayload<K>) => void): Unsubscribe;
  once<K extends EventName>(name: K, handler: (payload: EventPayload<K>) => void): Unsubscribe;
  emit<K extends EventName>(name: K, payload: EventPayload<K>): void;
}

// ── Server access ───────────────────────────────────────────────────────────

export interface HttpError extends Error {
  status: number;
  body: unknown;
}

/**
 * Calls are namespaced to the module's own server half — a request from module
 * `tax` reaches `/api/m/tax/…` and cannot address another module's routes.
 * Auth headers and tenant scoping are applied by the host.
 */
export interface HttpClient {
  get<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, init?: RequestInit): Promise<T>;
  del<T = unknown>(path: string, init?: RequestInit): Promise<T>;
}

// ── Storage ─────────────────────────────────────────────────────────────────

/** Dexie store definitions, exactly as `db.version(n).stores({ … })` takes them. */
export type StoreSchema = Record<string, string | null>;

// ── Core data ───────────────────────────────────────────────────────────────

/**
 * Read access to the shared catalogue. Modules never open core's database
 * themselves — going through here keeps core the only writer, so every change
 * records a sync op and no module can quietly diverge from what syncs.
 */
export interface CatalogApi {
  /** Every product, title-sorted. Soft-deleted rows are already excluded. */
  list(): Product[];
  forSale(): Product[];
  get(id: string): Product | undefined;

  /**
   * Writes go through core rather than into a module's own tables, so the sync
   * outbox records them and every device converges. A module that stored
   * products itself would be invisible to sync.
   */
  upsert(product: Product): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface SalesEventApi {
  /**
   * Events this user may see. For a helper that is only their allowed events —
   * the server applies the same filter on sync, so this is what they can act
   * on rather than the boundary itself.
   */
  list(): SalesEvent[];
  get(id: string): SalesEvent | undefined;
  /** The event the till is currently working. Device-local, not synced. */
  active(): SalesEvent | null;
  setActive(id: string | null): Promise<void>;
  stock(eventId: string): Promise<EventStock[]>;

  upsert(event: SalesEvent): Promise<void>;
  remove(id: string): Promise<void>;
  setStock(entry: EventStock): Promise<void>;
}

/** What one event can still sell of an item. */
export interface ItemAvailability {
  productId: string;
  variantId: string;
  label: string;
  /** Total owned by the booth. */
  onHand: number;
  /** This event's claim, or null when it sells from the shared pool. */
  claimed: number | null;
  soldHere: number;
  reservedElsewhere: number;
  available: number;
  source: 'claim' | 'pool';
}

/**
 * The booth's single inventory, with per-event claims on top.
 *
 * A claim reserves stock for one event; an event with no claim sells from
 * whatever is unclaimed. Availability is derived from recorded sales, never
 * decremented, so a revert needs no compensating write.
 */
export interface InventoryApi {
  /** Everything this event can still sell. */
  availability(eventId: string): ItemAvailability[];
  /** What this event can still sell of one item. */
  availableFor(eventId: string, productId: string, variantId?: string | null): number;
  onHand(productId: string, variantId?: string | null): number;
  setOnHand(productId: string, variantId: string | null, qty: number): Promise<void>;
  /** Reserve stock for an event. */
  claim(eventId: string, productId: string, variantId: string | null, qty: number): Promise<void>;
  /** Drop a claim so the event falls back to the shared pool. */
  clearClaim(eventId: string, productId: string, variantId: string | null): Promise<void>;
}

/**
 * Discount rules, stored by core because they reference products and must
 * survive POS being switched off. Modules compute with them; core owns them.
 */
export interface DiscountApi {
  list(): DiscountRule[];
  /** Only rules that should be applied at checkout. */
  active(): DiscountRule[];
  get(id: string): DiscountRule | undefined;
  upsert(rule: DiscountRule): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * Recorded sales. Read-only from a module's side: sales are written by core
 * when a `sale` event is announced, so there is exactly one path by which a
 * transaction comes into existence.
 */
export interface TransactionApi {
  /** Most recent first, bounded to what core has loaded. */
  recent(): Transaction[];
  get(id: string): Transaction | undefined;
  /** Per-currency totals, for an event or across all of them. */
  totals(eventId?: string | null): {
    currency: string;
    sales: number;
    gross: number;
    reverted: number;
  }[];
}

/**
 * Product images. Blobs stay on the device that added them; only thumbnails
 * sync, so a catalogue of photos never competes with sale ops for a
 * convention's connection.
 */
export interface ImageApi {
  /** Object URL for an image, or null when it isn't on this device. */
  url(imageId: string | undefined, kind?: 'thumb' | 'full'): Promise<string | null>;
}

export interface DataApi {
  products: CatalogApi;
  inventory: InventoryApi;
  images: ImageApi;
  events: SalesEventApi;
  discounts: DiscountApi;
  transactions: TransactionApi;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ToastOptions {
  kind?: 'info' | 'success' | 'warning' | 'error';
  timeoutMs?: number;
}

export interface ShellUi {
  toast(message: string, options?: ToastOptions): void;
  confirm(message: string, title?: string): Promise<boolean>;
}

// ── The SDK surface ─────────────────────────────────────────────────────────

/**
 * Everything a module is allowed to touch. A module imports `@zollify/sdk` and
 * nothing else from the platform — that boundary is what makes a published SDK
 * possible later without a rewrite, so it is enforced in review, not by
 * convention.
 */
export interface Sdk {
  readonly moduleId: string;
  readonly sdkVersion: string;

  routes: { add(route: RouteDef): void; addAll(routes: RouteDef[]): void };
  nav: { add(item: NavItem): void };
  settings: { panel(panel: SettingsPanel): void };

  events: EventBus;
  http: HttpClient;
  ui: ShellUi;
  log: Logger;

  /**
   * Opens this module's own Dexie database, namespaced
   * `zollify_<accountId>_<moduleId>`. Each module versions its schema
   * independently, so installing or removing one never migrates another's data,
   * and uninstalling is a clean database delete.
   */
  db(schema: StoreSchema, version?: number): Dexie;

  /** Read access to core's shared domain — the catalogue and sales events. */
  data: DataApi;

  /** Current account and user. Returns a snapshot; use `onAccountChange` to react. */
  account(): AccountSnapshot | null;
  onAccountChange(handler: (account: AccountSnapshot | null) => void): Unsubscribe;

  /** Per-module, per-account key/value config. Small values only; synced settings live in core. */
  config: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

// ── Module definition ───────────────────────────────────────────────────────

export interface ModuleDefinition {
  /** Stable, lowercase, URL-safe. Also the mount path and DB namespace. */
  id: string;
  /** The module's own semver. */
  version: string;
  /** Host SDK range this module was built against, e.g. '^0.1.0'. */
  sdk: string;
  title: string;
  description?: string;
  /** Module ids that must also be loaded. The loader refuses to mount otherwise. */
  requires?: string[];
  /** Minimum role that may load the module at all. Defaults to 'member'. */
  minRole?: Role;
  setup(sdk: Sdk): void | Promise<void>;
  /** Called before unload. Release timers, sockets and subscriptions here. */
  teardown?(): void | Promise<void>;
}
