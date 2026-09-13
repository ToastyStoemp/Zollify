/**
 * @zollify/ui — the shared visual layer.
 *
 * Components read `--zfy-*` tokens from tokens.css and never hard-code a
 * colour — that is the whole mechanism by which a restyle stays a token
 * change rather than a component rewrite.
 */

export const UI_TOKEN_PREFIX = '--zfy-';

/** Semantic intents components accept, so callers never pass raw colours. */
export type Intent = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export type Size = 'sm' | 'md' | 'lg';

/** Resolves a design token to its CSS custom-property reference. */
export function token(name: string, fallback?: string): string {
  const ref = `var(${UI_TOKEN_PREFIX}${name}`;
  return fallback ? `${ref}, ${fallback})` : `${ref})`;
}
