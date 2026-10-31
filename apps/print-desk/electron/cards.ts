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
  { id: 'peach', name: 'Peach', font: 'Bahnschrift', mascot: '', colors: { bg: '#FEEEE4', frame: '#FBD2C2', pill: '#FBD2C2', title: '#9F674E', ink: '#9F674E', accent: '#EA2100', sparkle: '#FFB04C' } },
  { id: 'sky', name: 'Sky', font: 'Bahnschrift', mascot: '', colors: { bg: '#CDE5EC', frame: '#7FA2D6', pill: '#7FA2D6', title: '#FFFFFF', ink: '#6A8BC4', accent: '#F04A2A', sparkle: '#FFB04C' } },
  { id: 'cocoa', name: 'Cocoa', font: 'Bahnschrift', mascot: '', colors: { bg: '#6B3F2A', frame: '#8C5E46', pill: '#8C5E46', title: '#F6D2B0', ink: '#F0A456', accent: '#F2452C', sparkle: '#FFB04C' } },
];

/** What a card prices: whole product types, and products ("pid:") or variants ("pid:vid"). */
export interface CardSource {
  types: string[];
  items: string[];
}

export interface CardDef {
  id: string;
  title: string;
  /** Small line under the title in the pill ("40x90cm"); '' for none. */
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
  /** Half an A4 wide when unset. */
  size?: CardSize;
  /** A card when unset. */
  style?: CardStyle;
  /** A strip without its heading: the title only names the card in the list. */
  noHeading?: boolean;
  /** The big price centred on its number, what the price format adds (".-") hanging outside. */
  centreNumber?: boolean;
  /** Its width in pixels, as drawn. */
  width?: number;
  /** The style, size and row ids it was drawn with: prices go into the PSD in place while these stay the same. */
  layout?: string;
  /** The texts in the PSD, by layer name, as Print Desk last wrote them. */
  texts?: Record<string, string>;
}

/** Where a drawn card stands against the catalogue now. */
export type CardState = 'new' | 'current' | 'prices' | 'layout' | 'empty';
export function cardState(def: CardDef, rows: CardRow[], fmt: PriceFormat): CardState {
  if (!rows.length) return 'empty';
  if (!def.file) return 'new';
  if (layoutKey(def, rows) !== def.layout) return 'layout';
  return changedTexts(def, rows, fmt).length ? 'prices' : 'current';
}
/** The texts that differ from what the PSD holds, as [layer name, text]. */
export function changedTexts(def: CardDef, rows: CardRow[], fmt: PriceFormat): [string, string][] {
  return Object.entries(cardTexts({ title: def.title, subtitle: def.subtitle, rows, style: def.style, noHeading: def.noHeading }, fmt)).filter(([name, text]) => def.texts?.[name] !== text);
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
 * The sellable items a card prices: products and variants for sale. Unlisted ones (off the price
 * lists) count only when picked by name: an unlisted product, or an unlisted variant by itself.
 */
export function cardUnits(source: CardSource, products: Product[]): Unit[] {
  const units: Unit[] = [];
  for (const p of products) {
    if (p.deletedAt || p.forSale === false) continue;
    const named = source.items.includes(`${p.id}:`);
    const whole = named || (!p.unlisted && !!p.type && source.types.includes(p.type));
    const variants = (p.variants ?? []).filter((v) => !v.unlisted || source.items.includes(`${p.id}:${v.id}`));
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
 * Every row a card can show, before its own labels and hidden rows: the prices, the deals of the
 * discounts that touch its items and apply on `today` (YYYY-MM-DD), then the small print.
 */
export function cardRows(def: Pick<CardDef, 'source' | 'notes'>, products: Product[], discounts: DiscountRule[], today: string): CardRow[] {
  const units = cardUnits(def.source, products);
  if (!units.length) return [];
  const rows: CardRow[] = [];

  const byPrice = new Map<number, Unit[]>();
  for (const u of units) byPrice.set(u.price, [...(byPrice.get(u.price) ?? []), u]);
  // One product in one variant is a size or format worth saying ("30x30cm"), so it is a line.
  const oneSize = units.length === 1 && !!units[0]!.variant;
  if (byPrice.size === 1 && !oneSize) rows.push({ id: 'price', kind: 'price', price: units[0]!.price });
  else
    for (const [price, group] of [...byPrice].sort((a, b) => a[0] - b[0])) {
      // Named after its first item, not its price, so a new price is the same row.
      const first = group.map((u) => u.key).sort()[0]!;
      rows.push({ id: `line:${first}`, kind: 'line', label: lineLabel(group, units), price });
    }

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

  const notes = def.notes ?? [...new Set(units.map((u) => u.product.priceNote?.trim() ?? '').filter(Boolean))];
  notes.forEach((text, i) => rows.push({ id: `note:${i}`, kind: 'note', text }));
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

/** How wide a card is drawn: the master at its own size, or scaled down to fit three across. */
export type CardSize = 'half' | 'third';
export const CARD_SIZES: Record<CardSize, { width: number; label: string }> = {
  half: { width: CARD_WIDTH, label: 'Half A4 wide (10.5 cm, 2 across)' },
  third: { width: Math.floor(A4.width / 3), label: 'Third of A4 wide (7 cm, 3 across)' },
};
/**
 * How a card is laid out: the card (title band, rows under each other) or a strip (a heading
 * and the sizes side by side, each with its price under it), for a tag beside each print.
 */
export type CardStyle = 'card' | 'strip';
/** What a drawn card's layout is: style, size and row ids. A different one needs a redraw. */
export const layoutKey = (art: { size?: CardSize; style?: CardStyle; noHeading?: boolean; centreNumber?: boolean }, rows: CardRow[]): string =>
  [
    ...(art.style === 'strip' ? ['strip'] : []),
    ...(art.style === 'strip' && art.noHeading ? ['noheading'] : []),
    ...(art.size === 'third' ? ['third'] : []),
    ...(art.centreNumber ? ['centred'] : []),
    ...rows.map((r) => r.id),
  ].join('|');
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

/**
 * How far right a centred price moves so its number sits in the middle and what the price format
 * adds around it hangs outside: "15.-" then centres on "15", with ".-" to its right.
 */
export function numberShift(fmt: PriceFormat, pt: number, tracking: number): number {
  const [before = '', after = ''] = (fmt.pattern || '{n}').split('{n}');
  return (textWidth(after, pt, tracking) - textWidth(before, pt, tracking)) / 2;
}

export type Command = [id: string, params: Record<string, unknown>];

export interface CardArt {
  title: string;
  subtitle: string;
  rows: CardRow[];
  theme: CardTheme;
  /** The mascot PNG and its size in pixels, or null for none. */
  mascot: { path: string; width: number; height: number } | null;
  size?: CardSize;
  style?: CardStyle;
  noHeading?: boolean;
  centreNumber?: boolean;
}

/** A command with its positions and sizes times `s`: the master drawn smaller, all in proportion. */
function scaled([id, p]: Command, s: number): Command {
  if (s === 1) return [id, p];
  const n = (v: unknown): unknown => (typeof v === 'number' ? Math.round(v * s * 100) / 100 : v);
  const q: Record<string, unknown> = { ...p };
  for (const k of ['x', 'y', 'size', 'radii', 'scale']) if (k in q) q[k] = n(q[k]);
  for (const k of ['rect', 'center']) if (Array.isArray(q[k])) q[k] = (q[k] as unknown[]).map(n);
  if (q.stroke) q.stroke = { ...(q.stroke as Record<string, unknown>), width: n((q.stroke as Record<string, unknown>).width) };
  return [id, q];
}

/** Text layer name -> its text, for every text a card's prices or labels set. */
export function cardTexts(art: Pick<CardArt, 'title' | 'subtitle' | 'rows' | 'style' | 'noHeading'>, fmt: PriceFormat): Record<string, string> {
  // The card's title band is in capitals; a strip's heading reads as typed ("Available in:"), or is left off.
  const out: Record<string, string> = {};
  if (art.style !== 'strip') out.Title = art.title.toUpperCase();
  else if (!art.noHeading && art.title.trim()) out.Title = art.title;
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
  const { height, commands } = art.style === 'strip' ? stripCommands(art, fmt) : cardCommands(art, fmt);
  const width = CARD_SIZES[art.size ?? 'half'].width;
  const s = width / CARD_WIDTH;
  return { width, height: Math.ceil((height * s) / 2) * 2, layout: layoutKey(art, art.rows), commands: commands.map((cmd) => scaled(cmd, s)) };
}

const star = (name: string, cx: number, cy: number, w: number, h: number, fill: string): Command => ['shape.create', { kind: 'star', sides: 4, starRatio: 0.28, rect: [cx - w / 2, cy - h / 2, w, h], fill, name }];

/**
 * A strip, like a shelf tag: a rounded frame, the title as a heading, then the lines side by side
 * (the size over its price), a single price large, deals and small print under them.
 */
function stripCommands(art: CardArt, fmt: PriceFormat): { height: number; commands: Command[] } {
  const c = art.theme.colors;
  const font = art.theme.font || 'Bahnschrift';
  const texts = cardTexts(art, fmt);
  const body: Command[] = [];
  const text = (name: string, x: number, y: number, size: number, color: string, extra: Record<string, unknown> = {}): void => {
    body.push(['type.create', { x, y, text: texts[name] ?? name, name, font, fontStyle: 'Bold', size, color, align: 'center', ...extra }]);
  };
  const ROOM = 840;
  // Without a heading the rows start lower, so they sit in the middle of the frame.
  let y = texts.Title ? 40 : 55;
  if (texts.Title) {
    text('Title', CARD_WIDTH / 2, y + 110, fit(texts.Title!, 20, ROOM, 300), c.ink, { tracking: 300 });
    y += 125;
  }
  const lines = art.rows.filter((r) => r.kind === 'line');
  if (lines.length) {
    const step = lines.length > 1 ? Math.min(300, ROOM / (lines.length - 1)) : 0;
    const size = Math.min(...lines.map((r) => fit(texts[`${r.id} label`]!, 26, Math.min(step || ROOM, ROOM) - 30, 100)));
    lines.forEach((r, i) => {
      const x = CARD_WIDTH / 2 + (i - (lines.length - 1) / 2) * step;
      text(`${r.id} label`, x, y + 110, size, c.ink, { tracking: 100 });
      text(`${r.id} price`, x, y + 205, 22, r.accent ? c.accent : c.ink);
    });
    y += 225;
  }
  for (const r of art.rows) {
    if (r.kind === 'price') {
      text(r.id, CARD_WIDTH / 2 + (art.centreNumber ? numberShift(fmt, 34, 100) : 0), y + 150, 34, c.ink, { tracking: 100 });
      y += 170;
    } else if (r.kind === 'deal') {
      text(`${r.id} qty`, 500, y + 75, 20, c.ink);
      body.push(['type.create', { x: 610, y: y + 75, text: 'FOR', name: `${r.id} for`, font, fontStyle: 'Bold', size: 14, color: c.ink, align: 'center', tracking: 360 }]);
      text(`${r.id} price`, 740, y + 75, 20, c.accent);
      y += 90;
    } else if (r.kind === 'note') {
      text(r.id, CARD_WIDTH / 2, y + 60, fit(texts[r.id]!, 12, ROOM, 120), c.ink, { tracking: 120 });
      y += 70;
    }
  }
  const height = Math.ceil((y + 85) / 2) * 2;
  const frame = { x: 40, y: 30, w: CARD_WIDTH - 80, h: height - 60 };
  return {
    height,
    commands: [
      ['shape.create', { kind: 'rect', rect: [0, 0, CARD_WIDTH + 10, height + 10], fill: c.bg, name: 'Background' }],
      ['shape.create', { kind: 'roundedRect', rect: [frame.x, frame.y, frame.w, frame.h], radii: Math.min(150, frame.h / 2), fill: null, stroke: { width: 14, color: c.frame, align: 'center' }, name: 'Frame' }],
      ...body,
      star('Sparkle', 170, 55, 100, 105, c.sparkle),
      star('Sparkle small', 118, 70, 40, 44, c.sparkle),
      star('Sparkle', 1155, height - 97, 85, 90, c.sparkle),
      star('Sparkle small', 1077, height - 46, 40, 42, c.sparkle),
    ],
  };
}

/** The card: a title band with the mascot on it, then the rows under each other. */
function cardCommands(art: CardArt, fmt: PriceFormat): { height: number; commands: Command[] } {
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
      const pt = fit(texts[r.id]!, 48, FRAME.width - 160, 100);
      text(r.id, CARD_WIDTH / 2 + (art.centreNumber ? numberShift(fmt, pt, 100) : 0), y + 170, pt, c.ink, { tracking: 100 });
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
  // Centred on the pill; the mascot sits past its right end, so a long title clears it.
  const titleRoom = art.mascot ? 560 : PILL.width - 80;
  const pillX = PILL.x + PILL.width / 2;
  /** Letter spacing follows the last letter too: half of it back keeps the word itself in the middle. */
  const centred = (pt: number, tracking: number): number => pillX + (tracking / 1000) * pt * PX_PER_PT / 2;
  const titlePt = fit(texts.Title!, art.subtitle ? 14 : 16, titleRoom, 360);
  const subPt = fit(art.subtitle, 10, titleRoom, 150);
  const head: Command[] = art.subtitle
    ? [
        // The name first, the small line under it: "DESKMAT", then "40x90cm".
        ['type.create', { x: centred(titlePt, 360), y: 196, text: texts.Title, name: 'Title', font, fontStyle: 'Bold', size: titlePt, color: c.title, align: 'center', tracking: 360 }],
        ['type.create', { x: centred(subPt, 150), y: 248, text: texts.Subtitle, name: 'Subtitle', font, fontStyle: 'Bold', size: subPt, color: c.title, align: 'center', tracking: 150 }],
      ]
    : [['type.create', { x: centred(titlePt, 360), y: 212, text: texts.Title, name: 'Title', font, fontStyle: 'Bold', size: titlePt, color: c.title, align: 'center', tracking: 360 }]];

  const commands: Command[] = [
    // Past the edges, so a scaled-down card rounding its height up has no strip without background.
    ['shape.create', { kind: 'rect', rect: [0, 0, CARD_WIDTH + 10, height + 10], fill: c.bg, name: 'Background' }],
    ['shape.create', { kind: 'roundedRect', rect: [FRAME.x, FRAME.top, FRAME.width, frameBottom - FRAME.top], radii: FRAME.radius, fill: null, stroke: { width: FRAME.stroke, color: c.frame, align: 'center' }, name: 'Frame' }],
    ['shape.create', { kind: 'roundedRect', rect: [PILL.x, PILL.y, PILL.width, PILL.height], radii: PILL.height / 2, fill: c.pill, name: 'Pill' }],
    ...body,
    ...head,
    star('Sparkle', 169, 182, 150, 160, c.sparkle),
    star('Sparkle small', 110, 298, 60, 66, c.sparkle),
    star('Sparkle', 1148, frameBottom - 108, 125, 135, c.sparkle),
    star('Sparkle small', 1034, frameBottom - 14, 60, 64, c.sparkle),
  ];
  if (art.mascot) {
    // Mascots are drawn at their own pixels, made smaller only when bigger than their corner; they sit past the pill's right end, over the frame's corner.
    const scale = Math.min(100, Math.floor((300 / Math.max(art.mascot.width, art.mascot.height)) * 100));
    commands.push(['file.placeEmbedded', { path: art.mascot.path, scale, smartObject: true, center: [1060, 174] }]);
  }
  return { height, commands };
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

/** How sheets are laid out. */
export interface SheetOptions {
  /** Fewest sheets: tallest first, each into the first gap on any sheet, widths sharing sheets. Else list order. */
  tight?: boolean;
  /** Thin crosses where the cards' corners are, on a layer of their own: where to cut. */
  marks?: boolean;
}
export interface SheetCard {
  key: string;
  width: number;
  height: number;
  /** Cards of one group (their theme, so their colour) go next to each other: a cut a little off shows no other colour. */
  group?: string;
}

export function packSheets(cards: SheetCard[], opts: SheetOptions = {}): Placed[] {
  return opts.tight ? packTight(cards) : packInOrder(cards);
}

/**
 * Cards in A4 pages of columns as wide as the cards, in order, each going to the column that ends
 * highest; a card that fits in none starts a new page, and so does each card width, so half and
 * third cards get pages of their own. A card taller than a page gets a page of its own.
 */
function packInOrder(cards: SheetCard[]): Placed[] {
  const out: Placed[] = [];
  let page = -1;
  for (const width of [...new Set(cards.map((c) => c.width))]) {
    const columns = Math.max(1, Math.floor(A4.width / width));
    let tops = Array<number>(columns).fill(0);
    page++;
    for (const card of cards.filter((c) => c.width === width)) {
      let col = tops.indexOf(Math.min(...tops));
      if (tops[col]! > 0 && tops[col]! + card.height > A4.height) {
        page++;
        tops = Array<number>(columns).fill(0);
        col = 0;
      }
      out.push({ key: card.key, page, x: col * width, y: tops[col]!, width: card.width, height: card.height });
      tops[col] = tops[col]! + card.height;
    }
  }
  return out;
}

/**
 * As few sheets as it takes: the widest cards first, a group's cards together (the group with the
 * most card height first), the tallest first, each into a column of its width with room, one
 * ending in its own group by preference, else the first; a column of a new width opens on any
 * sheet with the width left, so half cards and third strips share sheets.
 * ponytail: first fit decreasing per column, not an optimal 2D packing; enough for a few dozen cards.
 */
function packTight(cards: SheetCard[]): Placed[] {
  const groupKey = (c: SheetCard): string => `${c.width}|${c.group ?? ''}`;
  const groupHeight = new Map<string, number>();
  for (const c of cards) groupHeight.set(groupKey(c), (groupHeight.get(groupKey(c)) ?? 0) + c.height);
  const order = [...cards].sort(
    (a, b) => b.width - a.width || groupHeight.get(groupKey(b))! - groupHeight.get(groupKey(a))! || groupKey(a).localeCompare(groupKey(b)) || b.height - a.height,
  );
  const columns: { page: number; x: number; width: number; top: number; group?: string }[] = [];
  /** Width taken on each sheet. */
  const taken: number[] = [];
  const out: Placed[] = [];
  for (const card of order) {
    const room = columns.filter((c) => c.width === card.width && c.top + card.height <= A4.height);
    let col = room.find((c) => c.group === card.group) ?? room[0];
    if (!col) {
      let page = taken.findIndex((w) => w + card.width <= A4.width);
      if (page < 0) page = taken.push(0) - 1;
      col = { page, x: taken[page]!, width: card.width, top: 0 };
      taken[page] = taken[page]! + card.width;
      columns.push(col);
    }
    out.push({ key: card.key, page: col.page, x: col.x, y: col.top, width: card.width, height: card.height });
    col.top += card.height;
    col.group = card.group;
  }
  return out;
}

/** Thin grey crosses at every card corner, one shape layer "Cut marks" that can be hidden. */
export function cutMarks(placed: Placed[]): Command | null {
  const ARM = 30; // 2.5 mm each way at 300 ppi
  const LINE = 3; // 0.25 mm
  const corners = new Set(placed.flatMap((p) => [p.x, p.x + p.width].flatMap((x) => [p.y, p.y + p.height].map((y) => `${x},${y}`))));
  if (!corners.size) return null;
  const box = (x: number, y: number, w: number, h: number) => ({ closed: true, knots: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
  const subpaths = [...corners].flatMap((k) => {
    const [x, y] = k.split(',').map(Number) as [number, number];
    return [box(x - ARM, y - LINE / 2, ARM * 2, LINE), box(x - LINE / 2, y - ARM, LINE, ARM * 2)];
  });
  return ['shape.create', { kind: 'path', path: { subpaths, fillRule: 'nonzero' }, fill: '#808080', name: 'Cut marks' }];
}

/** One page's commands, for a new A4 document: each card placed as an embedded Smart Object, the cut marks on top. */
export function sheetCommands(placed: (Placed & { file: string })[], marks = false): Command[] {
  const cards: Command[] = placed.map((p) => ['file.placeEmbedded', { path: p.file, scale: 100, smartObject: true, center: [p.x + p.width / 2, p.y + p.height / 2] }]);
  const cut = marks ? cutMarks(placed) : null;
  return cut ? [...cards, cut] : cards;
}
