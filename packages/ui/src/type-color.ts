/** A stable accent colour per product type, so a type reads the same on every screen. */
export function typeColor(type: string | undefined | null): string {
  if (!type) return 'var(--zfy-accent, #0e7c66)';
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 60% 48%)`;
}
