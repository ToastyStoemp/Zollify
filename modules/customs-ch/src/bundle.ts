import type { SalesEvent } from '@zollify/shared';
import { fileSafe, type CustomsBundle, type CustomsBundleProvider, type CustomsPhase } from '@zollify/customs-core';
import { buildCustomsState, readCustomsBlob } from './engine/adapter';
import { buildEdecXml } from './engine/edec-xml';
import { buildGoodsListHtml } from './engine/goods-list';
import { buildPackingListHtml } from './engine/packing-list';
import { buildProformaHtml } from './engine/proforma';
import { defaultCustomsArtist, defaultCustomsEdec, defaultCustomsForm1174, type CustomsArtist, type CustomsState } from './engine/model';
import { DECLARANT_KEY } from './views/declarant';
import { sdk } from './runtime';

/** The Swiss customs office's (BAZG) own e-dec web portal, where the XML is filed. */
export const EDEC_WEB_URL = 'https://e-dec-web.ezv.admin.ch/webdec/main.xhtml';

/** Only filled-in fields, so defaults are not clobbered by blanks. */
export function stripEmpty<T extends object>(obj: Partial<T> | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null)) as Partial<T>;
}

/** Company code from the artist's initials - "Phuong Ninjin" → "PN". */
export function autoCompanyCode(artist: Pick<CustomsArtist, 'companyName' | 'fullName'>): string {
  const name = (artist.companyName || artist.fullName || '').trim();
  if (!name) return '';
  const words = name.split(/\s+/).filter(Boolean);
  const raw = words.length > 1 ? words.map((w) => w[0]).join('') : name.slice(0, 3);
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/**
 * The same state the documents page builds, from what is saved: booth
 * profile, then the declarant settings, then this event's own overrides -
 * exactly the layering the page applies to its form fields.
 */
export async function storedCustomsState(ev: SalesEvent): Promise<CustomsState> {
  const blob = readCustomsBlob(ev);
  const declarant = await sdk().config.get<Partial<CustomsArtist>>(DECLARANT_KEY);
  const artist: CustomsArtist = {
    ...defaultCustomsArtist(),
    ...stripEmpty<CustomsArtist>(sdk().account()?.profile.artist),
    ...stripEmpty<CustomsArtist>(declarant ?? undefined),
    ...stripEmpty<CustomsArtist>(blob.artist),
  };
  const form1174 = { ...defaultCustomsForm1174(), ...(blob.form1174 ?? {}) };
  if (!Array.isArray(form1174.assignments)) form1174.assignments = [];
  const combined = Array.isArray(blob.combinedEventIds) ? blob.combinedEventIds : [];

  const withSaved: SalesEvent = {
    ...ev,
    customs: {
      artist,
      edec: { ...defaultCustomsEdec(), ...(blob.edec ?? {}) },
      form1174,
      meta: {
        companyCode: blob.meta?.companyCode?.trim() || autoCompanyCode(artist),
        documentNumber: blob.meta?.documentNumber ?? 1,
        venueName: blob.meta?.venueName ?? '',
        eventLocation: blob.meta?.eventLocation ?? '',
        venueTIN: blob.meta?.venueTIN ?? ev.venue?.tin ?? '',
        incoterms: blob.meta?.incoterms ?? '',
      },
    },
  };
  const api = sdk().data;
  const stock = await api.events.stock(ev.id);
  return buildCustomsState(withSaved, api.products.list(), stock, api.transactions.recent(), combined, api.events.list());
}

/**
 * Before: the import packing list and proforma invoice. After: the return
 * goods list, the sold goods list and the e-dec XML, with the e-dec web
 * portal to file it in.
 */
export function swissDocuments(state: CustomsState, phase: CustomsPhase, fileBase: string): CustomsBundle {
  const bundle: CustomsBundle = {
    country: 'Switzerland',
    currency: state.meta.currency || 'CHF',
    fileBase,
    docs: [],
    files: [],
    links: [],
    notes: [],
  };
  if (phase === 'before') {
    bundle.docs.push({ title: 'Packing list (import)', html: buildPackingListHtml(state, 'detailed') });
    bundle.docs.push({ title: 'Proforma invoice', html: buildProformaHtml(state) });
    return bundle;
  }
  bundle.docs.push({ title: 'Return goods list', html: buildGoodsListHtml(state, 3, 'detailed') });
  bundle.docs.push({ title: 'Sold goods list', html: buildGoodsListHtml(state, 2, 'detailed') });
  const edec = buildEdecXml(state);
  if (edec) bundle.files.push({ filename: edec.filename, content: edec.xml, mimeType: 'application/xml' });
  else bundle.notes.push('No e-dec XML: nothing has sold yet.');
  bundle.links.push({ label: 'Open e-dec web', url: EDEC_WEB_URL });
  return bundle;
}

export const swissBundleProvider: CustomsBundleProvider = {
  country: 'ch',
  label: 'Switzerland',
  async build(eventId, phase) {
    const ev = sdk().data.events.get(eventId);
    if (!ev) return null;
    return swissDocuments(await storedCustomsState(ev), phase, fileSafe(ev.name));
  },
};
