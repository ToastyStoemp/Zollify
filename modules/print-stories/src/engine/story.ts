/**
 * A print's story: a short introduction and numbered points of interest on
 * its picture, each with a label and a description.
 *
 * Points use the Shopify theme's "Painting hotspots" format field for field
 * (`id`, `label`, `description`, `x`, `y`, `image`, `image_alt`), x and y in
 * percent of the picture from its top left corner. That format is what the
 * product metafield `custom.hotspots` holds, so a story's points copy into
 * the storefront as they are and come back the same way.
 */

export interface StoryPoint {
  id: string;
  label: string;
  description: string;
  /** Percent of the picture's width, 0 to 100, from the left. */
  x: number;
  /** Percent of the picture's height, 0 to 100, from the top. */
  y: number;
  /** A close-up or reference picture, as a URL. */
  image?: string;
  image_alt?: string;
}

export interface PrintStory {
  productId: string;
  /** A few lines on the print as a whole, for the story card. */
  intro: string;
  points: StoryPoint[];
  updatedAt: number;
}

/** The synced setting key of one product's story: one key per product, so two devices editing different prints never overwrite each other. */
export const STORY_PREFIX = 'print-stories.story.';
export const storyKey = (productId: string): string => STORY_PREFIX + productId;

export function emptyStory(productId: string): PrintStory {
  return { productId, intro: '', points: [], updatedAt: 0 };
}

/** Two decimals, as the theme's own editor writes them, kept inside the picture. */
export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
}

/** A point id that is not taken yet: detail-1, detail-2, ... as the theme's editor names them. */
export function nextPointId(points: readonly StoryPoint[]): string {
  const taken = new Set(points.map((p) => p.id));
  let n = points.length + 1;
  while (taken.has(`detail-${n}`)) n++;
  return `detail-${n}`;
}

export function addPoint(story: PrintStory, x: number, y: number, label = ''): PrintStory {
  const point: StoryPoint = { id: nextPointId(story.points), label, description: '', x: clampPercent(x), y: clampPercent(y) };
  return { ...story, points: [...story.points, point] };
}

export function updatePoint(story: PrintStory, id: string, patch: Partial<Omit<StoryPoint, 'id'>>): PrintStory {
  return {
    ...story,
    points: story.points.map((p) => {
      if (p.id !== id) return p;
      const next = { ...p, ...patch };
      if (patch.x !== undefined) next.x = clampPercent(patch.x);
      if (patch.y !== undefined) next.y = clampPercent(patch.y);
      return next;
    }),
  };
}

export function removePoint(story: PrintStory, id: string): PrintStory {
  return { ...story, points: story.points.filter((p) => p.id !== id) };
}

/** Moves a point one place up (-1) or down (+1) in the numbering. */
export function movePoint(story: PrintStory, id: string, by: -1 | 1): PrintStory {
  const i = story.points.findIndex((p) => p.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= story.points.length) return story;
  const points = [...story.points];
  [points[i], points[j]] = [points[j]!, points[i]!];
  return { ...story, points };
}

/** Whether a story has anything in it worth keeping or showing. */
export function hasStory(story: PrintStory | undefined): boolean {
  return !!story && (story.intro.trim() !== '' || story.points.length > 0);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/**
 * Reads a stored story back, whatever shape an older or foreign writer left:
 * anything unreadable is dropped rather than failing the whole list.
 */
export function normalizeStory(productId: string, raw: unknown): PrintStory {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const points = parseHotspots(r.points);
  return {
    productId,
    intro: str(r.intro),
    points: points.ok ? points.points : [],
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

/**
 * The points as the Shopify metafield `custom.hotspots` wants them: the
 * theme's field names, optional fields left out when empty, pretty-printed
 * like the theme's own edit mode.
 */
export function toShopifyHotspots(points: readonly StoryPoint[]): string {
  const out = points.map((p) => {
    const o: Record<string, string | number> = { id: p.id, label: p.label, description: p.description, x: clampPercent(p.x), y: clampPercent(p.y) };
    if (p.image) {
      o.image = p.image;
      if (p.image_alt) o.image_alt = p.image_alt;
    }
    return o;
  });
  return JSON.stringify(out, null, 2);
}

export type ParsedHotspots = { ok: true; points: StoryPoint[] } | { ok: false; error: string };

/**
 * Reads the metafield's JSON (or an array already parsed) into points. Ids
 * missing or repeated are given fresh ones; a point without a position is
 * an error, since it would land in a corner without anyone noticing.
 */
export function parseHotspots(input: unknown): ParsedHotspots {
  let data = input;
  if (typeof input === 'string') {
    if (!input.trim()) return { ok: true, points: [] };
    try {
      data = JSON.parse(input);
    } catch {
      return { ok: false, error: 'That is not JSON. Copy the whole value of the Painting hotspots metafield, from [ to ].' };
    }
  }
  if (data == null) return { ok: true, points: [] };
  if (!Array.isArray(data)) return { ok: false, error: 'Expected a list of points, starting with [.' };
  const points: StoryPoint[] = [];
  for (const [i, item] of data.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: `Point ${i + 1} is not an object.` };
    const o = item as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    if (o.x === undefined || o.y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, error: `Point ${i + 1}${str(o.label) ? ` (${str(o.label)})` : ''} has no x and y.` };
    }
    let id = str(o.id).trim();
    if (!id || points.some((p) => p.id === id)) id = nextPointId(points);
    const point: StoryPoint = { id, label: str(o.label), description: str(o.description), x: clampPercent(x), y: clampPercent(y) };
    const image = str(o.image).trim();
    if (image) {
      point.image = image;
      const alt = str(o.image_alt).trim();
      if (alt) point.image_alt = alt;
    }
    points.push(point);
  }
  return { ok: true, points };
}
