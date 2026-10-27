import type Database from 'better-sqlite3';
import { averageUnitCost } from '@zollify/shared';
import { round2 } from './types';

/**
 * The printing side of a year, for the year in review: what was spent on
 * materials (paper, ink, packaging) by the date ordered, and what went to
 * waste - misprints logged under Sourcing, at each material's average price
 * paid. Sales and the ledger's costs the page works out for itself; these
 * figures live in Sourcing's tables, so they are read here. Without Sourcing
 * (its tables never made) the year simply has none.
 */

interface MaterialDoc {
  id: string;
  name: string;
  type?: string;
  unit?: string;
  purchases?: { id?: string; qty?: number; cost?: number; date?: string }[];
}

export interface YearMaterials {
  materials: { spent: number; orders: number; byType: Record<string, number> };
  waste: { qty: number; cost: number; byMaterial: { id: string; name: string; unit: string; qty: number; cost: number }[] };
}

const hasTable = (db: Database.Database, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function yearMaterials(db: Database.Database, accountId: string, year: number): YearMaterials {
  const out: YearMaterials = { materials: { spent: 0, orders: 0, byType: {} }, waste: { qty: 0, cost: 0, byMaterial: [] } };
  if (!hasTable(db, 'sourcing_docs')) return out;
  const docs = (db.prepare("SELECT doc FROM sourcing_docs WHERE accountId = ? AND coll = 'materials'").all(accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as MaterialDoc);

  const prefix = `${year}-`;
  for (const m of docs) {
    for (const p of m.purchases ?? []) {
      if (!(p.date ?? '').startsWith(prefix)) continue;
      const cost = Number(p.cost) || 0;
      const type = m.type || 'other';
      out.materials.spent += cost;
      out.materials.orders += 1;
      out.materials.byType[type] = (out.materials.byType[type] ?? 0) + cost;
    }
  }
  out.materials.spent = round2(out.materials.spent);
  for (const t of Object.keys(out.materials.byType)) out.materials.byType[t] = round2(out.materials.byType[t]!);

  if (hasTable(db, 'sourcing_material_use')) {
    const rows = db
      .prepare("SELECT materialId, SUM(qty) AS qty FROM sourcing_material_use WHERE accountId = ? AND source = 'waste' AND at >= ? AND at < ? GROUP BY materialId")
      .all(accountId, Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)) as { materialId: string; qty: number }[];
    for (const r of rows) {
      const m = docs.find((x) => x.id === r.materialId);
      if (!m || !(r.qty > 0)) continue;
      const unitPrice = averageUnitCost({ id: m.id, purchases: (m.purchases ?? []).map((p) => ({ id: p.id ?? '', qty: Number(p.qty) || 0, cost: Number(p.cost) || 0 })) });
      const cost = round2(r.qty * unitPrice);
      out.waste.byMaterial.push({ id: m.id, name: m.name, unit: m.unit ?? 'unit', qty: round3(r.qty), cost });
      out.waste.qty += r.qty;
      out.waste.cost += cost;
    }
    out.waste.qty = round3(out.waste.qty);
    out.waste.cost = round2(out.waste.cost);
    out.waste.byMaterial.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  }
  return out;
}
