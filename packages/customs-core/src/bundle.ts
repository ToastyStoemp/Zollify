/**
 * "Export everything for this event" across the country modules.
 *
 * The customs hub knows nothing about Swiss or German paperwork - each
 * country module answers a request on the shared event bus with a provider
 * that builds its own documents from the event's saved customs details, in
 * its own currency. The hub only collects, renders and hands over the files.
 */

/** Before the trip (taking goods across) or after it (bringing the rest home). */
export type CustomsPhase = 'before' | 'after';

export interface CustomsBundleDoc {
  /** Shown to the user, e.g. "Packing list (import)". */
  title: string;
  /** A print-ready HTML document; the hub combines these into one PDF per country. */
  html: string;
}

export interface CustomsBundleFile {
  filename: string;
  content: string;
  mimeType: string;
}

export interface CustomsBundle {
  /** "Switzerland". */
  country: string;
  /** Currency the documents are written in, e.g. "CHF". */
  currency: string;
  /** Base for file names: the event name, made file-safe. */
  fileBase: string;
  docs: CustomsBundleDoc[];
  /** Files handed over as they are, e.g. the e-dec XML. */
  files: CustomsBundleFile[];
  /** Where to file what was exported, e.g. the e-dec web portal. */
  links: { label: string; url: string }[];
  /** Anything the user should know, e.g. "no sales yet, so no e-dec XML". */
  notes: string[];
}

export interface CustomsBundleProvider {
  /** "ch" / "de". */
  country: string;
  label: string;
  build(eventId: string, phase: CustomsPhase): Promise<CustomsBundle | null>;
}

/** The bus event the hub emits; each country module pushes its provider onto `providers`. */
export const CUSTOMS_BUNDLE_REQUEST = 'customs:bundle-providers';

export interface CustomsBundleRequest {
  providers: CustomsBundleProvider[];
}

interface BusLike {
  emit(name: string, payload: unknown): void;
}

/** Asks every installed country module for its provider. The bus is synchronous, so this returns them all. */
export function collectBundleProviders(bus: BusLike): CustomsBundleProvider[] {
  const request: CustomsBundleRequest = { providers: [] };
  bus.emit(CUSTOMS_BUNDLE_REQUEST, request);
  return request.providers;
}

/** An event name made safe for a file name. */
export function fileSafe(name: string | undefined): string {
  return (name || 'event').replace(/[^\w-]+/g, '_');
}
