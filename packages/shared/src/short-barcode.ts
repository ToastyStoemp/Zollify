/**
 * A short, semi-random barcode payload derived from a product/variant's own
 * IDs - not a stored field, not user-editable. The same product+variant
 * always derives the same code, so the label printer and the POS camera
 * scanner's decode-to-product lookup can each recompute it independently;
 * nothing needs to be persisted or kept in sync.
 *
 * The point is length: a real SKU (e.g. "PN-2508-EP-COW-02", 18 chars) is
 * long for a small label - Code128 costs roughly 11 modules per character,
 * so a long SKU forces thin bars to fit a 40mm label, which is a real
 * contributor to unreliable scans (both by a camera and visually). This
 * code is 7 characters, so the same label gets proportionally much wider,
 * more scannable bars for the same physical width. The full SKU still
 * prints as the human-readable text underneath - only the bars' payload
 * changes.
 */

/** FNV-1a, 32-bit - fast, deterministic, no dependency; the exact hash function doesn't matter here, only that it's stable and spreads its input evenly. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Normalized here, once, rather than trusting every caller to apply the
// same "Other" fallback before calling in - two call sites (the label
// printer, the POS scan-to-product lookup) disagreeing on that would
// silently break the lookup for any product with no type set.
const prefixFor = (type: string | undefined): string => (type?.trim() || 'Other').charAt(0).toUpperCase();
const suffixFor = (input: string): string => fnv1a(input).toString(36).toUpperCase().padStart(6, '0');

/**
 * `type`'s first letter as a human-glanceable prefix (purely cosmetic - two
 * products of the same type still get different codes from the hash), then
 * 6 base36 digits from a hash of productId+variantId. ~2.2 billion possible
 * suffixes is comfortably collision-free at any real shop's catalog size.
 * The type is deliberately not hashed: renaming a type must not invalidate
 * labels already printed.
 */
export function shortBarcode(type: string | undefined, productId: string, variantId?: string): string {
  return `${prefixFor(type)}${suffixFor(`${productId}:${variantId ?? ''}`)}`;
}

/** The original formula, which hashed the type as well. Only for matching labels printed before the change. */
export function legacyShortBarcode(type: string | undefined, productId: string, variantId?: string): string {
  const normalizedType = type?.trim() || 'Other';
  return `${prefixFor(normalizedType)}${suffixFor(`${normalizedType}:${productId}:${variantId ?? ''}`)}`;
}

/**
 * Whether a scanned code is this product's label: the current code with any
 * prefix letter (the type may have been renamed since printing), or the
 * legacy code. Case-insensitive, since scanners and search boxes vary.
 */
export function matchesShortBarcode(code: string, type: string | undefined, productId: string, variantId?: string): boolean {
  const scanned = code.trim().toUpperCase();
  if (!scanned) return false;
  return scanned.slice(1) === shortBarcode(type, productId, variantId).slice(1) || scanned === legacyShortBarcode(type, productId, variantId);
}
