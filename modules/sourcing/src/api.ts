import { computed, ref } from 'vue';
import type { Dossier, Issue, Material, Reorder, Rep, Snapshot, SourcingFile, Supplier } from './engine';
import { sdk } from './runtime';

/**
 * Typed wrapper over this module's own server half plus one in-memory copy
 * of everything. Requests reach `/api/m/sourcing/…` and cannot address
 * another module's routes — the host roots them at the module's namespace.
 */

type Coll = 'suppliers' | 'reps' | 'dossiers' | 'reorders' | 'issues' | 'materials';
type DocOf<C extends Coll> = C extends 'suppliers' ? Supplier : C extends 'reps' ? Rep : C extends 'dossiers' ? Dossier : C extends 'reorders' ? Reorder : C extends 'issues' ? Issue : Material;

export const snap = ref<Snapshot>({ suppliers: [], reps: [], dossiers: [], reorders: [], issues: [], materials: [], files: [] });
export const loaded = ref(false);

export async function refresh(): Promise<void> {
  snap.value = await sdk().http.get<Snapshot>('snapshot');
  loaded.value = true;
}

export async function save<C extends Coll>(coll: C, doc: DocOf<C>): Promise<DocOf<C>> {
  const { doc: saved } = await sdk().http.put<{ doc: DocOf<C> }>(`${coll}/${doc.id}`, doc);
  const list = snap.value[coll] as DocOf<C>[];
  const i = list.findIndex((d) => d.id === doc.id);
  if (i >= 0) list.splice(i, 1, saved);
  else list.push(saved);
  return saved;
}

export async function remove(coll: Coll, id: string): Promise<void> {
  await sdk().http.del(`${coll}/${id}`);
  const list = snap.value[coll] as { id: string }[];
  const i = list.findIndex((d) => d.id === id);
  if (i >= 0) list.splice(i, 1);
  if (coll === 'dossiers') snap.value.files = snap.value.files.filter((f) => f.dossierId !== id);
  if (coll === 'suppliers') snap.value.reps = snap.value.reps.filter((r) => r.supplierId !== id);
}

export async function uploadFile(dossierId: string, file: File, kind: 'design' | 'proof' = 'design'): Promise<SourcingFile> {
  const dataB64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const { file: meta } = await sdk().http.post<{ file: SourcingFile }>('files', { dossierId, filename: file.name, mime: file.type || 'application/octet-stream', kind, dataB64 });
  snap.value.files.push(meta);
  return meta;
}
export async function setApproval(id: string, approval: 'approved' | 'rejected' | 'pending', note?: string): Promise<void> {
  await sdk().http.post(`files/${id}/approval`, { approval, note });
  const f = snap.value.files.find((x) => x.id === id);
  if (f) {
    f.approval = approval;
    f.note = note ?? null;
  }
}
export async function deleteFile(id: string): Promise<void> {
  await sdk().http.del(`files/${id}`);
  snap.value.files = snap.value.files.filter((f) => f.id !== id);
}
/** Bytes of one stored file, for previews, downloads and the reorder zip. */
export async function fileBytes(id: string): Promise<{ filename: string; mime: string; bytes: Uint8Array }> {
  const res = await sdk().http.get<{ filename: string; mime: string; dataB64: string }>(`files/${id}`);
  const bin = atob(res.dataB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { filename: res.filename, mime: res.mime, bytes };
}

export const supplierName = computed(() => new Map(snap.value.suppliers.map((s) => [s.id, s.name])));
