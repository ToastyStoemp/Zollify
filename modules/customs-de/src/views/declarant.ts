import { defaultCustomsDeDeclarant, type CustomsDeDeclarant } from '../engine/model';

/** Module config key holding the declarant shown on every generated document. */
export const DECLARANT_KEY = 'declarant';

/**
 * The declarant's identity plus the two facts tied to the company rather than
 * any one event: its EORI number and the Hauptzollamt responsible for its
 * business address. Both are set once here instead of retyped per event.
 */
export interface StoredDeclarant extends CustomsDeDeclarant {
  eori: string;
  precheckOffice: string;
}

export function defaultStoredDeclarant(): StoredDeclarant {
  return { ...defaultCustomsDeDeclarant(), eori: '', precheckOffice: '' };
}
