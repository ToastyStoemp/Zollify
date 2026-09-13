/**
 * @zollify/sdk — the only surface a module may import from the platform.
 *
 * Keeping this the sole boundary is what allows the host to be rewritten, and a
 * public SDK to be published, without touching a single module. Nothing here
 * may import from @zollify/platform.
 */

export const SDK_VERSION = '0.1.0';

export type {
  Role,
  AccountSnapshot,
  ComponentLoader,
  RouteDef,
  NavItem,
  SettingsPanel,
  SaleLine,
  SaleEvent,
  CoreEvents,
  EventName,
  EventPayload,
  Unsubscribe,
  EventBus,
  HttpError,
  HttpClient,
  StoreSchema,
  CatalogApi,
  SalesEventApi,
  DiscountApi,
  TransactionApi,
  ImageApi,
  ItemAvailability,
  InventoryApi,
  DataApi,
  Logger,
  ToastOptions,
  ShellUi,
  Sdk,
  ModuleDefinition,
} from './types';

export { ROLE_RANK, roleAtLeast } from './types';
export { satisfies, parseVersion, compareVersions, type SemVer } from './semver';

import type { ModuleDefinition } from './types';

/**
 * Declares a Zollify module. The identity function exists for type inference
 * and to give the loader one recognisable shape to validate — a module's
 * default export must be the result of this call.
 */
export function defineModule(def: ModuleDefinition): ModuleDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) {
    throw new Error(
      `Invalid module id "${def.id}": use lowercase letters, digits and hyphens, starting with a letter.`,
    );
  }
  return def;
}

/** Runtime marker so the loader can reject a bundle that isn't a Zollify module. */
export const MODULE_EXPORT_KEY = 'default' as const;
