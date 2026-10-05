import type { SalesEvent } from '@zollify/shared';
import { fileSafe, type CustomsBundle, type CustomsBundleProvider, type CustomsPhase } from '@zollify/customs-core';
import { buildCustomsDeState, readCustomsDeBlob } from './engine/adapter';
import { buildPackingListHtml } from './engine/packing-list';
import { buildProformaHtml } from './engine/proforma';
import { defaultCustomsDeDeclarant, type CustomsDeDeclarant, type CustomsDeState } from './engine/model';
import { DECLARANT_KEY, type StoredDeclarant } from './views/declarant';
import { sdk } from './runtime';

function stripEmpty<T extends object>(obj: Partial<T> | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null)) as Partial<T>;
}

/**
 * The same state the German documents page builds, from what is saved:
 * booth profile, the declarant settings, then this event's own record - the
 * page's own layering and fallbacks, field for field.
 */
export async function storedCustomsDeState(ev: SalesEvent): Promise<CustomsDeState> {
  const blob = readCustomsDeBlob(ev);
  const stored = await sdk().config.get<Partial<StoredDeclarant>>(DECLARANT_KEY);
  const profile = sdk().account()?.profile.artist;
  const declarant: CustomsDeDeclarant = {
    ...defaultCustomsDeDeclarant(),
    ...stripEmpty<CustomsDeDeclarant>(profile),
    ...stripEmpty<CustomsDeDeclarant>(stored ?? undefined),
    ...stripEmpty<CustomsDeDeclarant>(blob.declarant),
  };
  const m = blob.meta;
  const combined = Array.isArray(blob.combinedEventIds) ? blob.combinedEventIds : [];
  const withSaved: SalesEvent = {
    ...ev,
    customsDe: {
      declarant,
      meta: {
        precheckOffice: m?.precheckOffice || stored?.precheckOffice || '',
        eori: m?.eori || stored?.eori || profile?.eori || '',
        exportMrn: m?.exportMrn ?? '',
        destinationCountry: m?.destinationCountry || ev.venue?.country || '',
        transportMode: m?.transportMode ?? '3 - Road',
        vehicleReg: m?.vehicleReg ?? '',
        totalPackages: m?.totalPackages ?? 1,
        referenceNumber: m?.referenceNumber ?? '',
        transportNationality: m?.transportNationality ?? 'DE',
        exitOffice: m?.exitOffice ?? '',
        placeOfDeclaration: m?.placeOfDeclaration ?? '',
        incoterms: m?.incoterms ?? '',
      },
    },
  };
  const api = sdk().data;
  const stock = await api.events.stock(ev.id);
  return buildCustomsDeState(withSaved, api.products.list(), stock, api.transactions.recent(), combined, api.events.list());
}

/** Before: the export packing list and proforma invoice. After: the re-import packing list and the sold goods list. */
export function germanDocuments(state: CustomsDeState, phase: CustomsPhase, fileBase: string): CustomsBundle {
  const bundle: CustomsBundle = {
    country: 'Germany',
    currency: state.meta.currency || 'EUR',
    fileBase,
    docs: [],
    files: [],
    links: [],
    notes: [],
  };
  if (phase === 'before') {
    bundle.docs.push({ title: 'Packing list (export)', html: buildPackingListHtml(state, 'export', 'detailed') });
    bundle.docs.push({ title: 'Proforma invoice', html: buildProformaHtml(state) });
  } else {
    bundle.docs.push({ title: 'Packing list (re-import)', html: buildPackingListHtml(state, 'reimport', 'detailed') });
    bundle.docs.push({ title: 'Sold goods list', html: buildPackingListHtml(state, 'sold', 'detailed') });
  }
  return bundle;
}

export const germanBundleProvider: CustomsBundleProvider = {
  country: 'de',
  label: 'Germany',
  async build(eventId, phase) {
    const ev = sdk().data.events.get(eventId);
    if (!ev) return null;
    return germanDocuments(await storedCustomsDeState(ev), phase, fileSafe(ev.name));
  },
};
