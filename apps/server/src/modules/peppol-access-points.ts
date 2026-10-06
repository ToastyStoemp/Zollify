import { z } from 'zod';
import type { PeppolDocument } from '@zollify/shared';

/**
 * Peppol access points: the certified providers that carry an invoice over
 * the Peppol network (Zollify cannot send over Peppol itself - nobody can
 * without being a certified access point). A business connects its own
 * account by API key; the key is stored encrypted by peppol-be.ts and never
 * reaches the browser.
 *
 * Only providers whose API is checked against their published specification
 * are listed. Others can be added as one entry each; until then any access
 * point works by downloading the UBL and uploading it there.
 */

export interface AccessPointInfo {
  id: string;
  name: string;
  site: string;
  note: string;
}

export const ACCESS_POINTS: AccessPointInfo[] = [
  {
    id: 'storecove',
    name: 'Storecove',
    site: 'https://www.storecove.com',
    note: 'Needs your Storecove API key and the id of your legal entity there (Storecove registers you on Peppol). Use a sandbox key to test.',
  },
];

export const AccessPointSchema = z.object({
  provider: z.string().min(1).max(40).refine((p) => ACCESS_POINTS.some((a) => a.id === p), 'Unknown access point.'),
  apiKey: z.string().trim().max(500).default(''),
  /** The provider's own id for the sending business (Storecove: the legal entity id). */
  accountRef: z.string().trim().max(60).default(''),
  sandbox: z.boolean().default(true),
});
export type AccessPointConfig = z.infer<typeof AccessPointSchema>;

type Result = { ok: true; reference?: string } | { ok: false; message: string };

/** Storecove's names for Peppol identifier schemes (their "BE:EN" is ISO 6523 0208). */
const STORECOVE_SCHEMES: Record<string, string> = {
  '0208': 'BE:EN',
  '9925': 'BE:VAT',
  '0106': 'NL:KVK',
  '9944': 'NL:VAT',
  '0088': 'GLN',
  '0184': 'DK:DIGST',
  '9930': 'DE:VAT',
  '0007': 'SE:ORGNR',
  '0192': 'NO:ORG',
};

async function storecove(config: AccessPointConfig, doc: PeppolDocument, xml: string): Promise<Result> {
  const scheme = STORECOVE_SCHEMES[doc.buyer.peppolScheme];
  if (!scheme) return { ok: false, message: `Storecove: Peppol scheme ${doc.buyer.peppolScheme} is not supported here.` };
  const legalEntityId = Number(config.accountRef);
  if (!Number.isInteger(legalEntityId) || legalEntityId <= 0) return { ok: false, message: 'Storecove: enter your legal entity id in the settings.' };
  try {
    const res = await fetch('https://api.storecove.com/api/v2/document_submissions', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        legalEntityId,
        // The same document is never delivered twice, even if "send" is pressed again after a timeout.
        idempotencyGuid: doc.id,
        routing: { eIdentifiers: [{ scheme, id: doc.buyer.peppolScheme === '0208' ? doc.buyer.peppolId.replace(/\D/g, '') : doc.buyer.peppolId }] },
        document: { documentType: doc.kind === 'credit' ? 'creditnote' : 'invoice', rawDocumentData: { document: Buffer.from(xml, 'utf8').toString('base64'), parseStrategy: 'ubl' } },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { guid?: string; errors?: { details?: string; message?: string }[]; message?: string };
    if (!res.ok) return { ok: false, message: `Storecove refused it (${res.status}): ${body.errors?.map((e) => e.details ?? e.message).join('; ') || body.message || res.statusText}` };
    return { ok: true, ...(body.guid ? { reference: body.guid } : {}) };
  } catch (err) {
    return { ok: false, message: `Storecove could not be reached: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function sendViaAccessPoint(config: AccessPointConfig, doc: PeppolDocument, xml: string): Promise<Result> {
  if (config.provider === 'storecove') return storecove(config, doc, xml);
  return { ok: false, message: 'Sending through this access point is not available - download the XML and upload it there.' };
}
