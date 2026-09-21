/**
 * Type-specific extra fields for customs. Detected by the catalog Type:
 *  - "Art Print" → a production Year; customs lists it as "Title (Year)".
 *  - "Purse"     → a Material composition; customs lists it as "Title - Material".
 * Matching is case-insensitive and tolerates plurals / a missing space.
 * Mirrors customs-ch/src/lib/artwork.ts - not imported from it (separate
 * installable modules), but the same small rule, so kept identical.
 */
export const isArtwork = (type?: string | null): boolean => /^art\s*prints?$/i.test((type ?? '').trim());
export const isPurse = (type?: string | null): boolean => /^purses?$/i.test((type ?? '').trim());
