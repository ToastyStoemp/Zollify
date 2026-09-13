import type Dexie from 'dexie';
import {
  SDK_VERSION,
  type AccountSnapshot,
  type HttpClient,
  type Logger,
  type NavItem,
  type RouteDef,
  type Sdk,
  type SettingsPanel,
  type ShellUi,
  type StoreSchema,
  type Unsubscribe,
} from '@zollify/sdk';
import type { ContributionRegistry } from './contributions';
import type { PlatformEventBus } from './events';
import { closeModuleDb, openModuleDb } from './module-db';
import { authFetch, getAccount, onAccountChange } from './session';
import {
  allProducts,
  deleteProduct,
  forSaleProducts,
  getProduct,
  upsertProduct,
} from './core/catalog';
import { getTransaction, recentTransactions, totalsFor } from './core/transactions';
import { imageUrl } from './core/images';
import {
  availabilityFor,
  clearClaim,
  onHandFor,
  setClaim,
  setOnHand,
} from './core/inventory';
import {
  activeDiscounts,
  allDiscounts,
  deleteDiscount,
  getDiscount,
  upsertDiscount,
} from './core/discounts';
import {
  activeEvent,
  deleteSalesEvent,
  getSalesEvent,
  setActiveEvent,
  setStock,
  stockForEvent,
  upsertSalesEvent,
  visibleEvents,
} from './core/sales-events';

export interface HostServices {
  contributions: ContributionRegistry;
  events: PlatformEventBus;
  ui: ShellUi;
}

/**
 * A module's live handle on the platform, plus everything needed to take it
 * back. Every subscription a module makes is recorded here so unloading is
 * complete — an orphaned event handler in a "disabled" module is a bug that
 * would be almost impossible to find later.
 */
export interface ModuleHost {
  sdk: Sdk;
  dispose(): Promise<void>;
}

function makeLogger(moduleId: string): Logger {
  const tag = `[zollify:${moduleId}]`;
  return {
    debug: (...a) => console.debug(tag, ...a),
    info: (...a) => console.info(tag, ...a),
    warn: (...a) => console.warn(tag, ...a),
    error: (...a) => console.error(tag, ...a),
  };
}

/**
 * Requests are rooted at the module's own namespace, so a module cannot call
 * another module's server routes by crafting a path. Leading slashes and `..`
 * segments are stripped rather than trusted.
 */
function makeHttp(moduleId: string): HttpClient {
  const url = (path: string): string => {
    const clean = path
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
      .join('/');
    return `/m/${moduleId}${clean ? `/${clean}` : ''}`;
  };

  const body = (value: unknown): string | undefined =>
    value === undefined ? undefined : JSON.stringify(value);

  return {
    get: <T>(path: string, init?: RequestInit) =>
      authFetch(url(path), { ...init, method: 'GET' }) as Promise<T>,
    post: <T>(path: string, data?: unknown, init?: RequestInit) =>
      authFetch(url(path), { ...init, method: 'POST', body: body(data) }) as Promise<T>,
    put: <T>(path: string, data?: unknown, init?: RequestInit) =>
      authFetch(url(path), { ...init, method: 'PUT', body: body(data) }) as Promise<T>,
    del: <T>(path: string, init?: RequestInit) =>
      authFetch(url(path), { ...init, method: 'DELETE' }) as Promise<T>,
  };
}

/**
 * Read-only view of core's domain, handed to every module.
 *
 * Arrays are copied on the way out: a module holding a live reference to core's
 * reactive state could mutate the catalogue without going through core, and the
 * sync outbox would never hear about it.
 */
const coreData: import('@zollify/sdk').DataApi = {
  products: {
    list: () => [...allProducts.value],
    forSale: () => [...forSaleProducts.value],
    get: (id) => getProduct(id),
    upsert: (product) => upsertProduct(product),
    remove: (id) => deleteProduct(id),
  },
  events: {
    list: () => [...visibleEvents.value],
    get: (id) => getSalesEvent(id),
    active: () => activeEvent.value,
    setActive: (id) => setActiveEvent(id),
    stock: (eventId) => stockForEvent(eventId),
    upsert: (event) => upsertSalesEvent(event),
    remove: (id) => deleteSalesEvent(id),
    setStock: (entry) => setStock(entry),
  },
  inventory: {
    availability: (eventId) => availabilityFor(eventId),
    availableFor: (eventId, productId, variantId) =>
      availabilityFor(eventId).find(
        (r) => r.productId === productId && r.variantId === (variantId ?? ''),
      )?.available ?? 0,
    onHand: (productId, variantId) => onHandFor(productId, variantId ?? ''),
    setOnHand: (productId, variantId, qty) => setOnHand(productId, variantId, qty),
    claim: (eventId, productId, variantId, qty) => setClaim(eventId, productId, variantId, qty),
    clearClaim: (eventId, productId, variantId) => clearClaim(eventId, productId, variantId),
  },
  images: {
    url: (imageId, kind) => imageUrl(imageId, kind ?? 'thumb'),
  },
  transactions: {
    recent: () => [...recentTransactions.value],
    get: (id) => getTransaction(id),
    totals: (eventId) => totalsFor(eventId),
  },
  discounts: {
    list: () => [...allDiscounts.value],
    active: () => [...activeDiscounts.value],
    get: (id) => getDiscount(id),
    upsert: (rule) => upsertDiscount(rule),
    remove: (id) => deleteDiscount(id),
  },
};

const CONFIG_STORE = 'config';
const CONFIG_SCHEMA: StoreSchema = { [CONFIG_STORE]: 'key' };

export function createModuleHost(moduleId: string, services: HostServices): ModuleHost {
  const subscriptions: Unsubscribe[] = [];
  let ownDb: Dexie | null = null;
  let configDb: Dexie | null = null;
  let disposed = false;

  const requireAccount = (): AccountSnapshot => {
    const account = getAccount();
    if (!account) {
      throw new Error(`Module "${moduleId}" used per-account storage while signed out.`);
    }
    return account;
  };

  const configTable = (): Dexie => {
    const account = requireAccount();
    configDb ??= openModuleDb(account.accountId, `${moduleId}-config`, CONFIG_SCHEMA);
    return configDb;
  };

  const guard = (): void => {
    if (disposed) throw new Error(`Module "${moduleId}" used its SDK after being unloaded.`);
  };

  const sdk: Sdk = {
    moduleId,
    sdkVersion: SDK_VERSION,

    routes: {
      add(route: RouteDef) {
        guard();
        services.contributions.addRoute(moduleId, route);
      },
      addAll(routes: RouteDef[]) {
        guard();
        for (const route of routes) services.contributions.addRoute(moduleId, route);
      },
    },

    nav: {
      add(item: NavItem) {
        guard();
        services.contributions.addNav(moduleId, item);
      },
    },

    settings: {
      panel(panel: SettingsPanel) {
        guard();
        services.contributions.addSettingsPanel(moduleId, panel);
      },
    },

    events: {
      on(name, handler) {
        guard();
        const off = services.events.on(name, handler);
        subscriptions.push(off);
        return off;
      },
      once(name, handler) {
        guard();
        const off = services.events.once(name, handler);
        subscriptions.push(off);
        return off;
      },
      emit(name, payload) {
        guard();
        services.events.emit(name, payload);
      },
    },

    http: makeHttp(moduleId),
    ui: services.ui,
    log: makeLogger(moduleId),

    db(schema: StoreSchema, version = 1): Dexie {
      guard();
      const account = requireAccount();
      ownDb ??= openModuleDb(account.accountId, moduleId, schema, version);
      return ownDb;
    },

    data: coreData,

    account: () => getAccount(),

    onAccountChange(handler) {
      guard();
      const off = onAccountChange(handler);
      subscriptions.push(off);
      return off;
    },

    config: {
      async get<T>(key: string): Promise<T | undefined> {
        const row = await configTable()
          .table<{ key: string; value: unknown }>(CONFIG_STORE)
          .get(key);
        return row?.value as T | undefined;
      },
      async set(key: string, value: unknown): Promise<void> {
        await configTable().table(CONFIG_STORE).put({ key, value });
      },
      async remove(key: string): Promise<void> {
        await configTable().table(CONFIG_STORE).delete(key);
      },
    },
  };

  return {
    sdk,
    async dispose() {
      if (disposed) return;
      disposed = true;
      services.events.removeAll(subscriptions);
      subscriptions.length = 0;
      services.contributions.removeModule(moduleId);
      const account = getAccount();
      if (account) {
        // Close, never delete: disabling a module must not destroy its data.
        // Only an explicit uninstall calls deleteModuleDb.
        if (ownDb) closeModuleDb(account.accountId, moduleId);
        if (configDb) closeModuleDb(account.accountId, `${moduleId}-config`);
      }
      ownDb = null;
      configDb = null;
    },
  };
}
