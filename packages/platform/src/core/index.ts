/** Core's shared domain — the catalogue, sales events and the sync outbox. */
export { openCoreDb, closeCoreDb, deleteCoreDb, coreDbName, type CoreDb, type OutboxOp, type SettingRow, type ImageRec } from './db';
export {
  loadCatalog,
  catalogLoaded,
  allProducts,
  forSaleProducts,
  getProduct,
  visibleProductsFor,
  upsertProduct,
  deleteProduct,
  replaceCatalog,
  resetCatalogCache,
} from './catalog';
export {
  loadSalesEvents,
  visibleEvents,
  activeEvent,
  activeEventId,
  getSalesEvent,
  setActiveEvent,
  upsertSalesEvent,
  deleteSalesEvent,
  replaceSalesEvents,
  stockForEvent,
  setStock,
  resetSalesEventCache,
} from './sales-events';
export {
  queueOp,
  unsyncedOps,
  markSynced,
  refreshPendingCount,
  pruneSynced,
  pendingCount,
  type PendingOp,
} from './outbox';
export { toPlain } from './plain';
export { deviceId, deviceName, setDeviceName, deviceFlavor, resetDeviceCache } from './device';
export {
  syncNow,
  startAutoSync,
  stopAutoSync,
  syncState,
  lastSyncAt,
  lastSyncError,
  type SyncState,
  type SyncResult,
} from './sync';
export {
  loadTransactions,
  transactionsLoaded,
  recentTransactions,
  getTransaction,
  recordSale,
  revertTransaction,
  replaceTransactions,
  saleToTransaction,
  totalsFor,
  resetTransactionCache,
  type SalesTotals,
} from './transactions';
export {
  BACKUP_VERSION,
  createBackup,
  inspectBackup,
  restoreBackup,
  backupFilename,
  RestoreError,
  type BoothlyBackup,
  type BackupSummary,
  type RestoreResult,
} from './backup';
export {
  loadDiscounts,
  discountsLoaded,
  allDiscounts,
  activeDiscounts,
  getDiscount,
  upsertDiscount,
  deleteDiscount,
  replaceDiscounts,
  resetDiscountCache,
} from './discounts';
