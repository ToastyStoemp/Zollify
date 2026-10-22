import type { EventStock, Product, SalesEvent, Transaction } from '@zollify/shared';
import { capSoldToBrought, declaredLineValues, esc, fmtEventDates } from '@zollify/customs-core';

/**
 * ATA Carnet: the General List, built from what an event claims, and the
 * return check after it. A carnet lets stock into a non-EU country for a
 * show without paying duty, on the promise that it comes back; what did
 * not come back (sold) is what duty is due on. So the list is the event's
 * packed stock, numbered, with pieces, weight, value and origin - the
 * columns of the official General List - and the return check reads each
 * line's sales against it.
 *
 * Pure: event + products + per-event claims + transactions in, rows out.
 * Quantities come from the claims, sold from non-reverted sales, never
 * stored - the same sources the customs modules use.
 */

/** What the carnet keeps on the event, under its own key (see SalesEvent.carnet). */
export interface CarnetState {
  /** The carnet's number, from the chamber of commerce. */
  number: string;
  issuedAt: string;
  validUntil: string;
  /** Countries it is to be used in, codes. */
  countries: string[];
  /** The holder as printed, when it differs from the business profile. */
  holder: string;
  /** Value column: the list price (commercial value) or the cost where known. */
  valueBasis: 'price' | 'cost';
  /** Other events the same packed stock goes to on one trip; their sales count here. */
  combinedEventIds: string[];
  notes: string;
}

export const defaultCarnetState = (): CarnetState => ({ number: '', issuedAt: '', validUntil: '', countries: [], holder: '', valueBasis: 'price', combinedEventIds: [], notes: '' });

export function readCarnetState(event: Pick<SalesEvent, 'carnet'>): CarnetState {
  const raw = (event.carnet ?? {}) as Partial<CarnetState>;
  const d = defaultCarnetState();
  return {
    number: typeof raw.number === 'string' ? raw.number : d.number,
    issuedAt: typeof raw.issuedAt === 'string' ? raw.issuedAt : d.issuedAt,
    validUntil: typeof raw.validUntil === 'string' ? raw.validUntil : d.validUntil,
    countries: Array.isArray(raw.countries) ? raw.countries.filter((c): c is string => typeof c === 'string') : d.countries,
    holder: typeof raw.holder === 'string' ? raw.holder : d.holder,
    valueBasis: raw.valueBasis === 'cost' ? 'cost' : 'price',
    combinedEventIds: Array.isArray(raw.combinedEventIds) ? raw.combinedEventIds.filter((c): c is string => typeof c === 'string') : d.combinedEventIds,
    notes: typeof raw.notes === 'string' ? raw.notes : d.notes,
  };
}

export interface CarnetRow {
  no: number;
  productId: string;
  variantId: string;
  /** Trade description: title, variant, material, year for art. */
  description: string;
  sku: string;
  type: string;
  pieces: number;
  /** Per piece, grams; 0 when unknown. */
  unitWeightG: number;
  weightKg: number;
  unitValue: number;
  value: number;
  /** Where the value came from: the list price, or the cost. */
  valuedAt: 'price' | 'cost';
  origin: string;
  sold: number;
  soldValue: number;
  /** Pieces that must come back: brought minus sold. */
  returning: number;
}

export interface CarnetList {
  rows: CarnetRow[];
  currency: string;
  totals: { pieces: number; weightKg: number; value: number; sold: number; soldValue: number; returning: number };
  /** Items claimed with no weight or no value: the officer will ask. */
  issues: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function describe(p: Product, v?: Product['variants'][number]): string {
  const parts = [p.title];
  if (v) parts.push(v.name);
  const material = v?.material ?? p.material;
  if (material) parts.push(material);
  if (p.year) parts.push(String(p.year));
  return parts.join(' · ');
}

/**
 * The General List for an event: one numbered line per item (variant)
 * claimed for it, in catalogue order grouped by type, with what sold
 * there (and at any combined event) and what must therefore come back.
 */
export function buildCarnetList(event: SalesEvent, products: Product[], stock: EventStock[], transactions: Transaction[], state: CarnetState, home = ''): CarnetList {
  const eventIds = new Set([event.id, ...state.combinedEventIds]);
  const brought = new Map<string, number>();
  for (const row of stock) if (row.eventId === event.id && row.broughtQty > 0) brought.set(`${row.productId}:${row.variantId}`, row.broughtQty);

  const sold = new Map<string, { qty: number; value: number }>();
  for (const tx of transactions) {
    if (!eventIds.has(tx.eventId) || tx.revertedAt || tx.revertedBy) continue;
    const values = declaredLineValues(tx, tx.currency === event.currency ? 'charged' : 'book');
    tx.items.forEach((item, i) => {
      if (item.lineTotal < 0) return;
      const key = `${item.pid}:${item.vid ?? ''}`;
      const cur = sold.get(key) ?? { qty: 0, value: 0 };
      cur.qty += item.qty;
      cur.value += values[i] ?? 0;
      sold.set(key, cur);
    });
  }

  const typeRank = new Map<string, number>();
  for (const p of products) {
    const t = p.type?.trim() || '￿';
    if (!typeRank.has(t)) typeRank.set(t, typeRank.size);
  }
  const ordered = [...products].filter((p) => !p.deletedAt).sort((a, b) => (typeRank.get(a.type?.trim() || '￿') ?? 0) - (typeRank.get(b.type?.trim() || '￿') ?? 0) || a.sortOrder - b.sortOrder);

  const rows: CarnetRow[] = [];
  const issues: string[] = [];
  for (const p of ordered) {
    const units: { vid: string; v?: Product['variants'][number] }[] = p.variants.length ? p.variants.map((v) => ({ vid: v.id, v })) : [{ vid: '' }];
    for (const { vid, v } of units) {
      const key = `${p.id}:${vid}`;
      const pieces = brought.get(key) ?? 0;
      if (pieces <= 0) continue;
      const s = capSoldToBrought(sold.get(key) ?? { qty: 0, value: 0 }, pieces);
      const unitWeightG = v?.weightG ?? p.weightG ?? 0;
      const cost = v?.cost ?? p.cost;
      const price = v?.price ?? p.price;
      const valuedAt: 'price' | 'cost' = state.valueBasis === 'cost' && typeof cost === 'number' && cost > 0 ? 'cost' : 'price';
      const unitValue = valuedAt === 'cost' ? cost! : price;
      const description = describe(p, v);
      if (!unitWeightG) issues.push(`${description}: no weight.`);
      if (!(unitValue > 0)) issues.push(`${description}: no value.`);
      rows.push({
        no: rows.length + 1,
        productId: p.id,
        variantId: vid,
        description,
        sku: v?.sku ?? p.sku ?? '',
        type: p.type ?? '',
        pieces,
        unitWeightG,
        weightKg: round3((unitWeightG * pieces) / 1000),
        unitValue,
        value: round2(unitValue * pieces),
        valuedAt,
        origin: (p.originCountry || home || '').toUpperCase().slice(0, 2),
        sold: s.qty,
        soldValue: round2(s.value),
        returning: pieces - s.qty,
      });
    }
  }
  const totals = rows.reduce(
    (t, r) => ({ pieces: t.pieces + r.pieces, weightKg: round3(t.weightKg + r.weightKg), value: round2(t.value + r.value), sold: t.sold + r.sold, soldValue: round2(t.soldValue + r.soldValue), returning: t.returning + r.returning }),
    { pieces: 0, weightKg: 0, value: 0, sold: 0, soldValue: 0, returning: 0 },
  );
  return { rows, currency: event.currency, totals, issues };
}

const cell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The General List as the chambers' online forms take it: item no, description, pieces, weight, value, origin. */
export function carnetCsv(list: CarnetList): string {
  const head = ['Item No', 'Trade description of goods and marks and numbers', 'Number of pieces', 'Weight (kg)', `Value (${list.currency})`, 'Country of origin'];
  const lines = list.rows.map((r) => [r.no, r.description + (r.sku ? ` [${r.sku}]` : ''), r.pieces, r.weightKg.toFixed(3), r.value.toFixed(2), r.origin].map(cell).join(','));
  return [head.map(cell).join(','), ...lines, ['', 'TOTAL', list.totals.pieces, list.totals.weightKg.toFixed(3), list.totals.value.toFixed(2), ''].map(cell).join(',')].join('\n');
}

export interface CarnetDocMeta {
  holder: string;
  eventName: string;
  dateStart: string;
  dateEnd: string;
  countries: string;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; color: #000; padding: 12mm; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 5mm; }
  .title { font-size: 11pt; font-weight: bold; text-transform: uppercase; }
  .sub { font-size: 8pt; color: #444; margin-top: 2px; }
  .meta { text-align: right; font-size: 8pt; } .meta strong { font-size: 10pt; }
  table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
  th { background: #e8e8e8; border: 1px solid #aaa; padding: 3px 4px; text-align: left; font-size: 6.5pt; }
  td { border: 1px solid #ccc; padding: 2px 4px; vertical-align: top; }
  tfoot td { background: #e8e8e8; font-weight: bold; border: 1px solid #aaa; }
  .r { text-align: right; } .c { text-align: center; }
  .note { margin-top: 4mm; font-size: 7.5pt; color: #333; line-height: 1.5; }
  .sig { margin-top: 8mm; } .box { border: 1px solid #000; width: 80mm; height: 22mm; margin-top: 2mm; }
  @media print { body { padding: 0; } @page { size: A4 landscape; margin: 12mm; } }`;

function top(title: string, sub: string, meta: CarnetDocMeta, state: CarnetState): string {
  return `<div class="top"><div><div class="title">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>
  <div class="meta"><strong>${esc(meta.eventName)}</strong><br>${esc(fmtEventDates(meta.dateStart, meta.dateEnd))}${meta.countries ? `<br>${esc(meta.countries)}` : ''}${state.number ? `<br>Carnet ${esc(state.number)}` : ''}${state.validUntil ? `<br>valid until ${esc(state.validUntil)}` : ''}<br>Holder: ${esc(meta.holder)}</div></div>`;
}

/** The General List, laid out as the carnet's own: columns 1 to 6, totals, a note on continuation and a signature box. */
export function generalListHtml(list: CarnetList, state: CarnetState, meta: CarnetDocMeta): string {
  const rows = list.rows
    .map((r) => `<tr><td class="c">${r.no}</td><td>${esc(r.description)}${r.sku ? ` <span style="color:#666">[${esc(r.sku)}]</span>` : ''}</td><td class="r">${r.pieces}</td><td class="r">${r.weightKg.toFixed(3)}</td><td class="r">${r.value.toFixed(2)}</td><td class="c">${esc(r.origin)}</td></tr>`)
    .join('\n');
  const body = `${top('ATA Carnet - General List', 'Liste générale · Goods to be covered by the carnet, in the order of the carnet', meta, state)}
<table><thead><tr><th class="c">1<br>Item No.</th><th>2<br>Trade description of goods and marks and numbers, if any</th><th class="r">3<br>Number of pieces</th><th class="r">4<br>Weight (kg)</th><th class="r">5<br>Value (${esc(list.currency)})</th><th class="c">6<br>Country of origin</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="c" style="padding:8px;color:#888">Nothing is claimed for this event yet.</td></tr>'}</tbody>
<tfoot><tr><td></td><td>TOTAL CARRIED OVER / TOTAL</td><td class="r">${list.totals.pieces}</td><td class="r">${list.totals.weightKg.toFixed(3)}</td><td class="r">${list.totals.value.toFixed(2)}</td><td></td></tr></tfoot></table>
<p class="note">Values are ${state.valueBasis === 'cost' ? 'at cost where known, else list price' : 'commercial values (list price)'} in ${esc(list.currency)}. ${state.notes ? esc(state.notes) : ''}</p>
<div class="sig"><strong>Date and signature of the holder</strong><div class="box"></div></div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>General List - ${esc(meta.eventName)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

/** After the show: each line's pieces out, sold, and due back - what the re-importation voucher must agree with. */
export function returnCheckHtml(list: CarnetList, state: CarnetState, meta: CarnetDocMeta): string {
  const rows = list.rows
    .map((r) => `<tr><td class="c">${r.no}</td><td>${esc(r.description)}</td><td class="r">${r.pieces}</td><td class="r">${r.sold}</td><td class="r">${r.soldValue.toFixed(2)}</td><td class="r"${r.returning < r.pieces ? ' style="font-weight:bold"' : ''}>${r.returning}</td></tr>`)
    .join('\n');
  const body = `${top('ATA Carnet - Return check', 'Pieces taken out against the General List, sold abroad, and due back for re-importation', meta, state)}
<table><thead><tr><th class="c">Item No.</th><th>Description</th><th class="r">Pieces out</th><th class="r">Sold</th><th class="r">Sold value (${esc(list.currency)})</th><th class="r">Due back</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="c" style="padding:8px;color:#888">Nothing on the list.</td></tr>'}</tbody>
<tfoot><tr><td></td><td>TOTAL</td><td class="r">${list.totals.pieces}</td><td class="r">${list.totals.sold}</td><td class="r">${list.totals.soldValue.toFixed(2)}</td><td class="r">${list.totals.returning}</td></tr></tfoot></table>
<p class="note">Pieces sold did not return: they are to be declared and duty paid in the country of the show. Pieces due back must be presented at re-importation against the carnet's General List.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Return check - ${esc(meta.eventName)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}
