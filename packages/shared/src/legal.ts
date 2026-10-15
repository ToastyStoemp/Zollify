import type { ArtistDetails } from './protocol';
import { legalLinks, type ProfileLinks } from './receipt-socials';

/**
 * The legal block of Zollify's public pages - the online receipt and the
 * public events page. German law wants an imprint (Impressum, § 5 DDG) and a
 * privacy notice (Art. 13 GDPR) on a business's web pages; other countries
 * ask for much the same. The block names the seller (the controller), what
 * the page processes and for how long, and who runs the server; a seller
 * with pages of their own links them instead of relying on the built-in text.
 *
 * Contact details beyond the address stay off on purpose: the pages never
 * show a seller's phone or email, which can be a home address.
 */

export interface LegalBlock {
  /** Who is behind the page: business name and address, and the VAT number when there is one. */
  imprint: string[];
  /** Plain-language privacy notice, one paragraph per entry. */
  privacy: string[];
  /** The seller's own pages, when set in the business profile. */
  imprintUrl?: string;
  privacyUrl?: string;
  /** Who hosts the server, from the operator's configuration - absent when not configured. */
  operator?: string;
}

export interface LegalInput {
  artist: Pick<ArtistDetails, 'companyName' | 'fullName' | 'street' | 'postCodeCity' | 'countryOfOrigin' | 'vatId'>;
  /** The account name, when the profile names no business. */
  accountName: string;
  links?: Partial<ProfileLinks> | null;
  /** "Name, street, city, email" of whoever runs the server; shown as the hosting provider. */
  operator?: string;
}

export function imprintLines(input: Pick<LegalInput, 'artist' | 'accountName'>): string[] {
  const a = input.artist;
  const name = a.companyName.trim() || a.fullName.trim() || input.accountName;
  const lines = [name];
  if (a.fullName.trim() && a.fullName.trim() !== name) lines.push(a.fullName.trim());
  for (const l of [a.street, a.postCodeCity, a.countryOfOrigin]) if (l.trim()) lines.push(l.trim());
  if (a.vatId.trim()) lines.push(`VAT no. ${a.vatId.trim()}`);
  return lines;
}

/** The notice for the online receipt: who sees what, and for how long the link works. */
export function receiptLegal(input: LegalInput, retentionDays: number): LegalBlock {
  const name = imprintLines(input)[0]!;
  const months = Math.max(1, Math.round(retentionDays / 30));
  return {
    imprint: imprintLines(input),
    privacy: [
      `This page shows the receipt for a purchase from ${name}, who is responsible for it (the controller under data protection law). It lists what was bought, the amount, the way it was paid and the seller's tax details - the same as on a paper receipt. It holds no name, card number or other detail about the buyer.`,
      `Whoever has this link can open the receipt; keep it as you would keep a paper one. The link works for about ${months} months after the purchase. The seller keeps the sale itself as long as tax law requires (in Germany ten years, § 147 AO).`,
      'The page sets no cookies and uses no analytics. To keep the receipts from being read by guessing links, the server asks your browser to solve a small puzzle and notes your network address for a short while to stop repeated attempts; it is not linked to the purchase.',
      'You may ask the seller what they hold about a purchase, to correct it, or to complain to a data protection authority. Address the seller named above.',
    ],
    ...legalLinks(input.links),
    ...(input.operator?.trim() ? { operator: input.operator.trim() } : {}),
  };
}

/** The notice for the public events page and its feeds. */
export function eventsPageLegal(input: LegalInput): LegalBlock {
  const name = imprintLines(input)[0]!;
  return {
    imprint: imprintLines(input),
    privacy: [
      `This page is published by ${name}, who is responsible for it. It lists where they sell next and nothing about its visitors.`,
      'The page sets no cookies and uses no analytics. The server keeps its usual access log - network address, time, page - for a short while to run and protect the service, then deletes it. Subscribing to the calendar feed makes your calendar app fetch this page on its own schedule; that is between you and your calendar provider.',
      'Questions about this page go to the business named above. You may complain to a data protection authority.',
    ],
    ...legalLinks(input.links),
    ...(input.operator?.trim() ? { operator: input.operator.trim() } : {}),
  };
}
