/**
 * What a material costs right now, batch by batch (first in, first out).
 *
 * Paper, ink and packaging are bought in batches at different prices - a box
 * at 50, the next at 60, a new ink cartridge. They are used up oldest first,
 * so what the next print costs is the price of the batch now being used,
 * not an average of everything ever bought: the 50 box until it runs out,
 * then the 60 box. Ink the same way - the cartridge in the printer, at its
 * price per ml, until the next one goes in.
 *
 * A batch is what arrived: a purchase in full, or each delivery of one that
 * came in parts, at the price per unit the order was paid at. What was used
 * (prints, use by hand, recounts) is taken from the oldest batches first.
 */

export interface CostedDelivery {
  qty: number;
  date: string;
}
export interface CostedPurchase {
  id: string;
  /** Ordered, in the material's unit; what was paid is for all of it. */
  qty: number;
  cost: number;
  date?: string;
  deliveries?: CostedDelivery[];
}
export interface CostedMaterial {
  id: string;
  purchases: CostedPurchase[];
}
export interface RecipeUse {
  materialId: string;
  qty: number;
}

/** One batch that arrived, and what is left of it after what was used. */
export interface MaterialLot {
  purchaseId: string;
  date: string;
  qty: number;
  unitPrice: number;
  remaining: number;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A purchase's price per unit: what was paid over what was ordered. */
export const purchaseUnitPrice = (p: Pick<CostedPurchase, 'qty' | 'cost'>): number =>
  (Number(p.qty) || 0) > 0 ? round4((Number(p.cost) || 0) / Number(p.qty)) : 0;

/**
 * The batches in the order they arrived, each with what is left of it once
 * `used` units have been taken oldest first. A recount that found more
 * (a negative use) gives back to the batches the same way.
 */
export function materialLots(m: CostedMaterial, used: number): MaterialLot[] {
  const arrived: (Omit<MaterialLot, 'remaining'> & { order: number })[] = [];
  m.purchases.forEach((p, i) => {
    const unitPrice = purchaseUnitPrice(p);
    if (p.deliveries) {
      p.deliveries.forEach((d, j) => {
        if ((Number(d.qty) || 0) > 0) arrived.push({ purchaseId: p.id, date: d.date || p.date || '', qty: Number(d.qty), unitPrice, order: i * 1000 + j });
      });
    } else if ((Number(p.qty) || 0) > 0) {
      arrived.push({ purchaseId: p.id, date: p.date || '', qty: Number(p.qty), unitPrice, order: i * 1000 });
    }
  });
  arrived.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  let left = Math.max(0, Number(used) || 0);
  return arrived.map(({ order: _order, ...lot }) => {
    const take = Math.min(lot.qty, left);
    left -= take;
    return { ...lot, remaining: round4(lot.qty - take) };
  });
}

/**
 * What the next unit costs: the price of the oldest batch with anything left.
 * Everything used up (or more used than bought): the latest batch's price,
 * which is what the next one will most likely cost. Nothing bought yet: 0.
 */
export function currentUnitCost(m: CostedMaterial, used: number): number {
  const lots = materialLots(m, used);
  const open = lots.find((l) => l.remaining > 0);
  return open ? open.unitPrice : (lots[lots.length - 1]?.unitPrice ?? 0);
}

/** The batch now being used, if any is left. */
export function currentLot(m: CostedMaterial, used: number): MaterialLot | null {
  return materialLots(m, used).find((l) => l.remaining > 0) ?? null;
}

/** The average over everything ordered - for comparison, not what a print costs. */
export function averageUnitCost(m: CostedMaterial): number {
  const qty = m.purchases.reduce((s, p) => s + (Number(p.qty) || 0), 0);
  const cost = m.purchases.reduce((s, p) => s + (Number(p.cost) || 0), 0);
  return qty > 0 ? round4(cost / qty) : 0;
}

/**
 * One print's cost from its recipe, each material at its current batch price
 * - so it moves as batches run out and new ones start.
 */
export function recipeCost(recipe: RecipeUse[], materials: CostedMaterial[], usedOf: (materialId: string) => number) {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const lines = recipe
    .filter((r) => r.materialId)
    .map((r) => {
      const m = byId.get(r.materialId);
      const unitCost = m ? currentUnitCost(m, usedOf(m.id)) : 0;
      const qty = Number(r.qty) || 0;
      return { materialId: r.materialId, qty, unitCost, cost: round4(unitCost * qty) };
    });
  return { total: round2(lines.reduce((s, l) => s + l.cost, 0)), lines };
}
