import type { CustomsDeProduct } from './model';

export function esc(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML escape (also encodes apostrophes, unlike HTML `esc`). */
export function escapeXml(str: unknown): string {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** "12349 Berlin" -> { postCode: "12349", city: "Berlin" }. */
export function parsePostCodeCity(str: string): { postCode: string; city: string } {
  if (!str) return { postCode: '', city: '' };
  const match = str.match(/^(\S+)\s+(.+)$/);
  if (match) return { postCode: match[1] ?? '', city: match[2] ?? '' };
  return { postCode: '', city: str };
}

/** "Germany" / "DE" -> "DE". Falls back to the first two letters, uppercased. */
export function countryToCode(name: string | undefined): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  const known: Record<string, string> = {
    germany: 'DE',
    deutschland: 'DE',
    switzerland: 'CH',
    schweiz: 'CH',
  };
  const code = known[trimmed.toLowerCase()];
  if (code) return code;
  return trimmed.toUpperCase().slice(0, 2);
}

export function fmtWeightKg(kg: number): string {
  if (!kg) return '0 kg';
  return (Math.round(kg * 100) / 100).toFixed(2).replace('.', ',') + ' kg';
}

export interface ProductCalc {
  totalWeightKg: number;
  totalValue: number | null;
  /** Not yet sold, so due back to Germany on re-import. */
  reimportQty: number;
  reimportWeightKg: number;
  reimportValue: number | null;
}

export function calcDeProduct(p: CustomsDeProduct): ProductCalc {
  const weightG = parseFloat(String(p.weightG ?? '')) || 0;
  const price = p.price != null && p.price !== '' ? parseFloat(String(p.price)) : null;
  const totalWeightKg = Math.round(p.amount * weightG) / 1000;
  const totalValue = price != null ? Math.round(price * p.amount) : null;

  const reimportQty = Math.max(0, p.amount - p.soldQty);
  const reimportWeightKg = Math.round(reimportQty * weightG) / 1000;
  const reimportValue = price != null ? Math.round(price * reimportQty) : null;

  return { totalWeightKg, totalValue, reimportQty, reimportWeightKg, reimportValue };
}
