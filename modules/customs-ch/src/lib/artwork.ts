/**
 * Type-specific extra field for customs. Detected by the catalog Type:
 *  - "Art Print" → a production Year; customs lists it as "Title (Year)".
 * Material (any type but art prints) is not type-detected - it's just
 * whatever the product has on file, customs lists it as "Title - Material".
 * Matching is case-insensitive and tolerates plurals / a missing space.
 */
export const isArtwork = (type?: string | null): boolean => /^art\s*prints?$/i.test((type ?? '').trim());
