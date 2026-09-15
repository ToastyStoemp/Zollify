import type { SalesEvent } from '@zollify/shared';

/**
 * Invoice PDF → expense fields, through the Anthropic Messages API. One fetch,
 * no SDK; the PDF goes as a document block so no PDF parsing happens here.
 * Cost is bounded by the caller's daily caps, a cheap model, a small
 * max_tokens and a PDF size cap.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';

export interface AiConfig {
  apiKey: string;
  model: string;
  dailyCalls: number;
  dailyTokens: number;
  maxTokens: number;
  maxPdfBytes: number;
  timeoutMs: number;
}

export function loadAiConfig(env: Record<string, string>): AiConfig {
  return {
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.ZOLLIFY_AI_MODEL || 'claude-haiku-4-5',
    dailyCalls: Number(env.ZOLLIFY_AI_DAILY_CALLS) || 100,
    dailyTokens: Number(env.ZOLLIFY_AI_DAILY_TOKENS) || 2_000_000,
    maxTokens: 1024,
    maxPdfBytes: 5 * 1024 * 1024,
    timeoutMs: 25_000,
  };
}

/** Lists models - a validity check that spends no tokens. */
export async function pingAiKey(apiKey: string, timeoutMs = 8000): Promise<{ ok: boolean; detail?: string }> {
  if (!apiKey) return { ok: false, detail: 'No API key set.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(MODELS_URL, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal: ctrl.signal });
    if (r.status === 200) return { ok: true };
    if (r.status === 401) return { ok: false, detail: 'Key rejected (401).' };
    return { ok: false, detail: `Anthropic returned ${r.status}.` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error && e.name === 'AbortError' ? 'Timed out.' : 'Could not reach Anthropic.' };
  } finally {
    clearTimeout(timer);
  }
}

const PROMPT = `You are extracting expense data from a single invoice or receipt PDF - a business cost for a market/convention vendor (hotel, travel, booth/stand fee, or other).
Return ONLY a JSON object, no prose, with exactly these keys:
{
  "vendor": string,            // business name on the invoice, e.g. "Hotel Ibis Koeln"
  "category": "booth"|"travel"|"accommodation"|"other",
  "amount": number,            // grand total actually paid, incl. tax; digits only, no currency symbol
  "currency": string,          // ISO 4217, 3 letters, e.g. "EUR"
  "date": string,              // invoice/issue date, YYYY-MM-DD; "" if unknown
  "stayStart": string,         // hotel check-in / service start, YYYY-MM-DD; "" if not applicable
  "stayEnd": string,           // hotel check-out / service end, YYYY-MM-DD; "" if not applicable
  "country": string,           // country of the vendor/venue, English name, e.g. "Germany"; "" if unknown
  "confidence": number         // 0..1, your confidence in amount + date
}
Rules: use the final grand total (never a subtotal or a per-night rate). If several dates appear, "date" is the invoice date and stayStart/stayEnd are the accommodation nights. Category is "accommodation" for hotels, "travel" for flights/trains/fuel/taxi/parking, "booth" for stand/table/exhibitor fees, otherwise "other".`;

export interface InvoiceFields {
  vendor: string;
  category: 'booth' | 'travel' | 'accommodation' | 'other';
  amount: number;
  currency: string;
  date: string;
  stayStart: string;
  stayEnd: string;
  country: string;
  confidence: number;
}

export async function parseInvoicePdf(base64: string, cfg: AiConfig): Promise<{ fields: InvoiceFields; usage: { inputTokens: number; outputTokens: number } }> {
  const payload = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      },
      // Prefill forces a bare JSON object with no preamble.
      { role: 'assistant', content: '{' },
    ],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e instanceof Error && e.name === 'AbortError' ? 'The document reader timed out.' : 'Could not reach the document reader.');
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? `Reader error (${res.status}).`);
  const text = '{' + (Array.isArray(data.content) ? data.content.map((b) => b.text ?? '').join('') : '');
  return {
    fields: coerceFields(safeJson(text)),
    usage: { inputTokens: Number(data.usage?.input_tokens) || 0, outputTokens: Number(data.usage?.output_tokens) || 0 },
  };
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* give up */
      }
    }
    return {};
  }
}

const CATS = new Set(['booth', 'travel', 'accommodation', 'other']);
const isoDate = (s: unknown): string => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) ? String(s) : '');

export function coerceFields(raw: unknown): InvoiceFields {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const category = String(o.category ?? '');
  return {
    vendor: String(o.vendor ?? '').slice(0, 200),
    category: (CATS.has(category) ? category : 'other') as InvoiceFields['category'],
    amount: Math.max(0, Math.round((Number(o.amount) || 0) * 100) / 100),
    currency: String(o.currency ?? 'EUR').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'EUR',
    date: isoDate(o.date),
    stayStart: isoDate(o.stayStart),
    stayEnd: isoDate(o.stayEnd),
    country: String(o.country ?? '').slice(0, 60),
    confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
  };
}

// ── Event matching ───────────────────────────────────────────────────────────

export interface EventCandidate {
  eventId: string;
  name: string;
  country: string;
  start: string;
  score: number;
  why: string[];
}

/** Date overlap (with two days' slack) is the strong signal; country a boost. */
export function matchEvent(fields: InvoiceFields, events: SalesEvent[]): { match: EventCandidate | null; candidates: EventCandidate[] } {
  const iv = invoiceRange(fields);
  const country = normCountry(fields.country);
  const scored = events
    .map((ev) => {
      const evStart = isoDate(ev.dateStart);
      const evEnd = isoDate(ev.dateEnd) || evStart;
      const why: string[] = [];
      let score = 0;
      if (iv && evStart && iv.start <= addDays(evEnd, 2) && addDays(evStart, -2) <= iv.end) {
        score += 60;
        why.push('dates');
      }
      const evCountry = normCountry(ev.venue?.country);
      if (country && evCountry && country === evCountry) {
        score += 30;
        why.push('country');
      }
      return { eventId: ev.id, name: ev.name || ev.id, country: ev.venue?.country ?? '', start: evStart, score, why };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const match = top && top.score >= 60 && (!scored[1] || scored[1].score < top.score) ? top : null;
  return { match, candidates: scored.slice(0, 5) };
}

function invoiceRange(f: InvoiceFields): { start: string; end: string } | null {
  const start = f.stayStart || f.date;
  if (!start) return null;
  return { start, end: f.stayEnd || f.stayStart || f.date || start };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const COUNTRY_ALIASES: Record<string, string> = {
  de: 'germany', deu: 'germany', deutschland: 'germany', ger: 'germany',
  at: 'austria', aut: 'austria', oesterreich: 'austria', österreich: 'austria',
  be: 'belgium', bel: 'belgium', belgie: 'belgium', belgië: 'belgium', belgique: 'belgium',
  nl: 'netherlands', nld: 'netherlands', nederland: 'netherlands', holland: 'netherlands',
  fr: 'france', fra: 'france', frankreich: 'france',
  uk: 'united kingdom', gb: 'united kingdom', gbr: 'united kingdom', england: 'united kingdom',
  us: 'united states', usa: 'united states', 'united states of america': 'united states',
  ch: 'switzerland', che: 'switzerland', schweiz: 'switzerland',
  it: 'italy', ita: 'italy', italia: 'italy',
  es: 'spain', esp: 'spain', españa: 'spain', espana: 'spain',
};

function normCountry(c: unknown): string {
  const s = String(c ?? '').trim().toLowerCase();
  return COUNTRY_ALIASES[s] ?? s;
}
