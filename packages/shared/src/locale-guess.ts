import { COUNTRIES } from './countries';

/**
 * A first guess at where a new business is, from the device itself: its time
 * zone, then the region in its language settings. No location permission, no
 * network - both are plain settings any page can read. Only ever a prefill:
 * the person sees it and changes it when it is wrong (a seller abroad for a
 * convention has the convention's time zone).
 */

/** IANA time zone → ISO country, for the zones a single country owns. */
const ZONE_COUNTRY: Record<string, string> = {
  // Europe
  'Europe/Amsterdam': 'NL', 'Europe/Andorra': 'AD', 'Europe/Athens': 'GR', 'Europe/Belgrade': 'RS', 'Europe/Berlin': 'DE',
  'Europe/Bratislava': 'SK', 'Europe/Brussels': 'BE', 'Europe/Bucharest': 'RO', 'Europe/Budapest': 'HU', 'Europe/Busingen': 'DE',
  'Europe/Chisinau': 'MD', 'Europe/Copenhagen': 'DK', 'Europe/Dublin': 'IE', 'Europe/Helsinki': 'FI',
  'Europe/Istanbul': 'TR', 'Europe/Kyiv': 'UA', 'Europe/Kiev': 'UA', 'Europe/Lisbon': 'PT', 'Europe/Ljubljana': 'SI',
  'Europe/London': 'GB', 'Europe/Luxembourg': 'LU', 'Europe/Madrid': 'ES', 'Europe/Malta': 'MT', 'Europe/Monaco': 'MC',
  'Europe/Oslo': 'NO', 'Europe/Paris': 'FR', 'Europe/Podgorica': 'ME', 'Europe/Prague': 'CZ', 'Europe/Riga': 'LV',
  'Europe/Rome': 'IT', 'Europe/San_Marino': 'SM', 'Europe/Sarajevo': 'BA', 'Europe/Skopje': 'MK', 'Europe/Sofia': 'BG',
  'Europe/Stockholm': 'SE', 'Europe/Tallinn': 'EE', 'Europe/Tirane': 'AL', 'Europe/Vaduz': 'LI',
  'Europe/Vienna': 'AT', 'Europe/Vilnius': 'LT', 'Europe/Warsaw': 'PL', 'Europe/Zagreb': 'HR', 'Europe/Zurich': 'CH',
  'Europe/Minsk': 'BY', 'Europe/Moscow': 'RU', 'Atlantic/Reykjavik': 'IS', 'Atlantic/Canary': 'ES', 'Atlantic/Madeira': 'PT',
  'Atlantic/Azores': 'PT', 'Asia/Nicosia': 'CY', 'Europe/Nicosia': 'CY',
  // Elsewhere, the big ones
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US',
  'America/Anchorage': 'US', 'Pacific/Honolulu': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Shanghai': 'CN',
  'Asia/Taipei': 'TW', 'Asia/Singapore': 'SG', 'Asia/Bangkok': 'TH', 'Asia/Kolkata': 'IN', 'Asia/Dubai': 'AE', 'Asia/Jerusalem': 'IL',
  'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU',
  'Pacific/Auckland': 'NZ', 'Africa/Johannesburg': 'ZA',
};

/** ISO country → ISO currency, for the countries a seller here is likely in. */
const COUNTRY_CURRENCY: Record<string, string> = {
  // The euro area (Bulgaria from 2026), and the microstates that use it
  AT: 'EUR', BE: 'EUR', BG: 'EUR', HR: 'EUR', CY: 'EUR', EE: 'EUR', FI: 'EUR', FR: 'EUR', DE: 'EUR', GR: 'EUR', IE: 'EUR',
  IT: 'EUR', LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SK: 'EUR', SI: 'EUR', ES: 'EUR',
  AD: 'EUR', MC: 'EUR', SM: 'EUR', ME: 'EUR',
  CH: 'CHF', LI: 'CHF', DK: 'DKK', SE: 'SEK', NO: 'NOK', IS: 'ISK', GB: 'GBP', PL: 'PLN', CZ: 'CZK',
  HU: 'HUF', RO: 'RON', RS: 'RSD', BA: 'BAM', MK: 'MKD', AL: 'ALL', MD: 'MDL', UA: 'UAH', TR: 'TRY',
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', JP: 'JPY', KR: 'KRW', CN: 'CNY', TW: 'TWD', SG: 'SGD',
  TH: 'THB', IN: 'INR', AE: 'AED', IL: 'ILS', AU: 'AUD', NZ: 'NZD', ZA: 'ZAR',
};

const KNOWN = new Set(COUNTRIES.map((c) => c.code));

/** The country this device most likely sits in, as an ISO code; '' when nothing points anywhere. */
export function guessCountry(device: { timeZone?: string; languages?: readonly string[] }): string {
  const byZone = device.timeZone ? ZONE_COUNTRY[device.timeZone] : undefined;
  if (byZone) return byZone;
  // "de-CH" → CH. A bare "en" says nothing about where, and neither does "en-US":
  // it is what most English installs ship with, Europe included.
  for (const lang of device.languages ?? []) {
    if (/^en[-_]US$/i.test(lang)) continue;
    const region = /^[a-z]{2,3}[-_]([A-Z]{2})\b/i.exec(lang)?.[1]?.toUpperCase();
    if (region && KNOWN.has(region)) return region;
  }
  return '';
}

/** The currency a country sells in; '' when this list does not know it. */
export const currencyOf = (country: string): string => COUNTRY_CURRENCY[country] ?? '';

/** The guess for the device this runs on, with the country's name as the profile stores it. */
export function guessFromDevice(): { code: string; name: string; currency: string } | null {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const languages = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  const code = guessCountry({ timeZone, languages });
  const name = COUNTRIES.find((c) => c.code === code)?.name;
  return code && name ? { code, name, currency: currencyOf(code) } : null;
}

/** UTC offset of a zone at a moment, in minutes; null for a zone this runtime does not know. */
function offsetOf(zone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (!m) return name === 'GMT' ? 0 : null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/**
 * The time zone a country keeps, when it keeps one: every zone listed for it
 * agrees on the offset at `at`. Undefined for a country spread over several
 * (the US, Canada, Australia, Brazil) or one not listed - the caller then
 * has to judge without knowing the local clock.
 */
export function zoneOfCountry(code: string, at = Date.now()): string | undefined {
  const zones = Object.entries(ZONE_COUNTRY).filter(([, c]) => c === code).map(([z]) => z);
  if (!zones.length) return undefined;
  const offsets = new Set(zones.map((z) => offsetOf(z, at)));
  return offsets.size === 1 && !offsets.has(null) ? zones[0] : undefined;
}
