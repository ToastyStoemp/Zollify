import type { Product } from '@zollify/shared';
import { getAccount } from '../session';
import { getProduct, upsertProduct } from './catalog';
import { saveProductImage } from './images';
import { setOnHand } from './inventory';

/**
 * Sample products for a test account (see sandbox.ts on the server): enough
 * of a catalogue to try the till, stock, labels, customs and consignment
 * with - types, variants, costs and weights, a reduced-rate book, a one-off
 * original, a sold-out variant, something running low and something not for
 * sale. Each gets a drawn picture and a stock count.
 *
 * Ids are fixed, so filling again puts the samples back as they were rather
 * than adding a second set. Only ever offered in a test account.
 */

interface SampleVariant {
  id: string;
  name: string;
  price?: number;
  cost?: number;
  weightG?: number;
  stock: number;
}
interface Sample {
  id: string;
  title: string;
  type: string;
  price: number;
  cost?: number;
  weightG?: number;
  material?: string;
  stock?: number;
  variants?: SampleVariant[];
  /** Picture colours: background and ink. */
  colours: [string, string];
  extra?: Partial<Product>;
}

const ZODIAC = ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'];
const sizes = (cost: [number, number, number], stock: [number, number, number]): SampleVariant[] => [
  { id: 'a5', name: 'A5', price: 12, cost: cost[0], weightG: 20, stock: stock[0] },
  { id: 'a4', name: 'A4', price: 20, cost: cost[1], weightG: 40, stock: stock[1] },
  { id: 'a3', name: 'A3', price: 35, cost: cost[2], weightG: 80, stock: stock[2] },
];

export const SAMPLE_PRODUCTS: Sample[] = [
  { id: 'harbour-print', title: 'Harbour at dusk', type: 'Prints', price: 20, material: 'Paper', variants: sizes([1.5, 2.5, 4], [15, 20, 8]), colours: ['#24476b', '#f4c27a'], extra: { year: 2025 } },
  { id: 'fox-print', title: 'Sleeping fox', type: 'Prints', price: 20, material: 'Paper', variants: sizes([1.5, 2.5, 4], [10, 12, 3]), colours: ['#c4622d', '#fff4e6'], extra: { year: 2026 } },
  {
    id: 'zodiac-keychain',
    title: 'Zodiac keychain',
    type: 'Keychains',
    price: 8,
    cost: 2.2,
    weightG: 15,
    material: 'Acrylic',
    variants: ZODIAC.map((z) => ({ id: z.toLowerCase(), name: z, stock: z === 'Dragon' ? 2 : 6 })),
    colours: ['#7a4fa3', '#ffe680'],
  },
  { id: 'holo-stickers', title: 'Holo sticker pack', type: 'Stickers', price: 5, cost: 1.1, weightG: 10, material: 'Vinyl', stock: 60, colours: ['#2bb3a3', '#ffffff'] },
  { id: 'cat-sticker', title: 'Cat sticker', type: 'Stickers', price: 3, cost: 0.4, weightG: 4, material: 'Vinyl', stock: 100, colours: ['#f2a7b8', '#3b2433'] },
  { id: 'dragon-pin', title: 'Dragon enamel pin', type: 'Pins', price: 12, cost: 3, weightG: 12, material: 'Zinc alloy, hard enamel', stock: 25, colours: ['#1f6f43', '#f6d55c'] },
  { id: 'moth-pin', title: 'Moth enamel pin', type: 'Pins', price: 12, cost: 3, weightG: 12, material: 'Zinc alloy, soft enamel', stock: 3, colours: ['#4a4e69', '#f2e9e4'] },
  { id: 'postcards', title: 'Postcard set of 5', type: 'Postcards', price: 9, cost: 1.8, weightG: 60, material: 'Card', stock: 30, colours: ['#e9c46a', '#264653'] },
  { id: 'zine', title: 'Sketchbook zine vol. 1', type: 'Books', price: 15, cost: 4, weightG: 120, material: 'Paper', stock: 20, colours: ['#f4f1de', '#e07a5f'], extra: { taxClass: 'reduced' } },
  {
    id: 'tote',
    title: 'Tote bag',
    type: 'Bags',
    price: 22,
    cost: 6,
    weightG: 150,
    material: 'Cotton, 100%',
    variants: [
      { id: 'natural', name: 'Natural', stock: 10 },
      { id: 'black', name: 'Black', stock: 0 },
    ],
    colours: ['#d8c9a7', '#2b2b2b'],
  },
  { id: 'original', title: 'Night market (original)', type: 'Originals', price: 280, weightG: 900, material: 'Acrylic on canvas', stock: 1, colours: ['#14213d', '#fca311'], extra: { year: 2026 } },
  { id: 'standee', title: 'Acrylic standee', type: 'Merch', price: 18, cost: 4.5, weightG: 60, material: 'Acrylic', stock: 12, colours: ['#8ecae6', '#023047'] },
  { id: 'washi', title: 'Washi tape', type: 'Stationery', price: 6, cost: 1.2, weightG: 20, material: 'Paper', stock: 40, colours: ['#ffb4a2', '#6d6875'] },
  { id: 'display', title: 'Display stand', type: 'Booth', price: 0, stock: 2, colours: ['#adb5bd', '#212529'], extra: { forSale: false } },
];

const productId = (s: Sample): string => `sample-${s.id}`;

/** Initials on a coloured square - enough to tell the samples apart on the till. */
async function picture(s: Sample): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const [bg, ink] = s.colours;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.18;
  ctx.beginPath();
  ctx.arc(300, 110, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 150px sans-serif';
  const initials = s.title.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  ctx.fillText(initials, 200, 190);
  ctx.font = '600 30px sans-serif';
  ctx.fillText(s.type.toUpperCase(), 200, 330);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/**
 * Puts the sample products in this account: catalogue, pictures and stock.
 * Refused outside a test account, so a real catalogue never gets made-up
 * items. Returns how many products it wrote.
 */
export async function fillSampleCatalogue(): Promise<number> {
  if (getAccount()?.profile?.sandbox !== true) throw new Error('Sample products are only for a test account.');
  let order = 1000;
  for (const s of SAMPLE_PRODUCTS) {
    const id = productId(s);
    const existing = getProduct(id);
    const product: Product = {
      id,
      title: s.title,
      sku: `SMP-${s.id.toUpperCase().slice(0, 12)}`,
      type: s.type,
      forSale: true,
      unlisted: false,
      price: s.price,
      ...(s.cost !== undefined ? { cost: s.cost } : {}),
      ...(s.weightG !== undefined ? { weightG: s.weightG } : {}),
      ...(s.material ? { material: s.material } : {}),
      variants: (s.variants ?? []).map(({ stock: _stock, ...v }) => ({ ...v, sku: `SMP-${s.id.toUpperCase().slice(0, 8)}-${v.id.toUpperCase()}` })),
      sortOrder: order++,
      ...(existing?.imageId ? { imageId: existing.imageId } : {}),
      ...s.extra,
      updatedAt: Date.now(),
    };
    await upsertProduct(product);
    if (!product.imageId) {
      try {
        const blob = await picture(s);
        if (blob) await upsertProduct({ ...product, imageId: await saveProductImage(id, blob) });
      } catch {
        /* a picture is a nicety; the product is there without one */
      }
    }
    if (s.variants?.length) for (const v of s.variants) await setOnHand(id, v.id, v.stock);
    else await setOnHand(id, '', s.stock ?? 0);
  }
  return SAMPLE_PRODUCTS.length;
}
