/**
 * Packing checklist model - one shared template (what to bring, edited once)
 * plus one check/uncheck state per convention (sales event), so every event
 * starts from a fresh unchecked copy of the same list. Both are synced
 * account-wide via sdk.data.settings.
 */

export type ChecklistItem =
  | { id: string; kind: 'supply'; label: string; group?: string }
  /** `productType` matches Product.type - checked against the live catalog rather than one SKU, since these are almost always a whole category (e.g. "all the pins"), not a single product. */
  | { id: string; kind: 'product'; label: string; group?: string; productType: string };

export type ChecklistState = Record<string, boolean>;

export const TEMPLATE_KEY = 'convention-checklist.template';
const STATE_KEY_PREFIX = 'convention-checklist.state.';

export function stateKey(eventId: string): string {
  return `${STATE_KEY_PREFIX}${eventId}`;
}

/** Slugified label - stable and readable; fine here since every seed label is distinct. New items added later use a random id instead (see PackingChecklistView.vue). */
function slugId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function supply(label: string, group?: string): ChecklistItem {
  return { id: slugId(label), kind: 'supply', label, group };
}

/** Seeded once from the booth's own paper checklist - editable from here on, this is only ever the starting point for a first-time setup. */
export const DEFAULT_TEMPLATE: ChecklistItem[] = [
  supply('Card reader'),
  supply('Backup card reader'),
  supply('Powerbank'),
  supply('Screw driver'),
  supply('Business cards'),
  supply('Mesh frame and opaque frame'),
  supply('Parking ticket'),
  supply('Clamp poles'),
  supply('Fan'),
  supply('Watercolor box'),
  supply('Vending machine display'),

  supply('Paper bags', 'Consumables'),
  supply('Change', 'Consumables'),

  supply('Prints', 'Prints'),
  supply('Large prints', 'Prints'),
  supply('Big frame 90x45', 'Prints'),
  supply('Medium prints', 'Prints'),
  supply('Small prints', 'Prints'),

  supply('Stickers book', 'Merch'),
  supply('Hats', 'Merch'),
  supply('Pins', 'Merch'),
  supply('Keychains', 'Merch'),
  supply('Stickers + sticker sheets', 'Merch'),
  supply('Notepads', 'Merch'),
  supply('Egg pouches', 'Merch'),
  supply('Shakers', 'Merch'),
  supply('Extra keychains', 'Merch'),
  supply('Bear bags & wallets', 'Merch'),
  supply('Mousepads & deskmats', 'Merch'),

  supply('Decoration wall', 'Set up'),
  supply('Decoration pillars', 'Set up'),
  supply('Decoration roof', 'Set up'),
  supply('Decoration tube', 'Set up'),
  supply('Backdrop', 'Set up'),
  supply('Backdrop stand', 'Set up'),
  supply('Wooden print stand', 'Set up'),
  supply('Acrylic stand', 'Set up'),
  supply('Table cloth', 'Set up'),
  supply('Logo cloth', 'Set up'),
  supply('Large decorations', 'Set up'),
  supply('Mounting clamps', 'Set up'),
  supply('Large clamps', 'Set up'),
  supply('Mounting magnets', 'Set up'),
  supply('Bamboo fan', 'Set up'),
  supply('Logo stickers', 'Set up'),
  supply('Wrapping sleeve', 'Set up'),
  supply('Gachapon machine', 'Set up'),
  supply('Knife or scissors', 'Set up'),
  supply('Tape', 'Set up'),
  supply('Extra chair', 'Set up'),
  supply('Extra table', 'Set up'),
  supply('Cover sheet', 'Set up'),
  supply('Multi plug', 'Set up'),
  supply('Hooks + strings', 'Set up'),
  supply('Stamp + poster + stickers + sleeve for stamp rally', 'Set up'),
  supply('The dolly', 'Set up'),
  supply('Sleeve for deskmats', 'Set up'),
  supply('Plug adapter', 'Set up'),
];

/** Groups items in first-seen order; ungrouped items form a leading group with `group: undefined`. */
export function groupItems(items: ChecklistItem[]): { group: string | undefined; items: ChecklistItem[] }[] {
  const order: (string | undefined)[] = [];
  const byGroup = new Map<string | undefined, ChecklistItem[]>();
  for (const item of items) {
    if (!byGroup.has(item.group)) {
      order.push(item.group);
      byGroup.set(item.group, []);
    }
    byGroup.get(item.group)!.push(item);
  }
  return order.map((group) => ({ group, items: byGroup.get(group)! }));
}

export function progress(items: ChecklistItem[], state: ChecklistState): { done: number; total: number } {
  return { done: items.filter((i) => state[i.id]).length, total: items.length };
}
