import type { Product, Variant } from '@zollify/shared';
import { allProducts, deleteImage, deleteProduct, saveProductImage, setOnHand, upsertProduct } from '@zollify/platform';

/**
 * A starter catalogue to try Zollify with: art prints in three sizes,
 * sticker sheets, a pin, a keychain, postcards, a tote - the things an
 * artist-alley table sells, with prices, SKUs, customs details and some stock.
 *
 * The pictures are drawn here, on the device, rather than fetched: the app's
 * content policy keeps it from loading images off other sites, a stock photo
 * of somebody else's art is not ours to hand out, and this way it works
 * offline at a convention too. Each is a flat illustration with the product's
 * name on it, so nobody mistakes an example for the real thing.
 *
 * Every example has an id starting `example-`, so adding them twice replaces
 * rather than duplicates, and "Remove examples" takes exactly these away.
 */

export const EXAMPLE_PREFIX = 'example-';
export const isExample = (p: Pick<Product, 'id'>): boolean => p.id.startsWith(EXAMPLE_PREFIX);

type Art = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

interface Example {
  slug: string;
  title: string;
  type: string;
  sku: string;
  price: number;
  variants?: { id: string; name: string; price: number; sku: string; weightG?: number }[];
  weightG: number;
  tariffNo: string;
  material: string;
  stock: number;
  /** Portrait for prints and cards, square for the rest. */
  portrait?: boolean;
  art: Art;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function gradient(ctx: CanvasRenderingContext2D, h: number, top: string, bottom: string): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ctx.canvas.width, h);
}
function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}
function poly(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: string): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
  }
  poly(ctx, pts, fill);
}
/** A sticker: the shape with a white die-cut border and a soft shadow. */
function sticker(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, draw: (r: number) => void): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.18)';
  ctx.shadowBlur = r * 0.15;
  ctx.shadowOffsetY = r * 0.06;
  circle(ctx, x, y, r, '#fff');
  ctx.restore();
  ctx.save();
  ctx.translate(x, y);
  draw(r * 0.86);
  ctx.restore();
}
function catFace(ctx: CanvasRenderingContext2D, r: number, fur: string): void {
  poly(ctx, [[-r * 0.8, -r * 0.2], [-r * 0.6, -r * 0.95], [-r * 0.15, -r * 0.55]], fur);
  poly(ctx, [[r * 0.8, -r * 0.2], [r * 0.6, -r * 0.95], [r * 0.15, -r * 0.55]], fur);
  circle(ctx, 0, 0, r * 0.78, fur);
  // A dark cat gets light eyes, or they vanish into its fur.
  const eye = /^#[0-4]/.test(fur) ? '#ffe08a' : '#1f1b2e';
  circle(ctx, -r * 0.28, -r * 0.08, r * 0.1, eye);
  circle(ctx, r * 0.28, -r * 0.08, r * 0.1, eye);
  poly(ctx, [[-r * 0.08, r * 0.12], [r * 0.08, r * 0.12], [0, r * 0.22]], '#e8708a');
}
function mushroom(ctx: CanvasRenderingContext2D, r: number, cap: string): void {
  ctx.fillStyle = '#f6ead7';
  ctx.fillRect(-r * 0.22, -r * 0.05, r * 0.44, r * 0.7);
  ctx.beginPath();
  ctx.ellipse(0, -r * 0.05, r * 0.75, r * 0.6, 0, Math.PI, 0);
  ctx.fillStyle = cap;
  ctx.fill();
  circle(ctx, -r * 0.3, -r * 0.3, r * 0.1, '#fff');
  circle(ctx, r * 0.2, -r * 0.42, r * 0.12, '#fff');
  circle(ctx, r * 0.42, -r * 0.15, r * 0.08, '#fff');
}
function frog(ctx: CanvasRenderingContext2D, r: number, skin: string): void {
  circle(ctx, -r * 0.38, -r * 0.42, r * 0.28, skin);
  circle(ctx, r * 0.38, -r * 0.42, r * 0.28, skin);
  ctx.beginPath();
  ctx.ellipse(0, r * 0.05, r * 0.82, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = skin;
  ctx.fill();
  circle(ctx, -r * 0.38, -r * 0.42, r * 0.13, '#fff');
  circle(ctx, r * 0.38, -r * 0.42, r * 0.13, '#fff');
  circle(ctx, -r * 0.38, -r * 0.42, r * 0.07, '#1f1b2e');
  circle(ctx, r * 0.38, -r * 0.42, r * 0.07, '#1f1b2e');
  ctx.beginPath();
  ctx.arc(0, r * 0.05, r * 0.35, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.strokeStyle = '#1f1b2e';
  ctx.lineWidth = r * 0.06;
  ctx.lineCap = 'round';
  ctx.stroke();
  circle(ctx, -r * 0.52, r * 0.1, r * 0.08, 'rgba(232,112,138,.6)');
  circle(ctx, r * 0.52, r * 0.1, r * 0.08, 'rgba(232,112,138,.6)');
}
function caption(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, color = 'rgba(31,27,46,.75)'): void {
  ctx.font = `600 ${Math.round(w * 0.045)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h - w * 0.05);
}

const mountains: Art = (ctx, w, h) => {
  gradient(ctx, h, '#ffb37a', '#f2627b');
  circle(ctx, w * 0.5, h * 0.45, w * 0.2, '#ffe3a3');
  poly(ctx, [[0, h * 0.7], [w * 0.3, h * 0.42], [w * 0.55, h * 0.66], [w * 0.75, h * 0.48], [w, h * 0.68], [w, h], [0, h]], '#6b3e75');
  poly(ctx, [[0, h * 0.82], [w * 0.22, h * 0.62], [w * 0.48, h * 0.8], [w * 0.8, h * 0.6], [w, h * 0.78], [w, h], [0, h]], '#3b2a55');
  caption(ctx, w, h, 'Mountain sunset · example', 'rgba(255,255,255,.8)');
};
const forestFox: Art = (ctx, w, h) => {
  gradient(ctx, h, '#cfe8d8', '#7fb89a');
  for (let i = 0; i < 7; i++) {
    const x = (i + 0.5) * (w / 7);
    const base = h * (0.62 + (i % 2) * 0.06);
    poly(ctx, [[x, base - h * 0.3], [x - w * 0.09, base], [x + w * 0.09, base]], i % 2 ? '#2f6b55' : '#3f8467');
  }
  ctx.fillStyle = '#5c8f5f';
  ctx.fillRect(0, h * 0.7, w, h * 0.3);
  // the fox: body, head, ears, tail
  ctx.beginPath();
  ctx.ellipse(w * 0.52, h * 0.78, w * 0.16, h * 0.06, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#e8743b';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w * 0.7, h * 0.74, w * 0.12, h * 0.035, -0.5, 0, Math.PI * 2);
  ctx.fill();
  circle(ctx, w * 0.36, h * 0.72, w * 0.08, '#e8743b');
  poly(ctx, [[w * 0.3, h * 0.7], [w * 0.31, h * 0.63], [w * 0.36, h * 0.68]], '#e8743b');
  poly(ctx, [[w * 0.42, h * 0.7], [w * 0.41, h * 0.63], [w * 0.36, h * 0.68]], '#e8743b');
  poly(ctx, [[w * 0.29, h * 0.735], [w * 0.36, h * 0.765], [w * 0.31, h * 0.75]], '#fff');
  circle(ctx, w * 0.335, h * 0.715, w * 0.01, '#1f1b2e');
  circle(ctx, w * 0.385, h * 0.715, w * 0.01, '#1f1b2e');
  caption(ctx, w, h, 'Fox in the forest · example', 'rgba(255,255,255,.85)');
};
const stickerSheet = (bg: string, items: ((ctx: CanvasRenderingContext2D, r: number) => void)[], label: string): Art => (ctx, w, h) => {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const cols = 3;
  const rows = 3;
  const cell = w / cols;
  for (let i = 0; i < cols * rows; i++) {
    const x = cell * (i % cols) + cell / 2;
    const y = (h * 0.9 / rows) * Math.floor(i / cols) + (h * 0.9) / rows / 2;
    sticker(ctx, x, y, cell * 0.38, (r) => items[i % items.length]!(ctx, r));
  }
  caption(ctx, w, h, label);
};
const holoStar: Art = (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  ['#a5f3fc', '#c4b5fd', '#f9a8d4', '#fde68a', '#a7f3d0'].forEach((c, i, a) => g.addColorStop(i / (a.length - 1), c));
  ctx.fillStyle = '#1f1b2e';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,.5)';
  ctx.shadowBlur = w * 0.05;
  star(ctx, w / 2, h * 0.46, w * 0.36, '#fff');
  ctx.restore();
  ctx.save();
  ctx.translate(0, 0);
  star(ctx, w / 2, h * 0.46, w * 0.32, 'transparent');
  ctx.clip();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  caption(ctx, w, h, 'Holo star sticker · example', 'rgba(255,255,255,.8)');
};
const moonPin: Art = (ctx, w, h) => {
  ctx.fillStyle = '#25213b';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 30; i++) circle(ctx, ((i * 137) % 97) / 97 * w, ((i * 61) % 89) / 89 * h * 0.85, w * 0.005 + (i % 3) * w * 0.002, '#fff8');
  circle(ctx, w * 0.5, h * 0.45, w * 0.3, '#d4a537');
  circle(ctx, w * 0.5, h * 0.45, w * 0.27, '#ffe08a');
  circle(ctx, w * 0.62, h * 0.38, w * 0.25, '#25213b');
  star(ctx, w * 0.7, h * 0.58, w * 0.05, '#ffe08a');
  caption(ctx, w, h, 'Moon enamel pin · example', 'rgba(255,255,255,.8)');
};
const frogCharm: Art = (ctx, w, h) => {
  gradient(ctx, h, '#fef3c7', '#fde68a');
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = w * 0.015;
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.16, w * 0.06, 0, Math.PI * 2);
  ctx.moveTo(w * 0.5, h * 0.22);
  ctx.lineTo(w * 0.5, h * 0.3);
  ctx.stroke();
  sticker(ctx, w * 0.5, h * 0.55, w * 0.28, (r) => frog(ctx, r, '#7bc67e'));
  caption(ctx, w, h, 'Frog acrylic keychain · example');
};
const postcards: Art = (ctx, w, h) => {
  ctx.fillStyle = '#efe7da';
  ctx.fillRect(0, 0, w, h);
  const cards: [string, string, number][] = [['#ffb37a', '#f2627b', -0.12], ['#cfe8d8', '#7fb89a', 0.04], ['#c4b5fd', '#6d5bd0', 0.14]];
  cards.forEach(([a, b, rot], i) => {
    ctx.save();
    ctx.translate(w * (0.3 + i * 0.2), h * (0.38 + i * 0.1));
    ctx.rotate(rot);
    ctx.shadowColor = 'rgba(0,0,0,.2)';
    ctx.shadowBlur = w * 0.02;
    ctx.fillStyle = '#fff';
    ctx.fillRect(-w * 0.22, -h * 0.15, w * 0.44, h * 0.3);
    ctx.shadowColor = 'transparent';
    const g = ctx.createLinearGradient(0, -h * 0.13, 0, h * 0.13);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.fillRect(-w * 0.2, -h * 0.13, w * 0.4, h * 0.26);
    circle(ctx, w * 0.08, -h * 0.04, w * 0.05, '#fff7');
    ctx.restore();
  });
  caption(ctx, w, h, 'Postcard set · example');
};
const tote: Art = (ctx, w, h) => {
  ctx.fillStyle = '#d9e4ef';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#e9dcc3';
  ctx.lineWidth = w * 0.035;
  ctx.beginPath();
  ctx.arc(w * 0.38, h * 0.28, w * 0.1, Math.PI, 0);
  ctx.moveTo(w * 0.72, h * 0.28);
  ctx.arc(w * 0.62, h * 0.28, w * 0.1, 0, Math.PI, true);
  ctx.stroke();
  ctx.fillStyle = '#f4ead6';
  ctx.fillRect(w * 0.2, h * 0.28, w * 0.6, h * 0.58);
  ctx.save();
  ctx.translate(w * 0.5, h * 0.57);
  catFace(ctx, w * 0.17, '#3b2a55');
  ctx.restore();
  caption(ctx, w, h, 'Canvas tote · example');
};

// ── The catalogue ────────────────────────────────────────────────────────────

const PRINT_SIZES = (base: string) => [
  { id: `${EXAMPLE_PREFIX}${base}-a5`, name: 'A5', price: 10, sku: `EX-${base.toUpperCase()}-A5`, weightG: 15 },
  { id: `${EXAMPLE_PREFIX}${base}-a4`, name: 'A4', price: 20, sku: `EX-${base.toUpperCase()}-A4`, weightG: 25 },
  { id: `${EXAMPLE_PREFIX}${base}-a3`, name: 'A3', price: 35, sku: `EX-${base.toUpperCase()}-A3`, weightG: 45 },
];

export const EXAMPLES: Example[] = [
  { slug: 'mountain-print', title: 'Mountain sunset print', type: 'Print', sku: 'EX-MTN', price: 20, variants: PRINT_SIZES('mtn'), weightG: 25, tariffNo: '4911.9100', material: 'Paper', stock: 8, portrait: true, art: mountains },
  { slug: 'fox-print', title: 'Fox in the forest print', type: 'Print', sku: 'EX-FOX', price: 20, variants: PRINT_SIZES('fox'), weightG: 25, tariffNo: '4911.9100', material: 'Paper', stock: 8, portrait: true, art: forestFox },
  { slug: 'cat-sheet', title: 'Cat sticker sheet', type: 'Sticker sheet', sku: 'EX-CATS', price: 6, weightG: 8, tariffNo: '4911.9100', material: 'Vinyl', stock: 25, art: stickerSheet('#fde2e4', [(c, r) => catFace(c, r, '#f2a65a'), (c, r) => catFace(c, r, '#3b2a55'), (c, r) => catFace(c, r, '#c9c3bd')], 'Cat sticker sheet · example') },
  { slug: 'mushroom-sheet', title: 'Mushroom sticker sheet', type: 'Sticker sheet', sku: 'EX-MUSH', price: 6, weightG: 8, tariffNo: '4911.9100', material: 'Vinyl', stock: 25, art: stickerSheet('#e7f0dc', [(c, r) => mushroom(c, r, '#e0533d'), (c, r) => mushroom(c, r, '#c97c3d'), (c, r) => mushroom(c, r, '#8f5bd0')], 'Mushroom sticker sheet · example') },
  { slug: 'holo-star', title: 'Holo star sticker', type: 'Sticker', sku: 'EX-STAR', price: 2.5, weightG: 3, tariffNo: '4911.9100', material: 'Holographic vinyl', stock: 50, art: holoStar },
  { slug: 'moon-pin', title: 'Moon enamel pin', type: 'Pin', sku: 'EX-MOON', price: 12, weightG: 12, tariffNo: '7117.1900', material: 'Zinc alloy, hard enamel', stock: 15, art: moonPin },
  {
    slug: 'frog-keychain', title: 'Frog acrylic keychain', type: 'Keychain', sku: 'EX-FROG', price: 9, weightG: 10, tariffNo: '3926.4000', material: 'Acrylic', stock: 10, art: frogCharm,
    variants: [
      { id: `${EXAMPLE_PREFIX}frog-green`, name: 'Green', price: 9, sku: 'EX-FROG-G' },
      { id: `${EXAMPLE_PREFIX}frog-pink`, name: 'Pink', price: 9, sku: 'EX-FROG-P' },
    ],
  },
  { slug: 'postcards', title: 'Postcard set (3)', type: 'Postcard', sku: 'EX-POST', price: 8, weightG: 30, tariffNo: '4909.0000', material: 'Card stock', stock: 20, art: postcards },
  { slug: 'cat-tote', title: 'Cat canvas tote bag', type: 'Tote bag', sku: 'EX-TOTE', price: 18, weightG: 120, tariffNo: '4202.2290', material: 'Cotton, 100%', stock: 6, art: tote },
];

/** One example's picture, drawn on a canvas and encoded as a PNG. */
export async function drawExample(e: Pick<Example, 'art' | 'portrait'>): Promise<Blob> {
  const w = 800;
  const h = e.portrait ? 1130 : 800;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This device cannot draw the example pictures.');
  e.art(ctx, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the example picture.'))), 'image/png'));
}

/**
 * Adds the examples to the catalogue, with a picture and some stock each.
 * Already there (by id): replaced, so adding twice never duplicates.
 * `onProgress` gets the count done so far, for a progress line.
 */
export async function addExampleProducts(onProgress?: (done: number, total: number) => void): Promise<number> {
  const startOrder = allProducts.value.filter((p) => !isExample(p)).length;
  let done = 0;
  for (const [i, e] of EXAMPLES.entries()) {
    const id = `${EXAMPLE_PREFIX}${e.slug}`;
    const before = allProducts.value.find((p) => p.id === id);
    const imageId = await saveProductImage(id, await drawExample(e));
    const variants: Variant[] = (e.variants ?? []).map((v) => ({ id: v.id, name: v.name, price: v.price, sku: v.sku, ...(v.weightG ? { weightG: v.weightG } : {}) }));
    const product: Product = {
      id,
      title: e.title,
      sku: e.sku,
      type: e.type,
      forSale: true,
      unlisted: false,
      price: e.price,
      weightG: e.weightG,
      tariffNo: e.tariffNo,
      originCountry: 'DE',
      material: e.material,
      variants,
      imageId,
      sortOrder: startOrder + i,
      updatedAt: Date.now(),
    } as Product;
    await upsertProduct(product);
    if (before?.imageId && before.imageId !== imageId) await deleteImage(before.imageId).catch(() => undefined);
    if (variants.length) for (const v of variants) await setOnHand(id, v.id, e.stock);
    else await setOnHand(id, null, e.stock);
    onProgress?.(++done, EXAMPLES.length);
  }
  return done;
}

/** Takes every example back out, pictures included. Sales already made with them stay in the history. */
export async function removeExampleProducts(): Promise<number> {
  const examples = allProducts.value.filter(isExample);
  for (const p of examples) {
    await deleteProduct(p.id);
    for (const imageId of [p.imageId, ...p.variants.map((v) => v.imageId)]) if (imageId) await deleteImage(imageId).catch(() => undefined);
  }
  return examples.length;
}
