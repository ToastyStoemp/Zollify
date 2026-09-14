import type Dexie from 'dexie';
import type { CostBatch } from '@zollify/shared';
import { sdk } from './runtime';

let db: (Dexie & { batches: Dexie.Table<CostBatch, string> }) | null = null;

/** Batches are device-local, as in ZollTool; only the costs they produce sync (on the products). */
export function costsDb() {
  return (db ??= sdk().db({ batches: 'id, date' }, 1) as Dexie & { batches: Dexie.Table<CostBatch, string> });
}
