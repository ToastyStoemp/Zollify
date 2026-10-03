/** Core's shared domain - the catalogue, sales events and the sync outbox. */
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
  eventPricing,
  copyEventPricing,
  type EventPricing,
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
  syncProgress,
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
  type ZollifyBackup,
  type BackupSummary,
  type RestoreResult,
  wipeAccountData,
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
export {
  processImageFile,
  saveProductImage,
  importProductImage,
  deleteImage,
  imageUrl,
  blobToBase64,
  base64ToBlob,
} from './images';
export { transactionsToCsv, csvFilename } from './csv';
export {
  loadInventory,
  inventoryLoaded,
  stockKey,
  onHandFor,
  claimFor,
  claimsForEvent,
  unsoldFrom,
  claimUnsoldFrom,
  type UnsoldRow,
  setOnHand,
  setClaim,
  clearClaim,
  replaceInventory,
  replaceClaims,
  soldAt,
  soldTotal,
  claimedTotal,
  eventIsOver,
  freeFor,
  availabilityFor,
  inventoryRows,
  resetInventoryCache,
  type Availability,
  type InventoryRow,
} from './inventory';
export * from './exchange-rate';
export { mergeProducts, materializeMerge } from './merge';
export { startRealtime, stopRealtime, setDisplaySubscribed, sendDisplayCart, sendPaymentMessage, onPaymentMessage, displayCarts, realtimeConnected, type DisplayCartSnapshot, type PaymentMessage } from './realtime';
export { installDiagnostics, logDiagnostic, diagnosticLogText, sendDiagnosticLog } from './diagnostics';
export { getSyncedSetting, setSyncedSetting } from './synced-settings';
export {
  tseState,
  loadTseSettings,
  setTseSettings,
  refreshTseInfo,
  registerTseDriver,
  tseRequiredFor,
  beginTse,
  signSale,
  abortTse,
  signCancellation,
  resetTseCache,
  type TseDriver,
  type TseDriverId,
  type TseInfo,
  type TseSettings,
} from './tse';
export { tillId, defaultTillId, nextReceiptNumber } from './receipt-numbers';
export { afterSalePrefs, loadAfterSalePrefs, setAfterSalePrefs, receiptUrlFor, type AfterSalePrefs } from './after-sale';
