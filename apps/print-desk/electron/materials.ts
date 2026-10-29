/**
 * Zollify's printer API for materials (Sourcing → Materials → Printing app): a printer key, not
 * the signed-in session, and only two calls - list the materials, and log a use. Print Desk logs
 * the paper each printed copy took, by the material set for its paper size.
 */

export interface Material {
  id: string;
  name: string;
  type: string;
  unit: string;
  onHand: number;
  onOrder: number;
  lowAt?: number;
}

/** One use: so much of a material, with the print job's own id so a resend counts once. */
export interface MaterialUse {
  material: string;
  qty: number;
  note?: string;
  /** 8 to 80 characters, unique per use. */
  id: string;
}

export class MaterialsError extends Error {}

async function call<T>(server: string, key: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!server) throw new MaterialsError('Sign in to Zollify first.');
  if (!key) throw new MaterialsError('No printer key: make one in Zollify under Sourcing → Materials → Printing app.');
  const res = await fetch(`${server.replace(/\/+$/, '')}/p/sourcing${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) throw new MaterialsError(json.message ?? json.error ?? `Zollify answered ${res.status}`);
  return json;
}

/** The account's materials with what is on hand. */
export async function listMaterials(server: string, key: string): Promise<Material[]> {
  return (await call<{ materials: Material[] }>(server, key, '/materials')).materials;
}

/** Logs one use; the material's new stock. A resent id is not counted again (`duplicate`). */
export async function useMaterial(server: string, key: string, use: MaterialUse): Promise<{ material: Material; duplicate: boolean }> {
  return call(server, key, '/usage', { method: 'POST', body: JSON.stringify(use) });
}

/** How Print Desk reaches the materials: the Zollify sign-in, the printer key, or neither (`note` says why). */
export interface PaperAccess {
  via: 'session' | 'key' | null;
  materials: Material[];
  note: string;
}

/** Why the sign-in can't reach the materials, in words for the Paper stock panel. */
export function sessionRefusal(status: number, message: string): string {
  if (status === 402) return 'Sourcing is switched off for this account in Zollify.';
  if (status === 403) return 'Only owners and admins can use Sourcing with their sign-in.';
  if (status === 404) return 'This Zollify server does not take Print Desk\'s sign-in for materials yet (it needs an update).';
  return message;
}
