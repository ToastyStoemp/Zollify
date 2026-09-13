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
