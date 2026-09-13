/**
 * @zollify/platform — the host.
 *
 * Apps import this. Modules must not: their only permitted import from the
 * platform is @zollify/sdk.
 */

export { PlatformEventBus } from './events';
export {
  ContributionRegistry,
  qualifiedName,
  type OwnedRoute,
  type OwnedNavItem,
  type OwnedSettingsPanel,
  type RouteSink,
} from './contributions';
export {
  moduleDbName,
  openModuleDb,
  closeModuleDb,
  deleteModuleDb,
  listZollifyDbs,
} from './module-db';
export {
  bundleKey,
  sha256Hex,
  getCached,
  putCached,
  verifyCached,
  evictModule,
  pruneOldVersions,
  listCached,
  type CachedBundle,
} from './module-cache';
export {
  ModuleLoader,
  StaticResolver,
  RemoteResolver,
  orderByDependencies,
  type ModuleDescriptor,
  type ModuleResolver,
  type LoadOutcome,
  type LoadStatus,
  type LoaderOptions,
} from './loader';
export { createModuleHost, type ModuleHost, type HostServices } from './sdk-host';
export {
  applyLogin,
  clearSession,
  authFetch,
  refreshAccessToken,
  configureApiBase,
  getApiBase,
  getAccount,
  onAccountChange,
  currentAccount,
  isAuthenticated,
  type LoginResult,
} from './session';
export { createShellUi, toasts, pendingConfirm, type Toast, type ConfirmRequest } from './shell-ui';
export * from './core';
