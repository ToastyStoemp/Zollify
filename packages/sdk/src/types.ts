import type { Component } from 'vue';
import type Dexie from 'dexie';
import type { EventStock, Product, SalesEvent } from '@boothly/shared';

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

export interface NavItem {
  /** Route name registered via `routes.add`. */
  routeName: string;
  label: string;
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
  sku: string | null;
  name: string;
  qty: number;
  /** Major units (12.50), matching the payment provider contracts. */
  unitPrice: number;
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
  currency: string;
  total: number;
  lines: SaleLine[];
  payment: {
    provider: string;
    approved: boolean;
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

export interface DataApi {
  products: CatalogApi;
  events: SalesEventApi;
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
 * Everything a module is allowed to touch. A module imports `@boothly/sdk` and
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
   * `boothly_<accountId>_<moduleId>`. Each module versions its schema
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
