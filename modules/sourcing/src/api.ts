import { sdk } from './runtime';

/**
 * Typed wrapper over this module's own server half. Requests reach
 * `/api/m/sourcing/…` and cannot address another module's routes — the host
 * roots them at the module's namespace.
 */

export interface Supplier {
  id: string;
  name: string;
  contactEmail: string | null;
  notes: string | null;
  updatedAt: number;
}

export interface ReorderLine {
  productId: string;
  title: string;
  qty: number;
}

export interface ReorderDraft {
  id: string;
  supplierId: string;
  status: 'draft' | 'sent';
  lines: ReorderLine[];
  createdAt: number;
  sentAt: number | null;
}

export const suppliersApi = {
  list: () => sdk().http.get<{ suppliers: Supplier[] }>('suppliers'),
  save: (supplier: Omit<Supplier, 'updatedAt'>) =>
    sdk().http.post<{ supplier: Supplier }>('suppliers', supplier),
  remove: (id: string) => sdk().http.del<{ ok: true }>(`suppliers/${id}`),
};

export const draftsApi = {
  list: () => sdk().http.get<{ drafts: ReorderDraft[] }>('drafts'),
  create: (supplierId: string, lines: ReorderLine[]) =>
    sdk().http.post<{ draft: ReorderDraft }>('drafts', { supplierId, lines }),
  markSent: (id: string) => sdk().http.post<{ draft: ReorderDraft }>(`drafts/${id}/sent`),
};
