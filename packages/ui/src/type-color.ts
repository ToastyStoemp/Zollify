/**
 * Whether dark tokens are the ones actually painting the page right now -
 * mirrors tokens.css's own cascade: an explicit data-theme wins outright,
 * otherwise it's whatever the OS reports (see packages/platform/theme.ts).
 */
function isDarkNow(): boolean {
  if (typeof document === 'undefined') return false;
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * A stable accent colour per product type, so a type reads the same on every
 * screen. 48% lightness is a solid mid-tone against a light/white surface but
 * reads as a washed-out, low-contrast smear against this app's dark surfaces
 * (~4.5:1 or worse for hues landing near the background's own blue) - dark
 * mode gets a lighter, slightly less saturated tone instead.
 *
 * `dark` defaults to the page's own current theme (see isDarkNow) - it's a
 * parameter rather than always read internally so this stays testable
 * without a DOM.
 */
export function typeColor(type: string | undefined | null, dark: boolean = isDarkNow()): string {
  if (!type) return 'var(--zfy-accent, #0e7c66)';
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return dark ? `hsl(${hue} 70% 72%)` : `hsl(${hue} 60% 48%)`;
}
