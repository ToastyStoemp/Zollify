import { round2, sleep } from './types';

/**
 * Lexware Office (lexoffice) public API: vouchers, files, contacts. Plus the
 * two voucher builders - a revenue "salesinvoice" for an event or a month of
 * online sales, and a "purchaseinvoice" for a month's payment fees.
 *
 * Ported from ZollTax. Booking categories are fixed lexoffice UUIDs; the
 * public API exposes only this handful, not the full chart.
 */

export const REVENUE_CATEGORIES: Record<string, string> = {
  einnahmen: '8f8664a1-fd86-11e1-a21f-0800200c9a66',
  warenverkaeufe: '8f8664a8-fd86-11e1-a21f-0800200c9a66',
  dienstleistung: '8f8664a0-fd86-11e1-a21f-0800200c9a66',
};
const CATEGORY_ALIASES: Record<string, string> = {
  revenue: 'einnahmen',
  income: 'einnahmen',
  goods: 'warenverkaeufe',
  warenverkäufe: 'warenverkaeufe',
  warenverkauf: 'warenverkaeufe',
  services: 'dienstleistung',
  service: 'dienstleistung',
};
export const REVENUE_CATEGORY_ID = REVENUE_CATEGORIES.einnahmen!;

/** Name, alias or raw UUID → categoryId. */
export function resolveCategoryId(value: unknown): string {
  if (!value) return REVENUE_CATEGORY_ID;
  const key = String(value).trim().toLowerCase();
  const canonical = CATEGORY_ALIASES[key] ?? key;
  return REVENUE_CATEGORIES[canonical] ?? String(value);
}

const MAX_RETRIES = 4;

export class LexwareApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, statusText: string, body: unknown, context: string) {
    const detail = body && typeof body === 'object' ? ((body as { message?: string }).message ?? JSON.stringify(body)) : String(body ?? '');
    super(`Lexware API ${status} ${statusText} on ${context}${detail ? ` - ${detail}` : ''}`);
    this.name = 'LexwareApiError';
    this.status = status;
    this.body = body;
  }
}

export class LexwareClient {
  constructor(
    private readonly apiKey: string,
    private readonly apiUrl: string,
  ) {}

  private async request(method: string, path: string, opts: { json?: unknown; body?: FormData | string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    let payload = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.json);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.apiUrl}${path}`, { method, headers, body: payload });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) throw new LexwareApiError(res.status, res.statusText, data, `${method} ${path}`);
      return data;
    }
  }

  createVoucher(voucher: unknown): Promise<{ id: string }> {
    return this.request('POST', '/vouchers', { json: voucher }) as Promise<{ id: string }>;
  }

  /** Auth check: the organisation profile. */
  ping(): Promise<{ companyName?: string }> {
    return this.request('GET', '/profile') as Promise<{ companyName?: string }>;
  }

  async uploadVoucherFile(voucherId: string, bytes: Uint8Array, filename: string): Promise<unknown> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
    return this.request('POST', `/vouchers/${voucherId}/files`, { body: form });
  }

  async findCompanyContactByName(name: string): Promise<{ id: string } | null> {
    const page = (await this.request('GET', `/contacts?name=${encodeURIComponent(name)}&customer=true&size=50`)) as {
      content?: { id: string; company?: { name?: string } }[];
    };
    return (page.content ?? []).find((c) => c.company?.name === name) ?? null;
  }

  /** Reuses an existing "Revenue - X" customer so bookings never duplicate contacts. */
  async ensureCustomerContact(name: string): Promise<string> {
    const existing = await this.findCompanyContactByName(name);
    if (existing) return existing.id;
    const created = (await this.request('POST', '/contacts', { json: { version: 0, roles: { customer: {} }, company: { name } } })) as { id: string };
    return created.id;
  }
}

// ── Voucher builders ─────────────────────────────────────────────────────────

/** "YYYY-MM-DD" → RFC-3339 at Berlin midnight, which is what lexoffice expects. */
export function toApiDate(dateStr: string): string {
  if (!dateStr || /T/.test(dateStr)) return dateStr;
  const d = new Date(`${dateStr}T12:00:00Z`);
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const m = tz.match(/GMT([+-]\d{2}:\d{2})/);
  return `${dateStr}T00:00:00.000${m ? m[1] : '+01:00'}`;
}

export interface VoucherItem {
  amount: number;
  taxAmount: number;
  taxRatePercent: number;
  categoryId: string;
}

export interface Voucher {
  type: 'salesinvoice' | 'purchaseinvoice';
  voucherStatus: string;
  voucherDate: string;
  taxType: 'gross' | 'net';
  totalGrossAmount: number;
  totalTaxAmount: number;
  voucherItems: VoucherItem[];
  contactId?: string;
  useCollectiveContact?: boolean;
  voucherNumber?: string;
  dueDate?: string;
  remark?: string;
}

function item(amountRaw: number, rateRaw: number, taxType: 'gross' | 'net', categoryId: string): VoucherItem {
  const amount = round2(Number(amountRaw));
  const rate = Number(rateRaw);
  if (!Number.isFinite(amount)) throw new Error('A voucher item needs a numeric amount.');
  if (!Number.isFinite(rate)) throw new Error('A voucher item needs a numeric tax rate.');
  const taxAmount = taxType === 'gross' ? round2(amount - amount / (1 + rate / 100)) : round2(amount * (rate / 100));
  return { amount, taxAmount, taxRatePercent: rate, categoryId };
}

export interface RevenueInput {
  voucherNumber?: string;
  voucherDate: string;
  dueDate?: string;
  taxType?: 'gross' | 'net';
  taxRatePercent: number;
  totalGrossAmount: number;
  remark?: string;
  categoryId?: string;
}

export function buildRevenueVoucher(input: RevenueInput): Voucher {
  const taxType = input.taxType ?? 'gross';
  if (!input.voucherDate) throw new Error('voucherDate is required (YYYY-MM-DD).');
  if (taxType !== 'gross' && taxType !== 'net') throw new Error('taxType must be "gross" or "net".');
  const categoryId = input.categoryId ?? REVENUE_CATEGORY_ID;
  const items = [item(input.totalGrossAmount, input.taxRatePercent, taxType, categoryId)];
  const total = round2(items.reduce((s, it) => s + it.amount, 0));
  const totalTax = round2(items.reduce((s, it) => s + it.taxAmount, 0));
  const voucher: Voucher = {
    type: 'salesinvoice',
    voucherStatus: 'open',
    voucherDate: toApiDate(input.voucherDate),
    taxType,
    totalGrossAmount: taxType === 'gross' ? total : round2(total + totalTax),
    totalTaxAmount: totalTax,
    voucherItems: items,
    useCollectiveContact: true,
  };
  if (input.voucherNumber) voucher.voucherNumber = input.voucherNumber;
  if (input.dueDate) voucher.dueDate = toApiDate(input.dueDate);
  if (input.remark) voucher.remark = input.remark;
  return voucher;
}

export interface FeeInput {
  voucherNumber?: string;
  voucherDate: string;
  dueDate?: string;
  totalGrossAmount: number;
  taxRatePercent?: number;
  taxType?: 'gross' | 'net';
  remark?: string;
  categoryId?: string;
}

/** One monthly expense voucher for a payment provider's fees. */
export function buildFeeVoucher(input: FeeInput): Voucher {
  if (!input.voucherDate) throw new Error('voucherDate is required (YYYY-MM-DD).');
  if (input.totalGrossAmount == null) throw new Error('totalGrossAmount is required.');
  if (!input.categoryId) throw new Error('A fee expense category is required - set it under Settings → Lexware Office.');
  const taxType = input.taxType ?? 'gross';
  const it = item(input.totalGrossAmount, input.taxRatePercent ?? 0, taxType, input.categoryId);
  const voucher: Voucher = {
    type: 'purchaseinvoice',
    voucherStatus: 'open',
    voucherDate: toApiDate(input.voucherDate),
    taxType,
    totalGrossAmount: taxType === 'gross' ? it.amount : round2(it.amount + it.taxAmount),
    totalTaxAmount: it.taxAmount,
    voucherItems: [it],
    useCollectiveContact: true,
  };
  if (input.voucherNumber) voucher.voucherNumber = input.voucherNumber;
  if (input.dueDate) voucher.dueDate = toApiDate(input.dueDate);
  if (input.remark) voucher.remark = input.remark;
  return voucher;
}
