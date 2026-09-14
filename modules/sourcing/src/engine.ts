import type { SalesEvent, Transaction } from '@zollify/shared';

/**
 * Sourcing domain — ported from ZollSource. Records are plain documents kept
 * by the server half; everything derived (a rep-ready spec, landed costs,
 * material costing, restock and event planning) is computed here against
 * core data read through the SDK.
 */

export interface Supplier {
  id: string;
  name: string;
  alibabaStoreUrl?: string;
  notes?: string;
  shipModes?: ShipMode[];
  updatedAt?: number;
}
export interface Rep {
  id: string;
  supplierId: string;
  name: string;
  email?: string;
  chatUrl?: string;
  channel: 'email' | 'chat';
  updatedAt?: number;
}
export interface Specs {
  colors?: string;
  plating?: string;
  size?: string;
  packaging?: string;
  moq?: string;
  notes?: string;
}
export interface RecipeLine {
  materialId: string;
  qty: number;
}
export interface Dossier {
  id: string;
  /** Catalogue link; '' vid for the product itself. */
  pid: string | null;
  vid: string | null;
  title: string;
  supplierId: string | null;
  specs: Specs;
  lastUnitPrice: number | null;
  currency: string;
  targetCoverMonths: number | null;
  recipe: RecipeLine[];
  updatedAt?: number;
}
export type ReorderStatus = 'draft' | 'quote_requested' | 'quoted' | 'paid' | 'confirmed' | 'in_production' | 'shipped' | 'received';
export interface ReorderLine {
  dossierId: string;
  title: string;
  qty: number;
  quotedUnitPrice?: number | null;
  confirmedUnitPrice?: number | null;
}
export interface ReorderEvent {
  status: ReorderStatus;
  at: number;
  note?: string;
}
export interface Shipment {
  carrier: string;
  tracking: string;
  shippedAt?: string;
  eta?: string;
}
export interface Reorder {
  id: string;
  ref: string;
  supplierId: string;
  status: ReorderStatus;
  note: string;
  currency: string;
  /** Shipping + import + fees on top of the unit prices, spread across lines. */
  landedExtra: number | null;
  lines: ReorderLine[];
  events: ReorderEvent[];
  shipment?: Shipment;
  createdAt: number;
  updatedAt?: number;
}
export interface Issue {
  id: string;
  supplierId: string;
  dossierId: string | null;
  reorderId: string | null;
  title: string;
  detail: string;
  severity: 'low' | 'medium' | 'high';
  status: 'open' | 'resolved';
  remindOnReorder: boolean;
  createdAt: number;
  resolvedAt: number | null;
  updatedAt?: number;
}
export interface Purchase {
  id: string;
  qty: number;
  cost: number;
  date?: string;
  note?: string;
}
export interface Material {
  id: string;
  name: string;
  type: 'paper' | 'ink' | 'packaging' | 'other';
  unit: string;
  description?: string;
  purchases: Purchase[];
  updatedAt?: number;
}
export interface SourcingFile {
  id: string;
  dossierId: string;
  kind: 'design' | 'proof';
  filename: string;
  mime: string;
  size: number;
  version: number;
  approval: 'approved' | 'rejected' | 'pending' | null;
  note: string | null;
  createdAt: number;
}
export interface Snapshot {
  suppliers: Supplier[];
  reps: Rep[];
  dossiers: Dossier[];
  reorders: Reorder[];
  issues: Issue[];
  materials: Material[];
  files: SourcingFile[];
}

// Order reflects the real flow: quote, pay a deposit, confirmation, then production, shipping, arrival.
export const STATUSES: ReorderStatus[] = ['draft', 'quote_requested', 'quoted', 'paid', 'confirmed', 'in_production', 'shipped', 'received'];
export const STATUS_LABELS: Record<ReorderStatus, string> = {
  draft: 'Draft',
  quote_requested: 'Quote requested',
  quoted: 'Quoted',
  paid: 'Paid',
  confirmed: 'Confirmed',
  in_production: 'In production',
  shipped: 'Shipped',
  received: 'Received',
};

export type ShipMode = 'air' | 'train' | 'boat';
export const SHIP_MODES: { id: ShipMode; name: string }[] = [
  { id: 'air', name: 'Air' },
  { id: 'train', name: 'Train / Rail' },
  { id: 'boat', name: 'Boat / Sea' },
];
const shipModeName = (id: string): string => SHIP_MODES.find((m) => m.id === id)?.name ?? id;

/** Carrier tracking pages — deep links only; unknown carriers go through 17TRACK's detector. */
export const CARRIERS = [
  { id: 'dhl', name: 'DHL Express', url: 'https://www.dhl.com/en/express/tracking.html?AWB={t}' },
  { id: 'fedex', name: 'FedEx', url: 'https://www.fedex.com/fedextrack/?trknbr={t}' },
  { id: 'ups', name: 'UPS', url: 'https://www.ups.com/track?tracknum={t}' },
  { id: 'tnt', name: 'TNT', url: 'https://www.tnt.com/express/en_us/site/tracking.html?searchType=con&cons={t}' },
  { id: 'ems', name: 'EMS / China Post', url: 'https://t.17track.net/en#nums={t}' },
  { id: 'sf', name: 'SF Express', url: 'https://www.sf-international.com/us/en/dynamic_function/waybill/#search/bill-number/{t}' },
  { id: 'other', name: 'Other / auto-detect', url: 'https://t.17track.net/en#nums={t}' },
];
export function trackingUrl(carrierId: string, tracking: string): string {
  const c = CARRIERS.find((x) => x.id === carrierId) ?? CARRIERS[CARRIERS.length - 1]!;
  return tracking ? c.url.replace('{t}', encodeURIComponent(tracking)) : '';
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;
const money = (n: number | null | undefined, cur: string): string => (n == null ? '—' : `${cur ? `${cur} ` : ''}${Number(n).toFixed(2)}`);

/** The next "ZS-0007" reference, from what already exists. */
export function nextRef(reorders: Reorder[]): string {
  const max = reorders.reduce((m, r) => Math.max(m, parseInt((r.ref ?? '').replace(/\D/g, ''), 10) || 0), 0);
  return `ZS-${String(max + 1).padStart(4, '0')}`;
}

/** A rep-ready spec: greeting, each line with quantity and held specs, reminders of past issues, files attached. */
export function buildSpec(reorder: Reorder, snap: Snapshot): string {
  const supplier = snap.suppliers.find((s) => s.id === reorder.supplierId);
  const rep = snap.reps.find((r) => r.supplierId === reorder.supplierId);
  const cur = reorder.currency || '';
  const out: string[] = [];
  out.push(`Hi${rep?.name ? ` ${rep.name}` : ''},`, '');
  out.push(`We'd like to reorder the following${supplier ? ` from ${supplier.name}` : ''}:`);
  if (reorder.ref) out.push(`(Please keep the reference ${reorder.ref} in the subject line when you reply.)`);
  out.push('');
  let fileCount = 0;
  for (const line of reorder.lines) {
    const d = snap.dossiers.find((x) => x.id === line.dossierId);
    out.push(`• ${line.title || d?.title || '(item)'} — qty ${line.qty || 0}`);
    const sp = d?.specs;
    if (sp) {
      const bits: string[] = [];
      if (sp.colors) bits.push(`colours: ${sp.colors}`);
      if (sp.plating) bits.push(`plating: ${sp.plating}`);
      if (sp.size) bits.push(`size: ${sp.size}`);
      if (sp.packaging) bits.push(`packaging: ${sp.packaging}`);
      if (sp.moq) bits.push(`MOQ: ${sp.moq}`);
      if (bits.length) out.push(`    ${bits.join(' · ')}`);
      if (sp.notes) out.push(`    note: ${sp.notes}`);
    }
    if (d?.lastUnitPrice != null) out.push(`    last price: ${money(d.lastUnitPrice, d.currency || cur)}/unit`);
    const files = snap.files.filter((f) => f.dossierId === line.dossierId && f.kind === 'design');
    if (files.length) {
      fileCount += files.length;
      out.push(`    design files attached: ${files.map((f) => f.filename).join(', ')}`);
    }
  }
  const lineDossiers = new Set(reorder.lines.map((l) => l.dossierId));
  const reminders = snap.issues.filter((i) => i.status !== 'resolved' && i.remindOnReorder && i.supplierId === reorder.supplierId && (!i.dossierId || lineDossiers.has(i.dossierId)));
  if (reminders.length) {
    out.push('', 'Please note — issues from previous production to avoid this time:');
    for (const i of reminders) {
      const who = i.dossierId ? `${snap.dossiers.find((d) => d.id === i.dossierId)?.title ?? 'item'}: ` : '';
      out.push(`  ⚠ ${who}${i.title}${i.detail ? ` — ${i.detail}` : ''}`);
    }
  }
  const modes = (supplier?.shipModes ?? []).map(shipModeName);
  out.push('');
  if (modes.length) out.push(`Preferred shipping: ${modes.join(modes.length > 2 ? ', ' : ' or ')}. Please quote freight and lead time for ${modes.length > 1 ? 'each option' : 'this option'}.`);
  else out.push('Could you please confirm availability, a per-unit quote and lead time?');
  if (fileCount) out.push(`(${fileCount} design file${fileCount === 1 ? '' : 's'} attached as a zip.)`);
  if (reorder.note) out.push('', reorder.note);
  out.push('', 'Thank you!');
  return out.join('\n');
}

export interface LandedLine {
  dossierId: string;
  pid: string | null;
  vid: string;
  title: string;
  qty: number;
  unitCost: number;
  finalUnit: number;
}
/**
 * Landed per-unit cost per line: the agreed unit price (confirmed → quoted →
 * dossier's last) plus a share of the reorder's landed extra, spread by line
 * value — the same split as the Costs module, so the two agree.
 */
export function resolveReorderCosts(reorder: Reorder, dossiers: Dossier[]): { resolved: LandedLine[]; skipped: LandedLine[] } {
  const rows = reorder.lines
    .filter((l) => (l.qty || 0) > 0)
    .map((l) => {
      const d = dossiers.find((x) => x.id === l.dossierId);
      return { line: l, d, qty: l.qty, unitCost: Number(l.confirmedUnitPrice ?? l.quotedUnitPrice ?? d?.lastUnitPrice ?? 0) || 0 };
    });
  const extra = Number(reorder.landedExtra) || 0;
  let weights = rows.map((r) => r.unitCost * r.qty);
  let sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    weights = rows.map((r) => r.qty);
    sum = weights.reduce((a, b) => a + b, 0);
  }
  const resolved: LandedLine[] = [];
  const skipped: LandedLine[] = [];
  rows.forEach((r, i) => {
    const share = sum > 0 ? (extra * weights[i]!) / sum : 0;
    const entry: LandedLine = { dossierId: r.line.dossierId, pid: r.d?.pid ?? null, vid: r.d?.vid ?? '', title: r.d?.title || r.line.title || '(item)', qty: r.qty, unitCost: r.unitCost, finalUnit: round2(r.unitCost + share / r.qty) };
    (entry.pid ? resolved : skipped).push(entry);
  });
  return { resolved, skipped };
}

/** Average order → received time per supplier, from reorder histories. */
export function leadTimeDays(supplierId: string, reorders: Reorder[]): number | null {
  const spans: number[] = [];
  for (const r of reorders) {
    if (r.supplierId !== supplierId || r.status !== 'received') continue;
    const start = r.events.find((e) => e.status === 'paid' || e.status === 'confirmed')?.at ?? r.createdAt;
    const end = [...r.events].reverse().find((e) => e.status === 'received')?.at;
    if (end && end > start) spans.push((end - start) / 86400000);
  }
  return spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;
}

// ── Materials: home-print costing ───────────────────────────────────────────
/** Weighted-average unit cost — total spent ÷ total units, so it self-adjusts with every purchase. */
export function unitCost(m: Material): number {
  const qty = m.purchases.reduce((s, p) => s + (Number(p.qty) || 0), 0);
  const cost = m.purchases.reduce((s, p) => s + (Number(p.cost) || 0), 0);
  return qty > 0 ? round4(cost / qty) : 0;
}
export function materialTotals(m: Material) {
  return { qty: m.purchases.reduce((s, p) => s + (Number(p.qty) || 0), 0), spent: round2(m.purchases.reduce((s, p) => s + (Number(p.cost) || 0), 0)), unitCost: unitCost(m) };
}
/** Cost of one print from its recipe, valued at current material unit costs. */
export function printCost(recipe: RecipeLine[], materials: Material[]) {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const lines = recipe
    .filter((r) => r.materialId)
    .map((r) => {
      const m = byId.get(r.materialId);
      const uc = m ? unitCost(m) : 0;
      const qty = Number(r.qty) || 0;
      return { materialId: r.materialId, name: m?.name ?? '(removed material)', unit: m?.unit ?? '', qty, unitCost: uc, cost: round4(uc * qty) };
    });
  return { total: round2(lines.reduce((s, l) => s + l.cost, 0)), lines };
}

// ── Restock: sold per month, on hand, months of cover, suggested order ──────
export interface RestockRow {
  dossierId: string;
  title: string;
  supplierId: string | null;
  soldPerMonth: number;
  onHand: number;
  targetCoverMonths: number;
  monthsCover: number | null;
  suggestQty: number;
  due: boolean;
  moq: number;
}
const key = (pid: string, vid: string | null | undefined): string => `${pid}:${vid ?? ''}`;

/**
 * Per-dossier restock stats. Sold per month comes from a trailing window of
 * sales; on hand is the booth's own count (core inventory), so there is no
 * baseline to maintain; the suggestion tops cover up to the target months,
 * rounded up to the MOQ.
 */
export function computeRestock(dossiers: Dossier[], transactions: Transaction[], onHandFor: (pid: string, vid: string) => number, windowDays = 120): RestockRow[] {
  const from = Date.now() - windowDays * 86400000;
  const sold = new Map<string, number>();
  let earliest = Date.now();
  for (const t of transactions) {
    if (t.revertedAt || t.timestamp < from) continue;
    earliest = Math.min(earliest, t.timestamp);
    for (const it of t.items) sold.set(key(it.pid, it.vid), (sold.get(key(it.pid, it.vid)) ?? 0) + it.qty);
  }
  const months = Math.max(1, (Date.now() - earliest) / (30 * 86400000));
  const rows: RestockRow[] = [];
  for (const d of dossiers) {
    if (!d.pid) continue;
    const k = key(d.pid, d.vid);
    const soldPerMonth = Math.round(((sold.get(k) ?? 0) / months) * 10) / 10;
    const target = d.targetCoverMonths || 3;
    const onHand = onHandFor(d.pid, d.vid ?? '');
    const moq = parseInt(d.specs.moq ?? '') || 0;
    let suggestQty = 0;
    let due = false;
    let monthsCover: number | null = null;
    if (soldPerMonth > 0) {
      monthsCover = Math.round((onHand / soldPerMonth) * 10) / 10;
      due = monthsCover < target;
      const need = Math.max(0, Math.ceil(target * soldPerMonth - onHand));
      suggestQty = moq ? (need > 0 ? Math.max(need, moq) : 0) : need;
    }
    rows.push({ dossierId: d.id, title: d.title, supplierId: d.supplierId, soldPerMonth, onHand, targetCoverMonths: target, monthsCover, suggestQty, due, moq });
  }
  return rows.sort((a, b) => Number(b.due) - Number(a.due) || b.soldPerMonth - a.soldPerMonth);
}

// ── Event planning: what the previous edition sold ─────────────────────────
const editionKey = (name: string): string =>
  (name || '')
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface PlanRow {
  dossierId: string;
  title: string;
  supplierId: string | null;
  soldPrev: number;
  onHand: number;
  suggestQty: number;
  moq: number;
  due: boolean;
  events: { name: string; soldPrev: number }[];
}
export interface PlanBlock {
  eventId: string;
  name: string;
  dateStart: string | null;
  previous: { eventId: string; name: string; dateStart: string | null } | null;
  items: { dossierId: string; title: string; soldPrev: number }[];
  totalUnits: number;
}
/** For each upcoming event, the most recent previous edition (same name minus the year) and what it sold. */
export function computeEventPlan(events: SalesEvent[], dossiers: Dossier[], transactions: Transaction[], onHandFor: (pid: string, vid: string) => number): { events: PlanBlock[]; rows: PlanRow[] } {
  const now = Date.now();
  const startTs = (e: SalesEvent): number => (e.dateStart ? Date.parse(`${e.dateStart}T00:00:00`) : (e.updatedAt ?? 0));
  const upcoming = events.filter((e) => e.status !== 'closed' && (e.status === 'planned' || !e.dateStart || startTs(e) >= now - 2 * 86400000)).sort((a, b) => startTs(a) - startTs(b));
  const prevEdition = (ev: SalesEvent): SalesEvent | null => {
    const k = editionKey(ev.name);
    if (!k) return null;
    return events.filter((o) => o.id !== ev.id && editionKey(o.name) === k && startTs(o) < startTs(ev)).sort((a, b) => startTs(b) - startTs(a))[0] ?? null;
  };
  const byKey = new Map(dossiers.filter((d) => d.pid).map((d) => [key(d.pid!, d.vid), d]));
  const blocks: PlanBlock[] = [];
  const soldPrevByKey = new Map<string, number>();
  const eventsForKey = new Map<string, { name: string; soldPrev: number }[]>();
  for (const ev of upcoming) {
    const prev = prevEdition(ev);
    const block: PlanBlock = { eventId: ev.id, name: ev.name, dateStart: ev.dateStart ?? null, previous: prev ? { eventId: prev.id, name: prev.name, dateStart: prev.dateStart ?? null } : null, items: [], totalUnits: 0 };
    if (prev) {
      const soldAtPrev = new Map<string, number>();
      for (const t of transactions) {
        if (t.eventId !== prev.id || t.revertedAt) continue;
        for (const it of t.items) {
          soldAtPrev.set(key(it.pid, it.vid), (soldAtPrev.get(key(it.pid, it.vid)) ?? 0) + it.qty);
          block.totalUnits += it.qty;
        }
      }
      for (const [k, qty] of soldAtPrev) {
        const d = byKey.get(k);
        if (!d || qty <= 0) continue;
        block.items.push({ dossierId: d.id, title: d.title, soldPrev: qty });
        soldPrevByKey.set(k, (soldPrevByKey.get(k) ?? 0) + qty);
        (eventsForKey.get(k) ?? eventsForKey.set(k, []).get(k)!).push({ name: ev.name, soldPrev: qty });
      }
      block.items.sort((a, b) => b.soldPrev - a.soldPrev);
    }
    blocks.push(block);
  }
  const rows: PlanRow[] = [];
  for (const [k, d] of byKey) {
    const soldPrev = soldPrevByKey.get(k) ?? 0;
    if (soldPrev <= 0) continue;
    const onHand = onHandFor(d.pid!, d.vid ?? '');
    const moq = parseInt(d.specs.moq ?? '') || 0;
    const need = Math.max(0, soldPrev - onHand);
    const suggestQty = moq ? (need > 0 ? Math.max(need, moq) : 0) : need;
    rows.push({ dossierId: d.id, title: d.title, supplierId: d.supplierId, soldPrev, onHand, suggestQty, moq, due: suggestQty > 0, events: eventsForKey.get(k) ?? [] });
  }
  return { events: blocks, rows: rows.sort((a, b) => Number(b.due) - Number(a.due) || b.soldPrev - a.soldPrev) };
}
