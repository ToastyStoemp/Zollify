/**
 * Device + (optional) geo enrichment for login sessions, shown in the sessions
 * overview. Device is parsed from the User-Agent (no network). Geo is OFF by
 * default; set GEO_LOOKUP=1 to resolve an approximate city/country from the IP
 * via ip-api.com (sends the login IP to a third party, hence opt-in).
 */

export function parseDevice(ua = ''): string {
  const s = String(ua);
  let os = 'Unknown OS';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let br = 'Unknown browser';
  if (/ZollTool|CapacitorHttp|okhttp/i.test(s)) br = 'ZollTool app';
  else if (/Edg\//.test(s)) br = 'Edge';
  else if (/OPR\/|Opera/.test(s)) br = 'Opera';
  else if (/Chrome\//.test(s) && !/Chromium/.test(s)) br = 'Chrome';
  else if (/Firefox\//.test(s)) br = 'Firefox';
  else if (/Safari\//.test(s) && /Version\//.test(s)) br = 'Safari';
  return `${br} on ${os}`;
}

const GEO_ON = process.env.GEO_LOOKUP === '1';
const cache = new Map<string, { at: number; geo: string | null }>();
const TTL = 24 * 60 * 60 * 1000;

function isPrivate(ip: string): boolean {
  if (!ip) return true;
  const s = ip.replace(/^::ffff:/, '');
  return (
    s === '127.0.0.1' || s === '::1' ||
    /^10\./.test(s) || /^192\.168\./.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s) ||
    /^fe80:/i.test(s) || /^f[cd]/i.test(s)
  );
}

/** Best-effort "City, Country" string or null. Never throws. */
export async function lookupGeo(ip: string): Promise<string | null> {
  if (!GEO_ON || isPrivate(ip)) return null;
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL) return hit.geo;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = (await res.json()) as { status?: string; country?: string; city?: string };
    const geo = j.status === 'success' ? [j.city, j.country].filter(Boolean).join(', ') || null : null;
    cache.set(ip, { at: Date.now(), geo });
    return geo;
  } catch {
    cache.set(ip, { at: Date.now(), geo: null });
    return null;
  }
}

export const geoEnabled = (): boolean => GEO_ON;
