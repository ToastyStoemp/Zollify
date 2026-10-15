/**
 * Booth layouts from the Cube Studio configurator (artist alley panel planner).
 *
 * The configurator exports a "version 2" design: independent panels on a grid
 * of cells (`width` x `height` x `depth` cm each), plus optionally products and
 * a table. A layout file is never trusted - it is parsed field by field into
 * the slim shape below, unknown fields are dropped, and artwork and stand
 * meshes (the bulk of a booth save) are left out, so what rides on the event
 * stays small. Everything here is pure, so it is tested without a browser.
 */

/** Largest design file accepted; booth saves carry artwork and stand meshes. */
export const BOOTH_LAYOUT_MAX_BYTES = 25 * 1024 * 1024;
export const BOOTH_LAYOUT_MAX_PANELS = 1500;
export const BOOTH_LAYOUT_MAX_PRODUCTS = 200;

export type BoothPanelType = 'side' | 'shelf' | 'back';
export type BoothMaterial = 'mesh' | 'plastic';

export interface BoothPanel {
  type: BoothPanelType;
  /** Grid coordinates in cells; multiply by the cell size for cm. */
  x: number;
  y: number;
  z: number;
  /** Extent in cells along the panel's first and second axis (0.5 or 1). */
  u: number;
  v: number;
  material: BoothMaterial;
  color: string;
}

export interface BoothProduct {
  id: string;
  name: string;
  /** Size and position in cm; x/z are the centre, y the base height. */
  width: number;
  height: number;
  depth: number;
  x: number;
  y: number;
  z: number;
  /** Radians around the vertical axis. */
  rotation?: number;
  kind?: 'product' | 'hook' | 'acrylic' | 'stand';
}

export interface BoothLayout {
  /** The design's own name, from the configurator. */
  name: string;
  /** The file it was imported from, if it came from a file. */
  fileName?: string;
  importedAt: number;
  /** Size of one grid cell in cm. */
  width: number;
  height: number;
  depth: number;
  panels: BoothPanel[];
  products: BoothProduct[];
}

export type BoothLayoutParse = { ok: true; layout: BoothLayout } | { ok: false; error: string };

const fail = (error: string): BoothLayoutParse => ({ ok: false, error });
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const HEX = /^#[0-9a-f]{6}$/i;
const PANEL_TYPES: readonly string[] = ['side', 'shelf', 'back'];
const KINDS: readonly string[] = ['product', 'hook', 'acrylic', 'stand'];

/** Plain text only: no control characters, bounded length. */
const cleanName = (v: unknown, fallback: string, max = 80): string => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  return s || fallback;
};

const panelKey = (p: BoothPanel): string => `${p.type}:${p.x},${p.y},${p.z}:${p.u},${p.v}`;

/** Version 1 designs are a set of cubes; each contributes its sides, shelves and (optionally) back. */
function panelsFromCubes(raw: unknown, back: boolean): BoothPanel[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 300) return 'A design must contain 1-300 cubes.';
  const map = new Map<string, BoothPanel>();
  for (const c of raw as Record<string, unknown>[]) {
    if (!c || ![c.x, c.y, c.z].every(Number.isInteger)) return 'Invalid cube position.';
    const x = c.x as number;
    const y = c.y as number;
    const z = c.z as number;
    if (Math.abs(x) > 30 || y < 0 || y > 30 || Math.abs(z) > 30) return 'Invalid cube position.';
    if ((c.material !== 'mesh' && c.material !== 'plastic') || typeof c.color !== 'string' || !HEX.test(c.color)) {
      return 'Invalid panel appearance.';
    }
    const specs: [BoothPanelType, number, number, number][] = [['side', x, y, z], ['side', x + 1, y, z], ['shelf', x, y, z], ['shelf', x, y + 1, z]];
    if (back) specs.push(['back', x, y, z]);
    for (const [type, px, py, pz] of specs) {
      const panel: BoothPanel = { type, x: px, y: py, z: pz, u: 1, v: 1, material: c.material, color: c.color.toLowerCase() };
      if (!map.has(panelKey(panel))) map.set(panelKey(panel), panel);
    }
  }
  return [...map.values()];
}

function readPanels(raw: unknown): BoothPanel[] | string {
  if (!Array.isArray(raw) || raw.length > BOOTH_LAYOUT_MAX_PANELS) return `A design supports up to ${BOOTH_LAYOUT_MAX_PANELS} panels.`;
  const seen = new Set<string>();
  const out: BoothPanel[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || typeof p.type !== 'string' || !PANEL_TYPES.includes(p.type)) return 'Invalid panel position.';
    if (![p.x, p.y, p.z].every(isNum)) return 'Invalid panel position.';
    const x = p.x as number;
    const y = p.y as number;
    const z = p.z as number;
    const u = p.u ?? 1;
    const v = p.v ?? 1;
    if (!(u === 0.5 || u === 1) || !(v === 0.5 || v === 1)) return 'Invalid panel position.';
    if (Math.abs(x) > 31 || y < 0 || y > 31 || Math.abs(z) > 31) return 'Invalid panel position.';
    if ((p.material !== 'mesh' && p.material !== 'plastic') || typeof p.color !== 'string' || !HEX.test(p.color)) return 'Invalid panel appearance.';
    const panel: BoothPanel = { type: p.type as BoothPanelType, x, y, z, u: u as number, v: v as number, material: p.material, color: p.color.toLowerCase() };
    if (seen.has(panelKey(panel))) continue;
    seen.add(panelKey(panel));
    out.push(panel);
  }
  return out;
}

function readProducts(raw: unknown): BoothProduct[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > BOOTH_LAYOUT_MAX_PRODUCTS) return `A design supports up to ${BOOTH_LAYOUT_MAX_PRODUCTS} products.`;
  const out: BoothProduct[] = [];
  const ids = new Set<string>();
  for (const p of raw as Record<string, unknown>[]) {
    if (!p || typeof p.id !== 'string' || ids.has(p.id)) return 'Invalid product.';
    ids.add(p.id);
    for (const k of ['width', 'height', 'depth']) if (!isNum(p[k]) || (p[k] as number) <= 0 || (p[k] as number) > 300) return 'Invalid product size.';
    for (const k of ['x', 'y', 'z']) if (!isNum(p[k]) || Math.abs(p[k] as number) > 1500) return 'Invalid product position.';
    const product: BoothProduct = {
      id: p.id.slice(0, 80),
      name: cleanName(p.name, 'Product'),
      width: p.width as number,
      height: p.height as number,
      depth: p.depth as number,
      x: p.x as number,
      y: p.y as number,
      z: p.z as number,
    };
    if (isNum(p.rotation)) product.rotation = p.rotation;
    if (typeof p.kind === 'string' && KINDS.includes(p.kind)) product.kind = p.kind as BoothProduct['kind'];
    out.push(product);
  }
  return out;
}

/** Validates an exported Cube Studio design (version 1 or 2) and reduces it to a BoothLayout. */
export function parseBoothLayout(text: string, opts: { fileName?: string; now?: number } = {}): BoothLayoutParse {
  if (text.length > BOOTH_LAYOUT_MAX_BYTES) return fail('That file is too large to be a cube design.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('That is not a valid design file (it is not JSON).');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Choose a Cube Studio design file.');
  const r = raw as Record<string, unknown>;
  if (r.schema !== 'cube-studio') return fail('Choose a Cube Studio design file.');
  if (r.version !== 1 && r.version !== 2) return fail('This design file version is not supported. Re-export it from the configurator.');
  for (const k of ['width', 'height', 'depth']) {
    if (!isNum(r[k]) || (r[k] as number) < 10 || (r[k] as number) > 100) return fail('Cube dimensions must be between 10 and 100 cm.');
  }
  const panels = r.version === 2 ? readPanels(r.panels) : panelsFromCubes(r.cubes, r.back !== false);
  if (typeof panels === 'string') return fail(panels);
  const products = r.version === 2 ? readProducts(r.products) : [];
  if (typeof products === 'string') return fail(products);
  const layout: BoothLayout = {
    name: cleanName(r.name, 'Booth layout'),
    importedAt: opts.now ?? Date.now(),
    width: r.width as number,
    height: r.height as number,
    depth: r.depth as number,
    panels,
    products,
  };
  const fileName = opts.fileName ? cleanName(opts.fileName, '', 200) : '';
  if (fileName) layout.fileName = fileName;
  return { ok: true, layout };
}

/**
 * Re-checks a layout read back from storage or another device. Stored data is
 * as untrusted as an upload: anything that does not pass is treated as absent.
 */
export function sanitizeBoothLayout(value: unknown): BoothLayout | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const parsed = parseBoothLayout(JSON.stringify({ ...v, schema: 'cube-studio', version: 2 }), {
    fileName: typeof v.fileName === 'string' ? v.fileName : undefined,
    now: isNum(v.importedAt) ? v.importedAt : 0,
  });
  return parsed.ok ? parsed.layout : undefined;
}

// ── Derivation ──────────────────────────────────────────────────────────────

export interface BoothPartRow {
  /** Long and short edge in cm. */
  dims: [number, number];
  material: BoothMaterial;
  count: number;
}

export interface BoothSummary {
  panels: number;
  full: number;
  half: number;
  mesh: number;
  plastic: number;
  connectors: number;
  /** Overall size in cm; all zero for an empty layout. */
  footprint: { width: number; depth: number; height: number };
  parts: BoothPartRow[];
  products: { name: string; width: number; height: number; depth: number; kind?: BoothProduct['kind'] }[];
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** Panel corners in grid units, matching the configurator's connector positions. */
function corners(p: BoothPanel): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const a of [0, p.u]) {
    for (const b of [0, p.v]) {
      out.push(p.type === 'side' ? [p.x, p.y + b, p.z + a] : p.type === 'shelf' ? [p.x + a, p.y, p.z + b] : [p.x + a, p.y + b, p.z]);
    }
  }
  return out;
}

/** Real-world size of a panel in cm: [long edge, short edge]. */
function panelDims(p: BoothPanel, l: BoothLayout): [number, number] {
  const d: [number, number] = p.type === 'side' ? [l.depth * p.u, l.height * p.v] : p.type === 'shelf' ? [l.width * p.u, l.depth * p.v] : [l.width * p.u, l.height * p.v];
  return d[0] >= d[1] ? [r1(d[0]), r1(d[1])] : [r1(d[1]), r1(d[0])];
}

export function summarizeBoothLayout(layout: BoothLayout): BoothSummary {
  const rows = new Map<string, BoothPartRow>();
  const joints = new Set<string>();
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let full = 0;
  let mesh = 0;
  for (const p of layout.panels) {
    if (p.u * p.v === 1) full++;
    if (p.material === 'mesh') mesh++;
    const dims = panelDims(p, layout);
    const id = `${dims[0]}|${dims[1]}|${p.material}`;
    const row = rows.get(id) ?? { dims, material: p.material, count: 0 };
    row.count++;
    rows.set(id, row);
    for (const c of corners(p)) {
      joints.add(c.map((n) => n.toFixed(3)).join(','));
      min = [Math.min(min[0], c[0]), Math.min(min[1], c[1]), Math.min(min[2], c[2])];
      max = [Math.max(max[0], c[0]), Math.max(max[1], c[1]), Math.max(max[2], c[2])];
    }
  }
  const parts = [...rows.values()].sort((a, b) => b.dims[0] - a.dims[0] || b.dims[1] - a.dims[1] || a.material.localeCompare(b.material));
  return {
    panels: layout.panels.length,
    full,
    half: layout.panels.length - full,
    mesh,
    plastic: layout.panels.length - mesh,
    connectors: joints.size,
    footprint: layout.panels.length
      ? { width: r1((max[0] - min[0]) * layout.width), depth: r1((max[2] - min[2]) * layout.depth), height: r1((max[1] - min[1]) * layout.height) }
      : { width: 0, depth: 0, height: 0 },
    parts,
    products: layout.products.map((p) => ({ name: p.name, width: p.width, height: p.height, depth: p.depth, ...(p.kind ? { kind: p.kind } : {}) })),
  };
}

/** One line for an event tile, e.g. "12 panels · 90 x 60 x 120 cm". */
export function boothLayoutLabel(layout: BoothLayout): string {
  const s = summarizeBoothLayout(layout);
  const size = s.panels ? ` · ${s.footprint.width} x ${s.footprint.depth} x ${s.footprint.height} cm` : '';
  return `${s.panels} panel${s.panels === 1 ? '' : 's'}${size}`;
}

// ── Preview ─────────────────────────────────────────────────────────────────

export interface PreviewShape {
  kind: 'panel' | 'shelf' | 'product';
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  material?: BoothMaterial;
  label?: string;
}
export interface BoothPreview {
  /** Drawing space in cm. */
  width: number;
  height: number;
  shapes: PreviewShape[];
}
export type PreviewView = 'top' | 'front';

/**
 * A flat drawing of the layout: "top" looks down (back of the booth at the
 * top), "front" looks at the booth from the front. Panels are drawn as thin
 * bars where seen edge-on; products as boxes at their rotated footprint.
 */
export function boothPreview(layout: BoothLayout, view: PreviewView): BoothPreview {
  interface Box {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    shape: Omit<PreviewShape, 'x' | 'y' | 'w' | 'h'>;
  }
  const boxes: Box[] = [];
  const { width: W, height: H, depth: D } = layout;
  const panelXs = layout.panels.flatMap((p) => corners(p).map((c) => c[0] * W));
  const spread = panelXs.length ? Math.max(...panelXs) - Math.min(...panelXs) : W;
  const thick = Math.max(1.5, spread / 120);
  /** Gives a zero-width span (a panel seen edge-on) a visible thickness. */
  const bar = (lo: number, hi: number): [number, number] => (hi - lo < 1e-6 ? [lo - thick / 2, hi + thick / 2] : [lo, hi]);
  const order = { back: 0, shelf: 1, side: 2 };
  for (const p of [...layout.panels].sort((a, b) => order[a.type] - order[b.type])) {
    const cs = corners(p);
    const xs = cs.map((c) => c[0] * W);
    const vs = cs.map((c) => (view === 'top' ? c[2] * D : c[1] * H));
    const [x0, x1] = bar(Math.min(...xs), Math.max(...xs));
    const [y0, y1] = bar(Math.min(...vs), Math.max(...vs));
    boxes.push({ x0, x1, y0, y1, shape: { kind: p.type === 'shelf' && view === 'top' ? 'shelf' : 'panel', color: p.color, material: p.material } });
  }
  for (const p of layout.products) {
    const c = Math.abs(Math.cos(p.rotation ?? 0));
    const s = Math.abs(Math.sin(p.rotation ?? 0));
    const hx = (p.width * c + p.depth * s) / 2;
    const hz = (p.depth * c + p.width * s) / 2;
    const shape = { kind: 'product' as const, label: p.name };
    if (view === 'top') boxes.push({ x0: p.x - hx, x1: p.x + hx, y0: p.z - hz, y1: p.z + hz, shape });
    else boxes.push({ x0: p.x - hx, x1: p.x + hx, y0: p.y, y1: p.y + p.height, shape });
  }
  if (!boxes.length) return { width: 0, height: 0, shapes: [] };
  const minX = Math.min(...boxes.map((b) => b.x0));
  const maxX = Math.max(...boxes.map((b) => b.x1));
  const minV = Math.min(...boxes.map((b) => b.y0));
  const maxV = Math.max(...boxes.map((b) => b.y1));
  const pad = 5;
  const height = r1(maxV - minV + pad * 2);
  return {
    width: r1(maxX - minX + pad * 2),
    height,
    shapes: boxes.map((b) => ({
      ...b.shape,
      x: r1(b.x0 - minX + pad),
      // The front view is drawn with height going up, so flip it.
      y: r1(view === 'top' ? b.y0 - minV + pad : height - (b.y1 - minV + pad)),
      w: r1(b.x1 - b.x0),
      h: r1(b.y1 - b.y0),
    })),
  };
}

/**
 * The link to a hosted configurator, as typed in settings. Only http(s) is
 * kept, so the "open configurator" button can never carry a javascript: or
 * data: URL. Empty or unusable input means no link.
 */
export function normalizeConfiguratorUrl(input: string): string {
  const text = input.trim();
  if (!text || text.length > 500) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}
