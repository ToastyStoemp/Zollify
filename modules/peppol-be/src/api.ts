import type { PeppolDocument, PeppolDocumentInput, PeppolParty, PeppolProblem, PeppolSettings, PeppolTotals } from '@zollify/shared';
import { localIsoDay } from '@zollify/shared';
import { sdk } from './runtime';

/** Typed calls to this module's server half (/api/m/peppol-be/…). */

export interface DocumentSummary {
  id: string;
  kind: 'invoice' | 'credit';
  number: string | null;
  status: PeppolDocument['status'];
  issueDate: string;
  dueDate: string | null;
  buyer: string;
  total: number;
  currency: string;
  sentVia: PeppolDocument['sentVia'] | null;
}
export interface AccessPointInfo {
  provider: string;
  sandbox: boolean;
  accountRef: string;
  hasKey: boolean;
}
export interface ProviderInfo {
  id: string;
  name: string;
  site: string;
  note: string;
}
export type Customer = PeppolParty & { id: string };

export const loadSettings = (): Promise<{ settings: PeppolSettings; accessPoint: AccessPointInfo | null; providers: ProviderInfo[] }> => sdk().http.get('settings');
export const saveSettings = (s: PeppolSettings): Promise<{ settings: PeppolSettings }> => sdk().http.put('settings', s);
export const saveAccessPoint = (ap: { provider: string; apiKey: string; accountRef: string; sandbox: boolean } | null): Promise<{ accessPoint: AccessPointInfo | null }> =>
  sdk().http.put('access-point', ap ?? { provider: null });

export const loadCustomers = async (): Promise<Customer[]> => (await sdk().http.get<{ customers: Customer[] }>('customers')).customers;
export const saveCustomer = (id: string, c: PeppolParty): Promise<{ customer: Customer }> => sdk().http.put(`customers/${encodeURIComponent(id)}`, c);
export const deleteCustomer = (id: string): Promise<unknown> => sdk().http.del(`customers/${encodeURIComponent(id)}`);
export const lookupPeppol = (scheme: string, id: string): Promise<{ registered: boolean | null; name: string | null; message?: string }> =>
  sdk().http.get(`lookup?scheme=${encodeURIComponent(scheme)}&id=${encodeURIComponent(id)}`);

export const loadDocuments = async (): Promise<DocumentSummary[]> => (await sdk().http.get<{ documents: DocumentSummary[] }>('documents')).documents;
export const loadDocument = (id: string): Promise<{ document: PeppolDocument; totals: PeppolTotals; problems: PeppolProblem[] }> => sdk().http.get(`documents/${encodeURIComponent(id)}`);
export const createDocument = (input: PeppolDocumentInput): Promise<{ document: PeppolDocument; problems: PeppolProblem[] }> => sdk().http.post('documents', input);
export const updateDocument = (id: string, input: PeppolDocumentInput): Promise<{ document: PeppolDocument; problems: PeppolProblem[] }> =>
  sdk().http.put(`documents/${encodeURIComponent(id)}`, input);
export const deleteDocument = (id: string): Promise<unknown> => sdk().http.del(`documents/${encodeURIComponent(id)}`);
export const issueDocument = (id: string): Promise<{ document: PeppolDocument }> => sdk().http.post(`documents/${encodeURIComponent(id)}/issue`);
export const creditDocument = (id: string): Promise<{ document: PeppolDocument }> => sdk().http.post(`documents/${encodeURIComponent(id)}/credit`);
export const setStatus = (id: string, status: 'sent' | 'paid' | 'issued'): Promise<{ document: PeppolDocument }> => sdk().http.post(`documents/${encodeURIComponent(id)}/status`, { status });
export const sendDocument = (id: string): Promise<{ document: PeppolDocument; reference: string | null }> => sdk().http.post(`documents/${encodeURIComponent(id)}/send`);
export const fromSale = (saleId: string, customerId?: string): Promise<{ document: PeppolDocument; problems: PeppolProblem[] }> =>
  sdk().http.post(`from-sale/${encodeURIComponent(saleId)}`, customerId ? { customerId } : {});
/** The UBL as text, for saving as a file. */
export const documentXml = (id: string): Promise<string> => sdk().http.get<string>(`documents/${encodeURIComponent(id)}/xml`);

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string; problems?: PeppolProblem[] } } | null)?.body;
  return body?.message ?? (err instanceof Error ? err.message : fallback);
}
export const problemsOf = (err: unknown): PeppolProblem[] => (err as { body?: { problems?: PeppolProblem[] } } | null)?.body?.problems ?? [];
export const today = (): string => localIsoDay();
