import { countryCodeOf, paidLineTotals, receiptBreakdown, vatBreakdown, type CashClosing, type SalesEvent, type Transaction, type TseSignature } from '@zollify/shared';
import { DTD_FILE, GDPDU_DTD, INDEX_XML } from './official';

/**
 * The DSFinV-K export (version 2.4): what a German tax inspection reads from
 * a till - the closings (Kassenabschlüsse), every receipt in them with its
 * lines, VAT, payments and TSE signature, and the master data around them.
 *
 * Built from the account's synced records, so it covers every device. Each
 * file's columns come straight from the official index.xml shipped with it,
 * and the formats are the spec's: ";" between fields, "," as decimal mark,
 * CRLF line ends, UTF-8, a header row.
 *
 * Mapping (see docs/germany-compliance.md):
 *   - a closing is a CashClosing; a receipt is a sale (tx.receipt) or the
 *     cancellation of one (tx.revertReceipt): BON_TYP "Beleg", the
 *     cancellation with BON_STORNO 1, every amount negative and a reference
 *     to the receipt it cancels - how a cancellation is shown with a TSE;
 *   - VAT keys per Anlage 2: 19% → 1, 7% → 2, 10.7% → 3, 5.5% → 4; a sale
 *     exempt as a small business → 6 ("Umsatzsteuerfrei"); a sale without
 *     VAT data → 7 ("UmsatzsteuerNichtErmittelbar");
 *   - payments: cash "Bar", everything else "Unbar", named after the method.
 */

export interface DsfinvkInput {
  closings: CashClosing[];
  transactions: Transaction[];
  events: SalesEvent[];
  seller: { name: string; street: string; postCodeCity: string; country: string; vatId: string; taxNumber?: string };
  /** Closings whose business day is in this range (YYYY-MM-DD, both included). */
  from: string;
  to: string;
  /** Only closings at events in Germany. */
  germanyOnly: boolean;
}

export interface DsfinvkResult {
  /** File name → content. */
  files: Record<string, string>;
  /** Closings in the export. */
  closings: number;
  receipts: number;
  /** What an inspector would find missing or odd - shown before downloading. */
  warnings: string[];
}

// ── The official column lists ───────────────────────────────────────────────

/** A column as index.xml defines it: a number with so many decimal places, or text up to a length. */
interface Column {
  name: string;
  /** Decimal places of a numeric column; undefined for text. */
  places?: number;
  maxLength?: number;
}

/** File name → its columns, in order, as the official index.xml defines them. */
const SPEC: Record<string, Column[]> = (() => {
  const out: Record<string, Column[]> = {};
  for (const table of INDEX_XML.split('<Table>').slice(1)) {
    const url = /<URL>([^<]+)<\/URL>/.exec(table)?.[1];
    if (!url) continue;
    out[url] = [...table.matchAll(/<VariableColumn>([\s\S]*?)<\/VariableColumn>/g)].map((m) => {
      const def = m[1]!;
      const name = /<Name>([^<]+)<\/Name>/.exec(def)![1]!;
      if (/<Numeric\s*\/>|<Numeric>/.test(def)) return { name, places: Number(/<Accuracy>(\d+)<\/Accuracy>/.exec(def)?.[1] ?? 0) };
      const max = /<MaxLength>(\d+)<\/MaxLength>/.exec(def)?.[1];
      return { name, ...(max ? { maxLength: Number(max) } : {}) };
    });
  }
  return out;
})();

/** File name → its column names, in order. */
export const COLUMNS: Record<string, string[]> = Object.fromEntries(Object.entries(SPEC).map(([f, cols]) => [f, cols.map((c) => c.name)]));

/** Numbers are passed as numbers and written with the places index.xml gives their column. */
type Row = Record<string, string | number | undefined>;

// ── Formats ─────────────────────────────────────────────────────────────────

/** An amount, to the cent - written out with as many places as its column has (two or five). */
const money = (n: number): number => Math.round(n * 100) / 100;
const qty = (n: number): number => Math.round(n * 1000) / 1000;

/** A number as index.xml wants it: "," as decimal mark, no grouping, exactly `places` decimals. */
function decimal(n: number, places: number): string {
  const scale = 10 ** places;
  const units = Math.round(n * scale);
  const abs = Math.abs(units);
  const whole = Math.floor(abs / scale);
  return `${units < 0 ? '-' : ''}${whole}${places ? `,${String(abs % scale).padStart(places, '0')}` : ''}`;
}

/** RFC 3339, UTC, to the second - as the spec's examples. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** One field: a number in its column's format, or text cut to its column's length, quoted only when it has to be. */
function cell(col: Column, v: string | number | undefined): string {
  if (v === undefined || v === null || v === '') return '';
  if (col.places !== undefined) return decimal(typeof v === 'number' ? v : Number(v), col.places);
  let s = String(v);
  if (col.maxLength) s = s.slice(0, col.maxLength);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(file: string, rows: Row[]): string {
  const cols = SPEC[file];
  if (!cols) throw new Error(`${file} is not in index.xml`);
  const lines = [cols.map((c) => c.name).join(';'), ...rows.map((r) => cols.map((c) => cell(c, r[c.name])).join(';'))];
  return lines.join('\r\n') + '\r\n';
}

const ALPHA3: Record<string, string> = {
  AT: 'AUT', BE: 'BEL', BG: 'BGR', CH: 'CHE', CY: 'CYP', CZ: 'CZE', DE: 'DEU', DK: 'DNK', EE: 'EST', ES: 'ESP', FI: 'FIN',
  FR: 'FRA', GB: 'GBR', GR: 'GRC', HR: 'HRV', HU: 'HUN', IE: 'IRL', IS: 'ISL', IT: 'ITA', LI: 'LIE', LT: 'LTU', LU: 'LUX',
  LV: 'LVA', MT: 'MLT', NL: 'NLD', NO: 'NOR', PL: 'POL', PT: 'PRT', RO: 'ROU', SE: 'SWE', SI: 'SVN', SK: 'SVK', US: 'USA',
  CA: 'CAN', JP: 'JPN', AU: 'AUS', NZ: 'NZL', MC: 'MCO', SM: 'SMR', AD: 'AND',
};
const alpha3 = (country: string | undefined): string => ALPHA3[countryCodeOf(country)] ?? '';

/** "8000 Zürich" → postcode and place. */
function splitPostCodeCity(s: string): { plz: string; ort: string } {
  const m = /^\s*(\S*\d\S*)\s+(.+)$/.exec(s);
  return m ? { plz: m[1]!, ort: m[2]!.trim() } : { plz: '', ort: s.trim() };
}

// ── VAT keys (DSFinV-K Anlage 2) ────────────────────────────────────────────

const VAT_KEYS: Record<number, { satz: number; beschr: string }> = {
  1: { satz: 19, beschr: 'Allgemeiner Steuersatz' },
  2: { satz: 7, beschr: 'Ermäßigter Steuersatz' },
  3: { satz: 10.7, beschr: 'Durchschnittsatz (§ 24 Abs. 1 Nr. 3 UStG)' },
  4: { satz: 5.5, beschr: 'Durchschnittsatz (§ 24 Abs. 1 Nr. 1 UStG)' },
  6: { satz: 0, beschr: 'Umsatzsteuerfrei' },
  7: { satz: 0, beschr: 'UmsatzsteuerNichtErmittelbar' },
};

/** The key for a line's rate; null when the rate is not a German one. */
function vatKey(tx: Transaction, rate: number | null | undefined): number | null {
  if (!tx.tax) return 7;
  if (tx.tax.exempt) return 6;
  if (rate == null) return 7;
  if (rate === 19) return 1;
  if (rate === 7) return 2;
  if (rate === 10.7) return 3;
  if (rate === 5.5) return 4;
  if (rate === 0) return 6;
  return null;
}

/** VAT inside a gross amount at a rate, to the cent. */
const vatIn = (gross: number, rate: number): number => Math.round((Math.round(gross * 100) * rate) / (100 + rate)) / 100;

// ── The export ──────────────────────────────────────────────────────────────

interface Bon {
  tx: Transaction;
  number: number;
  /** -1 for the cancellation of a sale. */
  sign: 1 | -1;
  tse: Transaction['tse'];
}

export function buildDsfinvk(input: DsfinvkInput): DsfinvkResult {
  const warnings: string[] = [];
  const events = new Map(input.events.map((e) => [e.id, e]));
  const inGermany = (c: CashClosing): boolean => countryCodeOf(events.get(c.eventId)?.venue?.country) === 'DE';

  // Every receipt by till and number, sales and cancellations alike.
  const byTill = new Map<string, Map<number, Bon>>();
  const put = (till: string, bon: Bon): void => {
    if (!byTill.has(till)) byTill.set(till, new Map());
    byTill.get(till)!.set(bon.number, bon);
  };
  for (const tx of input.transactions) {
    if (tx.receipt) put(tx.receipt.till, { tx, number: tx.receipt.number, sign: 1, tse: tx.tse });
    if (tx.revertReceipt) put(tx.revertReceipt.till, { tx, number: tx.revertReceipt.number, sign: -1, tse: tx.revertTse });
  }

  // Where each receipt was closed, for references from cancellations.
  const closingOf = (till: string, number: number): CashClosing | undefined =>
    input.closings.find((c) => c.till === till && number >= c.firstReceipt && number <= c.lastReceipt);

  const chosen = input.closings
    .filter((c) => c.businessDay >= input.from && c.businessDay <= input.to)
    .filter((c) => !input.germanyOnly || inGermany(c))
    .sort((a, b) => a.till.localeCompare(b.till) || a.number - b.number);

  // Receipts in the range that no closing covers yet.
  for (const [till, bons] of byTill) {
    const open = [...bons.values()].filter((b) => !closingOf(till, b.number));
    const inRange = open.filter((b) => {
      const day = new Date(b.sign > 0 ? b.tx.timestamp : (b.tx.revertedAt ?? b.tx.timestamp)).toISOString().slice(0, 10);
      return day >= input.from && day <= input.to;
    });
    if (inRange.length) warnings.push(`Till ${till}: ${inRange.length} receipt(s) not closed yet - close the day on that device, let it sync, then export again.`);
  }

  const t: Record<string, Row[]> = {};
  for (const file of Object.keys(COLUMNS)) t[file] = [];
  let receipts = 0;

  for (const c of chosen) {
    const z = { Z_KASSE_ID: c.till, Z_ERSTELLUNG: stamp(c.createdAt), Z_NR: c.number };
    const bons: Bon[] = [];
    for (let n = c.firstReceipt; n <= c.lastReceipt; n++) {
      const bon = byTill.get(c.till)?.get(n);
      if (bon) bons.push(bon);
      else warnings.push(`Till ${c.till}: receipt ${n} (closing ${c.number}) is not on the server - the device that took it may not have synced.`);
    }
    receipts += bons.length;
    if (c.receipts !== bons.length && bons.length === c.lastReceipt - c.firstReceipt + 1) {
      warnings.push(`Till ${c.till}, closing ${c.number}: counted ${c.receipts} receipt(s) when closed, ${bons.length} now.`);
    }

    const tses: TseSignature[] = [];
    const tseId = (sig: TseSignature): number => {
      let i = tses.findIndex((s) => s.serial === sig.serial);
      if (i < 0) i = tses.push(sig) - 1;
      return i + 1;
    };
    const usedKeys = new Set<number>();
    let unknownVat = false;
    const sumsByKey = new Map<number, { brutto: number; netto: number; ust: number }>();
    const sumsByPayment = new Map<string, { typ: string; name: string; amount: number }>();
    let cash = 0;
    let payments = 0;

    for (const bon of bons) {
      const { tx, sign } = bon;
      const s = (n: number): number => sign * n;
      const bonId = String(bon.number);
      const head = { ...z, BON_ID: bonId };
      const sig = bon.tse && 'signed' in bon.tse ? bon.tse.signed : undefined;
      const end = sign > 0 ? tx.timestamp : (tx.revertedAt ?? tx.timestamp);

      // Receipt head, as printed.
      t['transactions.csv']!.push({
        ...head,
        BON_NR: bon.number,
        BON_TYP: 'Beleg',
        BON_NAME: sign < 0 ? 'Storno' : '',
        BON_STORNO: sign < 0 ? '1' : '0',
        BON_START: stamp(sig ? Date.parse(sig.start) : end),
        BON_ENDE: stamp(end),
        UMS_BRUTTO: money(s(tx.total)),
      });

      // VAT per key, as printed on the receipt.
      const printed = vatBreakdown(tx);
      if (printed.length) {
        for (const r of printed) {
          const key = vatKey(tx, r.rate) ?? 7;
          usedKeys.add(key);
          t['transactions_vat.csv']!.push({ ...head, UST_SCHLUESSEL: key, BON_BRUTTO: money(s(r.gross)), BON_NETTO: money(s(r.net)), BON_UST: money(s(r.vat)) });
        }
      } else {
        const key = vatKey(tx, null) ?? 7;
        usedKeys.add(key);
        t['transactions_vat.csv']!.push({ ...head, UST_SCHLUESSEL: key, BON_BRUTTO: money(s(tx.total)), BON_NETTO: money(s(tx.total)), BON_UST: money(0) });
      }

      // Lines, at what they cost after discounts; the list price and the discount besides.
      const paid = paidLineTotals(tx);
      const list = receiptBreakdown(tx).lines;
      tx.items.forEach((item, i) => {
        const rate = tx.tax && !tx.tax.exempt ? (tx.tax.rates[i] ?? null) : null;
        let key = vatKey(tx, rate);
        if (key == null) {
          warnings.push(`Till ${c.till}, receipt ${bon.number}: ${rate}% is not a German VAT rate.`);
          key = 7;
        }
        if (key === 7) unknownVat = true;
        usedKeys.add(key);
        const pct = VAT_KEYS[key]!.satz;
        const gross = paid[i] ?? item.lineTotal;
        const vat = vatIn(gross, pct);
        const line = { ...head, POS_ZEILE: String(i + 1) };
        const base = list[i] ?? gross;
        t['lines.csv']!.push({
          ...line,
          ARTIKELTEXT: item.variantLabel ? `${item.title} (${item.variantLabel})` : item.title,
          GV_TYP: 'Umsatz',
          INHAUS: '0',
          P_STORNO: '0',
          AGENTUR_ID: 0,
          ART_NR: item.vid ? `${item.pid}:${item.vid}` : item.pid,
          MENGE: qty(s(item.qty)),
          STK_BR: money(item.qty ? base / item.qty : base),
        });
        t['lines_vat.csv']!.push({ ...line, UST_SCHLUESSEL: key, POS_BRUTTO: money(s(gross)), POS_NETTO: money(s(gross - vat)), POS_UST: money(s(vat)) });
        t['itemamounts.csv']!.push({ ...line, TYP: 'base_amount', UST_SCHLUESSEL: key, PF_BRUTTO: money(s(base)), PF_NETTO: money(s(base - vatIn(base, pct))), PF_UST: money(s(vatIn(base, pct))) });
        const off = Math.round((base - gross) * 100) / 100;
        if (off > 0) {
          t['itemamounts.csv']!.push({ ...line, TYP: 'discount', UST_SCHLUESSEL: key, PF_BRUTTO: money(s(-off)), PF_NETTO: money(s(-(off - vatIn(off, pct)))), PF_UST: money(s(-vatIn(off, pct))) });
        }
        const sum = sumsByKey.get(key) ?? { brutto: 0, netto: 0, ust: 0 };
        sum.brutto += s(gross);
        sum.netto += s(gross - vat);
        sum.ust += s(vat);
        sumsByKey.set(key, sum);
      });

      // Payments.
      for (const leg of tx.payments) {
        const typ = leg.kind === 'cash' ? 'Bar' : 'Unbar';
        const name = leg.kind === 'cash' ? 'Bar' : String(leg.provider && leg.provider !== 'manual' ? leg.provider : tx.method || 'Karte').slice(0, 60);
        t['datapayment.csv']!.push({ ...head, ZAHLART_TYP: typ, ZAHLART_NAME: name, BASISWAEH_BETRAG: money(s(leg.amount)) });
        const k = `${typ}|${name}`;
        const p = sumsByPayment.get(k) ?? { typ, name, amount: 0 };
        p.amount += s(leg.amount);
        sumsByPayment.set(k, p);
        payments += s(leg.amount);
        if (typ === 'Bar') cash += s(leg.amount);
      }

      // A cancellation points to the receipt it cancels.
      if (sign < 0 && tx.receipt) {
        const original = closingOf(tx.receipt.till, tx.receipt.number);
        t['references.csv']!.push({
          ...head,
          REF_TYP: 'Transaktion',
          REF_DATUM: original ? stamp(original.createdAt) : '',
          REF_Z_KASSE_ID: tx.receipt.till,
          REF_Z_NR: original?.number,
          REF_BON_ID: String(tx.receipt.number),
        });
      }

      // The TSE's part.
      if (sig) {
        t['transactions_tse.csv']!.push({
          ...head,
          TSE_ID: tseId(sig),
          TSE_TANR: sig.transactionNumber,
          TSE_TA_START: sig.start,
          TSE_TA_ENDE: sig.finish,
          TSE_TA_VORGANGSART: sig.processType,
          TSE_TA_SIGZ: sig.signatureCounter,
          TSE_TA_SIG: sig.signature,
          TSE_TA_FEHLER: sig.test ? 'Test-TSE, nicht zertifiziert' : '',
          TSE_VORGANGSDATEN: sig.processData,
        });
      } else if (bon.tse && 'failed' in bon.tse) {
        t['transactions_tse.csv']!.push({ ...head, TSE_TA_FEHLER: `TSE ausgefallen: ${bon.tse.failed.reason}`.slice(0, 200) });
      }
    }

    // Closing totals.
    for (const [key, sum] of [...sumsByKey].sort((a, b) => a[0] - b[0])) {
      t['businesscases.csv']!.push({ ...z, GV_TYP: 'Umsatz', AGENTUR_ID: 0, UST_SCHLUESSEL: key, Z_UMS_BRUTTO: money(sum.brutto), Z_UMS_NETTO: money(sum.netto), Z_UST: money(sum.ust) });
    }
    for (const p of sumsByPayment.values()) t['payment.csv']!.push({ ...z, ZAHLART_TYP: p.typ, ZAHLART_NAME: p.name, Z_ZAHLART_BETRAG: money(p.amount) });
    t['cash_per_currency.csv']!.push({ ...z, ZAHLART_WAEH: c.currency, ZAHLART_BETRAG_WAEH: money(cash) });

    // Master data, per closing.
    const { plz, ort } = splitPostCodeCity(input.seller.postCodeCity);
    const createdDay = new Date(c.createdAt).toISOString().slice(0, 10);
    t['cashpointclosing.csv']!.push({
      ...z,
      Z_BUCHUNGSTAG: c.businessDay !== createdDay ? c.businessDay : '',
      TAXONOMIE_VERSION: '2.4',
      Z_START_ID: bons[0] ? String(bons[0].number) : '',
      Z_ENDE_ID: bons.length ? String(bons[bons.length - 1]!.number) : '',
      NAME: input.seller.name.slice(0, 60),
      STRASSE: input.seller.street.slice(0, 60),
      PLZ: plz.slice(0, 10),
      ORT: ort.slice(0, 62),
      LAND: alpha3(input.seller.country),
      STNR: input.seller.taxNumber ?? '',
      USTID: input.seller.vatId.replace(/\s/g, '').slice(0, 15),
      Z_SE_ZAHLUNGEN: money(payments),
      Z_SE_BARZAHLUNGEN: money(cash),
    });
    const ev = events.get(c.eventId);
    t['location.csv']!.push({
      ...z,
      LOC_NAME: (ev?.name ?? '').slice(0, 60),
      LOC_STRASSE: (ev?.venue?.street ?? '').slice(0, 60),
      LOC_PLZ: (ev?.venue?.postcode ?? '').slice(0, 10),
      LOC_ORT: (ev?.venue?.city ?? '').slice(0, 62),
      LOC_LAND: alpha3(ev?.venue?.country),
    });
    t['cashregister.csv']!.push({
      ...z,
      KASSE_BRAND: c.device.brand,
      KASSE_MODELL: c.device.model,
      KASSE_SERIENNR: c.till,
      KASSE_SW_BRAND: c.device.software,
      KASSE_SW_VERSION: c.device.version,
      KASSE_BASISWAEH_CODE: c.currency,
      KEINE_UST_ZUORDNUNG: unknownVat ? '1' : '0',
    });
    for (const key of [...usedKeys].sort((a, b) => a - b)) {
      const k = VAT_KEYS[key]!;
      t['vat.csv']!.push({ ...z, UST_SCHLUESSEL: key, UST_SATZ: money(k.satz), UST_BESCHR: k.beschr });
    }
    tses.forEach((sig, i) => {
      t['tse.csv']!.push({
        ...z,
        TSE_ID: i + 1,
        TSE_SERIAL: sig.serial,
        TSE_SIG_ALGO: sig.algorithm,
        TSE_ZEITFORMAT: sig.timeFormat,
        TSE_PD_ENCODING: 'UTF-8',
        TSE_PUBLIC_KEY: sig.publicKey,
      });
      if (sig.test) warnings.push(`Till ${c.till}, closing ${c.number}: signed by a test TSE, which is not certified.`);
    });
    if (c.currency !== 'EUR') warnings.push(`Till ${c.till}, closing ${c.number}: in ${c.currency}, not EUR.`);
  }

  if (!input.seller.vatId.trim() && !input.seller.taxNumber) warnings.push('Your profile has no VAT number - the export needs it (or a tax number).');
  if (!input.seller.street.trim() || !input.seller.postCodeCity.trim()) warnings.push('Your profile has no full address.');

  const files: Record<string, string> = {};
  for (const [file, rows] of Object.entries(t)) files[file] = csv(file, rows);
  files['index.xml'] = INDEX_XML;
  files[DTD_FILE] = GDPDU_DTD;
  return { files, closings: chosen.length, receipts, warnings: [...new Set(warnings)] };
}
