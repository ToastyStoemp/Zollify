/**
 * Free, keyless exchange-rate lookup — ported from ZollTool. Only ever
 * prefills a convention's rate; nothing applies it without the seller
 * seeing the number first.
 */
export async function fetchExchangeRate(base: string, target: string): Promise<number | null> {
  const from = base.trim().toUpperCase();
  const to = target.trim().toUpperCase();
  if (!from || !to) return null;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: Record<string, unknown> };
    const rate = data.rates?.[to];
    return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
  } catch {
    return null;
  }
}
