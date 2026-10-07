/**
 * Webstore and social links, as shown on the receipt footer.
 *
 * What a booth types here ends up as a link on a page strangers open, so it is
 * cleaned once, on the server: https only, no credentials, no whitespace,
 * bounded length. Instagram and TikTok also take a bare handle, which becomes
 * the canonical profile URL.
 */

/**
 * The webstore and social links. They live on the business profile - one place
 * to edit them - and the receipt only reads them.
 */
export interface ProfileLinks {
  webstore: string;
  instagram: string;
  tiktok: string;
  facebook: string;
  bluesky: string;
  mastodon: string;
  youtube: string;
  otherUrl: string;
  otherLabel: string;
}

/** What only the receipt decides: whether the links reach paper, and whether next events show. */
export interface ReceiptToggles {
  /** Print the links as plain text lines on the thermal receipt. Default off: paper is tight. */
  showOnPrint: boolean;
  /** List the next public events on the online receipt. Needs the public-events page to be published. */
  showEvents: boolean;
}

export interface ReceiptSocials extends ProfileLinks, ReceiptToggles {}

export const EMPTY_PROFILE_LINKS: ProfileLinks = {
  webstore: '',
  instagram: '',
  tiktok: '',
  facebook: '',
  bluesky: '',
  mastodon: '',
  youtube: '',
  otherUrl: '',
  otherLabel: '',
};

export const EMPTY_RECEIPT_SOCIALS: ReceiptSocials = {
  ...EMPTY_PROFILE_LINKS,
  showOnPrint: false,
  showEvents: false,
};

export const RECEIPT_URL_MAX = 200;
export const RECEIPT_LABEL_MAX = 30;

type UrlKey = 'webstore' | 'instagram' | 'tiktok' | 'facebook' | 'bluesky' | 'mastodon' | 'youtube' | 'otherUrl';

export const LINK_URL_KEYS: UrlKey[] = ['webstore', 'instagram', 'tiktok', 'facebook', 'bluesky', 'mastodon', 'youtube', 'otherUrl'];
const HANDLE_RE = /^@?([A-Za-z0-9._]{1,30})$/;
const HANDLE_URL: Partial<Record<UrlKey, (h: string) => string>> = {
  instagram: (h) => `https://www.instagram.com/${h}`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
};
const FIELD_NAME: Record<UrlKey, string> = {
  webstore: 'Webstore',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  youtube: 'YouTube',
  otherUrl: 'The other link',
};

/** A clean https URL, or an Error naming what is wrong. Blank in, blank out. */
function cleanUrl(key: UrlKey, value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${FIELD_NAME[key]} must be text.`);
  const raw = value.trim();
  if (!raw) return '';
  const handle = HANDLE_URL[key] && HANDLE_RE.exec(raw);
  if (handle) return HANDLE_URL[key]!(handle[1]!);
  if (raw.length > RECEIPT_URL_MAX) throw new Error(`${FIELD_NAME[key]} is too long (max ${RECEIPT_URL_MAX} characters).`);
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) throw new Error(`${FIELD_NAME[key]} must be a single link.`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${FIELD_NAME[key]} must be a link starting with https://`);
  }
  if (u.protocol !== 'https:') throw new Error(`${FIELD_NAME[key]} must be a link starting with https://`);
  if (u.username || u.password) throw new Error(`${FIELD_NAME[key]} must not contain a login.`);
  if (!u.hostname.includes('.')) throw new Error(`${FIELD_NAME[key]} must be a full web address.`);
  return u.toString();
}

/** Validate and normalise the links. Throws an Error with a message fit to show. */
export function cleanProfileLinks(input: unknown): ProfileLinks {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: ProfileLinks = { ...EMPTY_PROFILE_LINKS };
  for (const key of LINK_URL_KEYS) out[key] = cleanUrl(key, src[key]);
  if (src.otherLabel != null && typeof src.otherLabel !== 'string') throw new Error('The other link label must be text.');
  const label = String(src.otherLabel ?? '').replace(/\s+/g, ' ').trim();
  if (label.length > RECEIPT_LABEL_MAX) throw new Error(`The other link label is too long (max ${RECEIPT_LABEL_MAX} characters).`);
  out.otherLabel = out.otherUrl ? label || 'More' : '';
  return out;
}

/** Whether any link is set. */
export const hasProfileLinks = (l: Partial<ProfileLinks> | null | undefined): boolean => !!l && LINK_URL_KEYS.some((k) => !!l[k]);

/** The receipt-only switches; anything but `true` is off. */
export function cleanReceiptToggles(input: unknown): ReceiptToggles {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return { showOnPrint: src.showOnPrint === true, showEvents: src.showEvents === true };
}

/** Links and switches together, as the first version of the receipt settings stored them. */
export function cleanReceiptSocials(input: unknown): ReceiptSocials {
  return { ...cleanProfileLinks(input), ...cleanReceiptToggles(input) };
}

export interface ReceiptFooterLink {
  label: string;
  url: string;
}

/** The links in display order, labelled. Blank ones are left out. */
export function receiptFooterLinks(s: ProfileLinks): ReceiptFooterLink[] {
  const rows: [string, string][] = [
    ['Webstore', s.webstore],
    ['Instagram', s.instagram],
    ['TikTok', s.tiktok],
    ['Facebook', s.facebook],
    ['Bluesky', s.bluesky],
    ['Mastodon', s.mastodon],
    ['YouTube', s.youtube],
    [s.otherLabel || 'More', s.otherUrl],
  ];
  return rows.filter(([, url]) => url).map(([label, url]) => ({ label, url }));
}

/** A link as short plain text for paper: no scheme, no trailing slash. */
export function printableLink(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}
