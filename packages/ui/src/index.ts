/**
 * @boothly/ui — the shared visual layer.
 *
 * Tokens are carried over from ZollDesign so the platform is unblocked, and the
 * Boothly visual identity becomes a token-level change rather than a component
 * rewrite. Components must read `--bly-*` (aliased to the inherited `--zui-*`
 * values in tokens.css) and never hard-code a colour — that is the whole
 * mechanism by which a restyle stays cheap.
 */

export const UI_TOKEN_PREFIX = '--bly-';

/** Semantic intents components accept, so callers never pass raw colours. */
export type Intent = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export type Size = 'sm' | 'md' | 'lg';

/** Resolves a design token to its CSS custom-property reference. */
export function token(name: string, fallback?: string): string {
  const ref = `var(${UI_TOKEN_PREFIX}${name}`;
  return fallback ? `${ref}, ${fallback})` : `${ref})`;
}
