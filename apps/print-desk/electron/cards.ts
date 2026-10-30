import type { DiscountRule, Product } from '@zollify/shared';

/**
 * Price cards: one master layout, drawn by PhotoCraft from the catalogue and a theme.
 *
 * A card names what it prices (whole product types, products or single variants); its rows come
 * from their prices and the discounts that touch them: one price is a big price, several are a
 * line each, a tiered discount adds "2 FOR 26.-" deals, a combo a "Bundle" line, and the
 * products' price notes (or the card's own lines) the small print. The layout turns rows into
 * `photocraft-cli run` commands at 300 ppi, half an A4 wide; the height follows the rows.
 *
 * Every text layer is named after its row, so new prices go into a card PSD by layer name and
 * whatever was changed by hand in it stays.
 */

export interface CardColors {
  bg: string;
  frame: string;
  pill: string;
  title: string;
  /** Text and the regular prices. */
  ink: string;
  /** Deal and bundle prices. */
  accent: string;
  sparkle: string;
  sparkleDark: string;
}

export interface CardTheme {
  id: string;
  name: string;
  font: string;
  colors: CardColors;
  /** A PNG drawn at the pill's right end; '' for none. */
  mascot: string;
}

export const DEFAULT_THEMES: CardTheme[] = [
  { id: 'peach', name: 'Peach', font: 'Bahnschrift', mascot: '', colors: { bg: '#FEEEE4', frame: '#FBD2C2', pill: '#FBD2C2', title: '#9F674E', ink: '#9F674E', accent: '#EA2100', sparkle: '#FFB04C', sparkleDark: '#C9631F' } },
  { id: 'sky', name: 'Sky', font: 'Bahnschrift', mascot: '', colors: { bg: '#CDE5EC', frame: '#7FA2D6', pill: '#7FA2D6', title: '#FFFFFF', ink: '#6A8BC4', accent: '#F04A2A', sparkle: '#FFB04C', sparkleDark: '#FFFFFF' } },
  { id: 'cocoa', name: 'Cocoa', font: 'Bahnschrift', mascot: '', colors: { bg: '#6B3F2A', frame: '#8C5E46', pill: '#8C5E46', title: '#F6D2B0', ink: '#F0A456', accent: '#F2452C', sparkle: '#FFB04C', sparkleDark: '#C9631F' } },
];

/** What a card prices: whole product types, and products ("pid:") or variants ("pid:vid"). */
export interface CardSource {
  types: string[];
  items: string[];
}

export interface CardDef {
  id: string;
  title: string;
  /** Small line above the title in the pill ("Pin & Charm"); '' for none. */
  subtitle: string;
  theme: string;
  /** '' takes the theme's mascot, 'none' draws none, else a PNG of its own. */
  mascot: string;
  source: CardSource;
  /** Row id -> text in place of the row's own label (a line's name, a note's text). */
  labels: Record<string, string>;
  /** Row ids left off the card. */
  hidden: string[];
  /** The small print under the prices; null takes the products' price notes. */
  notes: string[] | null;
  /** The card PSD, once drawn. */
  file?: string;
  /** A PNG of it, for the list. */
  preview?: string;
  height?: number;
  /** The row ids it was drawn with: prices go into the PSD in place while these stay the same. */
  layout?: string;
  /** The texts in the PSD, by layer name, as Print Desk last wrote them. */
  texts?: Record<string, string>;
}

/** Where a drawn card stands against the catalogue now. */
export type CardState = 'new' | 'current' | 'prices' | 'layout' | 'empty';
export function cardState(def: CardDef, rows: CardRow[], fmt: PriceFormat): CardState {
  if (!rows.length) return 'empty';
  if (!def.file) return 'new';
  if (rows.map((r) => r.id).join('|') !== def.layout) return 'layout';
  return changedTexts(def, rows, fmt).length ? 'prices' : 'current';
}
/** The texts that differ from what the PSD holds, as [layer name, text]. */
export function changedTexts(def: CardDef, rows: CardRow[], fmt: PriceFormat): [string, string][] {
  return Object.entries(cardTexts({ title: def.title, subtitle: def.subtitle, rows }, fmt)).filter(([name, text]) => def.texts?.[name] !== text);
}

/** How a price reads: "{n}.-" gives "15.-"; prices are the catalogue's, times `rate`, to `rounding`. */
export interface PriceFormat {
  pattern: string;
  rate: number;
  /** Round to this step (0.5, 5); 0 keeps the cents. */
  rounding: number;
}
export const DEFAULT_FORMAT: PriceFormat = { pattern: '{n}.-', rate: 1, rounding: 0 };

export type CardRow =
  | { id: string; kind: 'price'; price: number }
  | { id: string; kind: 'line'; label: string; price: number; accent?: boolean }
  | { id: string; kind: 'deal'; qty: number; price: number }
  | { id: string; kind: 'note'; text: string };

interface Unit {
  key: string;
  product: Product;
  variant: string;
  price: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The sellable items a card prices: products and variants for sale. A whole type leaves out the
 * unlisted ones (off the price lists); a product or variant picked by name counts all the same.
 */
export function cardUnits(source: CardSource, products: Product[]): Unit[] {
  const units: Unit[] = [];
  for (const p of products) {
    if (p.deletedAt || p.forSale === false) continue;
    const named = source.items.includes(`${p.id}:`);
    const whole = named || (!p.unlisted && !!p.type && source.types.includes(p.type));
    const variants = (p.variants ?? []).filter((v) => named || !v.unlisted || source.items.includes(`${p.id}:${v.id}`));
    if (variants.length) {
      for (const v of variants) {
        if (whole || source.items.includes(`${p.id}:${v.id}`)) units.push({ key: `${p.id}:${v.id}`, product: p, variant: v.name || '', price: round2(v.price ?? p.price ?? 0) });
      }
    } else if (whole) {
      units.push({ key: `${p.id}:`, product: p, variant: '', price: round2(p.price ?? 0) });
    }
  }
  return units;
}

const touches = (rule: DiscountRule, u: Unit): boolean =>
  rule.productIds?.includes(u.product.id) || (!!u.product.type && !!rule.productTypes?.includes(u.product.type)) || rule.variantIds?.includes(u.key);

/**
 * A line's name. Each item goes by its variant when that is a size several of the card's
 * products share ("A4"), or when the card is one product; else by its product. A name too long
 * for a line keeps the sizes alone, else the words the names start with ("Deskmat - Sky",
 * "Deskmat - Valley": "Deskmat"), else the type the items share, else the first name.
 */
function lineLabel(group: Unit[], units: Unit[]): string {
  const oneProduct = new Set(units.map((u) => u.product.id)).size === 1;
  const owners = (variant: string): number => new Set(units.filter((u) => u.variant === variant).map((u) => u.product.id)).size;
  const bySize = (u: Unit): boolean => !!u.variant && (oneProduct || owners(u.variant) > 1);
  const names = [...new Set(group.map((u) => (bySize(u) ? u.variant : u.product.title.trim())))];
  const label = names.join(' / ');
  if (label.length <= 24) return label;
  const sizes = [...new Set(group.filter(bySize).map((u) => u.variant))];
  if (sizes.length) return sizes.join(' / ');
  const words = names.map((n) => n.split(/\s+/));
  const shared: string[] = [];
  for (const [i, w] of words[0]!.entries()) {
    if (!words.every((ws) => ws[i] === w)) break;
    shared.push(w);
  }
  const start = shared.join(' ').replace(/[\s\-–—:·,]+$/, '');
  if (start) return start;
  const types = new Set(group.map((u) => u.product.type));
  return types.size === 1 && group[0]!.product.type ? group[0]!.product.type : names[0]!;
}

/** The cheapest price of a combo member, or null when the catalogue has none of it. */
function memberPrice(products: Product[], match: (p: Product, vid: string) => boolean): number | null {
  const prices: number[] = [];
  for (const p of products) {
    if (p.deletedAt || p.forSale === false) continue;
    const variants = p.variants ?? [];
    if (variants.length) for (const v of variants) if (match(p, v.id)) prices.push(v.price ?? p.price ?? 0);
    if (!variants.length && match(p, '')) prices.push(p.price ?? 0);
  }
  return prices.length ? Math.min(...prices) : null;
}

const ordinal = (n: number): string => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] ?? ['th', 'st', 'nd', 'rd'][n % 100] ?? 'th');

/**
 * Every row a card can show, before its own labels and hidden rows: the prices, the small print,
 * then the deals of the discounts that touch its items and apply on `today` (YYYY-MM-DD).
 */
export function cardRows(def: Pick<CardDef, 'source' | 'notes'>, products: Product[], discounts: DiscountRule[], today: string): CardRow[] {
  const units = cardUnits(def.source, products);
  if (!units.length) return [];
  const rows: CardRow[] = [];

  const byPrice = new Map<number, Unit[]>();
  for (const u of units) byPrice.set(u.price, [...(byPrice.get(u.price) ?? []), u]);
  if (byPrice.size === 1) rows.push({ id: 'price', kind: 'price', price: units[0]!.price });
  else
    for (const [price, group] of [...byPrice].sort((a, b) => a[0] - b[0])) {
      // Named after its first item, not its price, so a new price is the same row.
      const first = group.map((u) => u.key).sort()[0]!;
      rows.push({ id: `line:${first}`, kind: 'line', label: lineLabel(group, units), price });
    }

  const notes = def.notes ?? [...new Set(units.map((u) => u.product.priceNote?.trim() ?? '').filter(Boolean))];
  notes.forEach((text, i) => rows.push({ id: `note:${i}`, kind: 'note', text }));

  const live = discounts.filter((d) => !d.deletedAt && !(d.validFrom && today < d.validFrom) && !(d.validUntil && today > d.validUntil));
  for (const rule of live) {
    const touched = units.filter((u) => touches(rule, u));
    if (!touched.length) continue;
    // A deal on some of the card's items says which: "3 × A4  65.-", "Mousepad: buy 2, get 1 free".
    const some = touched.length < units.length ? lineLabel(touched, units) : '';
    const offer = (text: string): string => (some ? `${some}: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);
    if (rule.type === 'tiered') {
      for (const t of [...(rule.tiers ?? [])].sort((a, b) => a.qty - b.qty)) {
        if (t.qty < 2) continue;
        const id = `deal:${rule.id}:${t.qty}`;
        rows.push(some ? { id, kind: 'line', label: `${t.qty} × ${some}`, price: round2(t.total), accent: true } : { id, kind: 'deal', qty: t.qty, price: round2(t.total) });
      }
    } else if (rule.type === 'combo') {
      const members = [
        ...(rule.productIds ?? []).map((id) => memberPrice(products, (p) => p.id === id)),
        ...(rule.variantIds ?? []).map((k) => memberPrice(products, (p, vid) => `${p.id}:${vid}` === k)),
        ...(rule.productTypes ?? []).map((t) => memberPrice(products, (p) => p.type === t)),
      ];
      if (members.length && members.every((m) => m !== null)) {
        const price = round2(members.reduce<number>((s, m) => s + m!, 0) - (rule.comboDiscountAmount ?? 0));
        rows.push({ id: `bundle:${rule.id}`, kind: 'line', label: 'Bundle', price, accent: true });
      }
    } else if (rule.type === 'bxgy') {
      rows.push({ id: `offer:${rule.id}`, kind: 'note', text: offer(`Buy ${rule.buyQty ?? 2}, get ${rule.freeQty ?? 1} free`) });
    } else if (rule.type === 'nth_pct') {
      rows.push({ id: `offer:${rule.id}`, kind: 'note', text: offer(`Every ${ordinal(rule.nth ?? 3)} ${rule.percent ?? 0}% off`) });
    }
  }
  return rows;
}

/** The rows as the card shows them: its own labels, without the hidden ones. */
export function shownRows(def: Pick<CardDef, 'labels' | 'hidden'>, rows: CardRow[]): CardRow[] {
  return rows
    .filter((r) => !def.hidden.includes(r.id))
    .map((r) => {
      const own = def.labels[r.id];
      if (own === undefined) return r;
      if (r.kind === 'line') return { ...r, label: own };
      if (r.kind === 'note') return { ...r, text: own };
      return r;
    });
}

export function formatPrice(price: number, fmt: PriceFormat): string {
  let v = price * (fmt.rate > 0 ? fmt.rate : 1);
  v = fmt.rounding > 0 ? Math.round(v / fmt.rounding) * fmt.rounding : round2(v);
  v = round2(v);
  const n = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return (fmt.pattern || '{n}').replace('{n}', n);
}

// ── Layout, in pixels at 300 ppi ──

export const CARD_WIDTH = 1240;
export const A4 = { width: 2480, height: 3508 };
const PX_PER_PT = 300 / 72;
const FRAME = { x: 92, top: 192, width: 1056, radius: 165, stroke: 20 };
const PILL = { x: 287, y: 100, width: 673, height: 177 };
/** Where the rows start, under the pill. */
const ROWS_TOP = 345;
const LINE_LEFT = 190;
const LINE_RIGHT = 1058;

/**
 * A text's width in pixels, roughly: Bahnschrift Bold's glyphs average 0.58 em, narrow ones less.
 * ponytail: an estimate, only used to shrink text that would not fit; measure with type.info
 * through `photocraft-cli serve` if a font is far off.
 */
export function textWidth(text: string, pt: number, tracking = 0): number {
  let em = 0;
  for (const ch of text) em += /[.,:;!|' ]/.test(ch) ? 0.28 : /[-1iIlj]/.test(ch) ? 0.38 : /[MW]/.test(ch) ? 0.85 : 0.6;
  return (em + (text.length * tracking) / 1000) * pt * PX_PER_PT;
}
/** The size, at most `pt`, at which the text fits in `width` pixels. */
const fit = (text: string, pt: number, width: number, tracking = 0): number => {
  const w = textWidth(text, pt, tracking);
  return w > width ? Math.max(6, Math.floor((pt * width) / w * 10) / 10) : pt;
};

export type Command = [id: string, params: Record<string, unknown>];

export interface CardArt {
  title: string;
  subtitle: string;
  rows: CardRow[];
  theme: CardTheme;
  /** The mascot PNG and its size in pixels, or null for none. */
  mascot: { path: string; width: number; height: number } | null;
}

/** Text layer name -> its text, for every text a card's prices or labels set. */
export function cardTexts(art: Pick<CardArt, 'title' | 'subtitle' | 'rows'>, fmt: PriceFormat): Record<string, string> {
  const out: Record<string, string> = { Title: art.title.toUpperCase() };
  if (art.subtitle) out.Subtitle = art.subtitle;
  for (const r of art.rows) {
    if (r.kind === 'price') out[r.id] = formatPrice(r.price, fmt);
    if (r.kind === 'line') Object.assign(out, { [`${r.id} label`]: r.label, [`${r.id} price`]: formatPrice(r.price, fmt) });
    if (r.kind === 'deal') Object.assign(out, { [`${r.id} qty`]: String(r.qty), [`${r.id} price`]: formatPrice(r.price, fmt) });
    if (r.kind === 'note') out[r.id] = r.text;
  }
  return out;
}

/** The card as PhotoCraft commands for a new document `width` x `height` at 300 ppi. */
export function cardLayout(art: CardArt, fmt: PriceFormat): { width: number; height: number; layout: string; commands: Command[] } {
  const c = art.theme.colors;
  const font = art.theme.font || 'Bahnschrift';
  const texts = cardTexts(art, fmt);
  const body: Command[] = [];
  const text = (name: string, x: number, y: number, size: number, color: string, extra: Record<string, unknown> = {}): void => {
    body.push(['type.create', { x, y, text: texts[name] ?? name, name, font, fontStyle: 'Bold', size, color, align: 'center', ...extra }]);
  };

  // Line names at one size, the size the longest fits at, down to 18 pt; a longer one gets smaller alone.
  const labelRoom = (id: string): number => LINE_RIGHT - LINE_LEFT - textWidth(texts[`${id} price`]!, 30) - 60;
  const labelFit = (id: string, pt: number): number => fit(texts[`${id} label`]!, pt, labelRoom(id), 100);
  const lineSize = Math.max(18, Math.min(26, ...art.rows.filter((r) => r.kind === 'line').map((r) => labelFit(r.id, 26))));

  let y = ROWS_TOP;
  for (const r of art.rows) {
    if (r.kind === 'price') {
      text(r.id, CARD_WIDTH / 2, y + 170, fit(texts[r.id]!, 48, FRAME.width - 160, 100), c.ink, { tracking: 100 });
      y += 277;
    } else if (r.kind === 'deal') {
      text(`${r.id} qty`, 296, y + 105, 30, c.ink);
      body.push(['type.create', { x: 537, y: y + 105, text: 'FOR', name: `${r.id} for`, font, fontStyle: 'Bold', size: 22, color: c.ink, align: 'center', tracking: 360 }]);
      text(`${r.id} price`, 855, y + 105, fit(texts[`${r.id} price`]!, 30, 380), c.accent);
      y += 145;
    } else if (r.kind === 'line') {
      text(`${r.id} label`, LINE_LEFT, y + 92, labelFit(r.id, lineSize), c.ink, { align: 'left', tracking: 100 });
      text(`${r.id} price`, LINE_RIGHT, y + 92, 30, r.accent ? c.accent : c.ink, { align: 'right' });
      y += 135;
    } else {
      text(r.id, CARD_WIDTH / 2, y + 70, fit(texts[r.id]!, 15, FRAME.width - 200, 120), c.ink, { tracking: 120 });
      y += 100;
    }
  }
  const frameBottom = y + 120;
  const height = Math.ceil((frameBottom + 122) / 2) * 2;

  // The title fits left of the mascot, which sits on the pill's right end.
  const titleRoom = art.mascot ? 480 : PILL.width - 80;
  const titleX = art.mascot ? PILL.x + 40 + titleRoom / 2 : PILL.x + PILL.width / 2;
  const head: Command[] = art.subtitle
    ? [
        ['type.create', { x: titleX, y: 172, text: texts.Subtitle, name: 'Subtitle', font, fontStyle: 'Bold', size: fit(art.subtitle, 10, titleRoom, 150), color: c.title, align: 'center', tracking: 150 }],
        ['type.create', { x: titleX, y: 244, text: texts.Title, name: 'Title', font, fontStyle: 'Bold', size: fit(texts.Title!, 14, titleRoom, 360), color: c.title, align: 'center', tracking: 360 }],
      ]
    : [['type.create', { x: titleX, y: 212, text: texts.Title, name: 'Title', font, fontStyle: 'Bold', size: fit(texts.Title!, 16, titleRoom, 360), color: c.title, align: 'center', tracking: 360 }]];

  const star = (name: string, cx: number, cy: number, w: number, h: number, fill: string): Command => ['shape.create', { kind: 'star', sides: 4, starRatio: 0.28, rect: [cx - w / 2, cy - h / 2, w, h], fill, name }];
  const commands: Command[] = [
    ['shape.create', { kind: 'rect', rect: [0, 0, CARD_WIDTH, height], fill: c.bg, name: 'Background' }],
    ['shape.create', { kind: 'roundedRect', rect: [FRAME.x, FRAME.top, FRAME.width, frameBottom - FRAME.top], radii: FRAME.radius, fill: null, stroke: { width: FRAME.stroke, color: c.frame, align: 'center' }, name: 'Frame' }],
    ['shape.create', { kind: 'roundedRect', rect: [PILL.x, PILL.y, PILL.width, PILL.height], radii: PILL.height / 2, fill: c.pill, name: 'Pill' }],
    ...body,
    ...head,
    star('Sparkle', 169, 182, 150, 160, c.sparkle),
    star('Sparkle small', 110, 298, 60, 66, c.sparkleDark),
    star('Sparkle', 1148, frameBottom - 108, 125, 135, c.sparkle),
    star('Sparkle small', 1034, frameBottom - 14, 60, 64, c.sparkle),
  ];
  if (art.mascot) {
    // Mascots are drawn at their own pixels, made smaller only when they would cover the pill.
    const scale = Math.min(100, Math.floor((300 / Math.max(art.mascot.width, art.mascot.height)) * 100));
    commands.push(['file.placeEmbedded', { path: art.mascot.path, scale, smartObject: true, center: [954, 174] }]);
  }
  return { width: CARD_WIDTH, height, layout: art.rows.map((r) => r.id).join('|'), commands };
}

/** A card on an A4 sheet: page (0-based) and top-left corner in pixels. */
export interface Placed {
  key: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Cards in A4 pages of half-width columns, in order, each going to the column that ends highest;
 * a card that fits in none starts a new page. A card taller than a page gets a page of its own.
 */
export function packSheets(cards: { key: string; width: number; height: number }[]): Placed[] {
  const columns = Math.max(1, Math.floor(A4.width / CARD_WIDTH));
  const out: Placed[] = [];
  let page = 0;
  let tops = Array<number>(columns).fill(0);
  for (const card of cards) {
    let col = tops.indexOf(Math.min(...tops));
    if (tops[col]! > 0 && tops[col]! + card.height > A4.height) {
      page++;
      tops = Array<number>(columns).fill(0);
      col = 0;
    }
    out.push({ key: card.key, page, x: col * CARD_WIDTH, y: tops[col]!, width: card.width, height: card.height });
    tops[col] = tops[col]! + card.height;
  }
  return out;
}

/** One page's commands, for a new A4 document: each card placed as an embedded Smart Object. */
export function sheetCommands(placed: (Placed & { file: string })[]): Command[] {
  return placed.map((p) => ['file.placeEmbedded', { path: p.file, scale: 100, smartObject: true, center: [p.x + p.width / 2, p.y + p.height / 2] }]);
}
