import { computed, ref } from 'vue';
import { checkPickedFile } from '@zollify/shared';
import { nextRef, type Dossier, type Issue, type Material, type MaterialUsage, type Reorder, type Rep, type Snapshot, type SourcingFile, type Supplier } from './engine';
import { sdk } from './runtime';

/**
 * Typed wrapper over this module's own server half plus one in-memory copy
 * of everything. Requests reach `/api/m/sourcing/…` and cannot address
 * another module's routes - the host roots them at the module's namespace.
 */

type Coll = 'suppliers' | 'reps' | 'dossiers' | 'reorders' | 'issues' | 'materials';
type DocOf<C extends Coll> = C extends 'suppliers' ? Supplier : C extends 'reps' ? Rep : C extends 'dossiers' ? Dossier : C extends 'reorders' ? Reorder : C extends 'issues' ? Issue : Material;

export const snap = ref<Snapshot>({ suppliers: [], reps: [], dossiers: [], reorders: [], issues: [], materials: [], files: [], usage: {} });
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

// ── Materials on hand ───────────────────────────────────────────────────────

function keepUsage(materialId: string, usage: MaterialUsage): void {
  snap.value.usage = { ...(snap.value.usage ?? {}), [materialId]: usage };
}
/** Logs a use by hand (a print run, a misprint). */
export async function useMaterial(materialId: string, qty: number, note?: string): Promise<void> {
  const res = await sdk().http.post<{ usage: MaterialUsage }>(`materials/${materialId}/use`, { qty, ...(note ? { note } : {}) });
  keepUsage(materialId, res.usage);
}
/** A recount: what is really there. The difference is logged. */
export async function countMaterial(materialId: string, onHand: number): Promise<void> {
  const res = await sdk().http.post<{ usage: MaterialUsage }>(`materials/${materialId}/count`, { onHand });
  keepUsage(materialId, res.usage);
}
export async function dropUse(id: string): Promise<void> {
  await sdk().http.del(`usage/${id}`);
  await refresh();
}

/** A key the printing app uses to log what it prints; the secret is only ever in `create`'s answer. */
export interface PrinterKey {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export const printerKeys = {
  list: async () => (await sdk().http.get<{ keys: PrinterKey[] }>('keys')).keys,
  create: (label: string) => sdk().http.post<{ key: PrinterKey; secret: string }>('keys', { label }),
  revoke: (id: string) => sdk().http.del<{ ok: true }>(`keys/${id}`),
};

export async function remove(coll: Coll, id: string): Promise<void> {
  await sdk().http.del(`${coll}/${id}`);
  const list = snap.value[coll] as { id: string }[];
  const i = list.findIndex((d) => d.id === id);
  if (i >= 0) list.splice(i, 1);
  if (coll === 'dossiers') snap.value.files = snap.value.files.filter((f) => f.dossierId !== id);
  if (coll === 'suppliers') snap.value.reps = snap.value.reps.filter((r) => r.supplierId !== id);
}

export async function uploadFile(dossierId: string, file: File, kind: 'design' | 'proof' = 'design'): Promise<SourcingFile> {
  // The same check the server makes, so a wrong or oversized file never leaves the device.
  const problem = await checkPickedFile('designFile', file);
  if (problem) throw new Error(problem);
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

/**
 * What is here now - the last count less what sold since, not the count
 * itself. A dossier saved without a variant covers the whole product, so a
 * product with variants adds them up.
 */
export function onHandFor(pid: string, vid: string): number {
  const inv = sdk().data.inventory;
  const variants = vid ? [] : (sdk().data.products.get(pid)?.variants ?? []);
  return variants.length ? variants.reduce((n, v) => n + inv.inStock(pid, v.id), 0) : inv.inStock(pid, vid || null);
}

/** Reorders still open to new lines; anything later is already with the supplier. */
const MERGEABLE = ['draft', 'quote_requested', 'quoted'];

/**
 * Turns picked lines into one reorder per supplier, folded into that
 * supplier's open one when there is. `from` names where they came from in
 * the reorder's history. Lines for the same dossier add up; lines without a
 * supplier are left out and returned by title.
 */
export async function orderLines(
  lines: { dossierId: string; title: string; supplierId: string | null; qty: number }[],
  from: string,
): Promise<{ created: number; merged: number; skipped: string[] }> {
  const bySupplier = new Map<string, Map<string, { dossierId: string; title: string; qty: number }>>();
  const skipped: string[] = [];
  for (const l of lines) {
    if (l.qty <= 0) continue;
    if (!l.supplierId) {
      skipped.push(l.title);
      continue;
    }
    const m = bySupplier.get(l.supplierId) ?? bySupplier.set(l.supplierId, new Map()).get(l.supplierId)!;
    const had = m.get(l.dossierId);
    m.set(l.dossierId, { dossierId: l.dossierId, title: had?.title ?? l.title, qty: (had?.qty ?? 0) + l.qty });
  }
  let created = 0;
  let merged = 0;
  for (const [supplierId, m] of bySupplier) {
    const add = [...m.values()];
    const open = snap.value.reorders.filter((x) => x.supplierId === supplierId && MERGEABLE.includes(x.status)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (open) {
      const byD = new Map(open.lines.map((l) => [l.dossierId, l]));
      for (const nl of add) byD.set(nl.dossierId, { ...(byD.get(nl.dossierId) ?? {}), ...nl });
      await save('reorders', { ...open, lines: [...byD.values()], events: [...open.events, { status: open.status, at: Date.now(), note: `Added ${add.length} item(s) from ${from}` }] });
      merged++;
    } else {
      const now = Date.now();
      const r: Reorder = { id: crypto.randomUUID(), ref: nextRef(snap.value.reorders), supplierId, status: 'draft', note: '', currency: sdk().account()?.profile.defaultCurrency ?? 'CHF', landedExtra: null, lines: add, events: [{ status: 'draft', at: now, note: `Created from ${from}` }], createdAt: now };
      await save('reorders', r);
      created++;
    }
  }
  return { created, merged, skipped };
}
