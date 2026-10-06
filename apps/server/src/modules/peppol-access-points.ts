import { z } from 'zod';
import type { PeppolDocument } from '@zollify/shared';

/**
 * Peppol access points: the certified providers that carry an invoice over
 * the Peppol network. A business connects its own account by API key; the
 * key is stored encrypted by peppol-be.ts and never sent to the browser.
 *
 * Each provider is one entry here with how to send a UBL document to it.
 * Until one is connected, issued invoices download as UBL XML for uploading
 * to whatever access point the business uses.
 */

export interface AccessPointInfo {
  id: string;
  name: string;
  site: string;
  note: string;
}

/** Providers Zollify can send through directly. */
export const ACCESS_POINTS: AccessPointInfo[] = [];

export const AccessPointSchema = z.object({
  provider: z.string().min(1).max(40).refine((p) => ACCESS_POINTS.some((a) => a.id === p), 'Unknown access point.'),
  apiKey: z.string().trim().max(500).default(''),
  sandbox: z.boolean().default(true),
});
export type AccessPointConfig = z.infer<typeof AccessPointSchema>;

export async function sendViaAccessPoint(
  config: AccessPointConfig,
  _doc: PeppolDocument,
  _xml: string,
): Promise<{ ok: true; reference?: string } | { ok: false; message: string }> {
  return { ok: false, message: `Sending through ${config.provider} is not available yet - download the XML and upload it to your access point.` };
}
