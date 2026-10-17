import { z } from 'zod';
import { RENT_REF_KIND, baseFactor, commissionFor, type Consignor } from './consignment';
import { localDay } from './consignment-books';
import type { Transaction } from './types';
import { bookLineTotals } from './charged-lines';

/**
 * A day of till sales as one e-conomic journal voucher (kassekladde).
 *
 * The store's accountant posts the journal and e-conomic files the VAT
 * return from the VAT codes on each line, so this only has to split the day
 * correctly: revenue by VAT code on the credit side, takings by payment kind
 * on the debit side, adding up to zero.
 *
 * Renters' goods follow the store's consignment setting. As an agent
 * (formidler) only the commission is the store's revenue; the renter's share
 * is owed to them and sits on a liability account until it is paid out. In a
 * commission sale (kommissionssalg) the store sells in its own name and the
 * full price is revenue - its accountant must confirm which one applies.
 *
 * A reverted sale stays on the day it was made and is booked back on the day
 * it was reverted, so a day already booked never changes.
 */

export const ECONOMIC_TZ = 'Europe/Copenhagen';

const AccountNumber = z.number().int().min(1).max(999_999_999);

export const EconomicSettingsSchema = z.object({
  journalNumber: z.number().int().min(1).default(1),
  accounts: z
    .object({
      /** Own goods, and renters' goods in a commission sale. */
      sales: AccountNumber.nullable().default(null),
      /** Shelf and space rent taken at the till: a taxable service, not exempt letting. */
      rent: AccountNumber.nullable().default(null),
      /** The store's commission on renters' goods, as an agent. */
      commission: AccountNumber.nullable().default(null),
      /** Owed to renters (skyldig til reollejere), as an agent. */
      renters: AccountNumber.nullable().default(null),
      cash: AccountNumber.nullable().default(null),
      card: AccountNumber.nullable().default(null),
    })
    .prefault({}),
  /** e-conomic VAT code per rate, e.g. { "25": "U25" }. */
  vatCodes: z.record(z.string().regex(/^\d+(\.\d+)?$/), z.string().trim().min(1).max(10)).default({ '25': 'U25' }),
  consignment: z.enum(['agency', 'commission']).default('agency'),
  timeZone: z.string().min(1).max(60).default(ECONOMIC_TZ),
});
export type EconomicSettings = z.infer<typeof EconomicSettingsSchema>;
export type EconomicAccountKey = keyof EconomicSettings['accounts'];

/** One journal line. `amount` is + debit, − credit, in the books' currency. */
export interface JournalLine {
  key: EconomicAccountKey;
  account: number | null;
  amount: number;
  vatCode?: string;
  text: string;
}

export interface DayJournal {
  day: string;
  currency: string | null;
  lines: JournalLine[];
  /** Sales made this day, and sales made earlier that were reverted this day. */
  sales: number;
  reversals: number;
  /** Takings of the day, cash and card, net of reversals. */
  total: number;
  /** Why the day cannot be booked as it stands. */
  problems: string[];
}

const TEXT: Record<EconomicAccountKey, string> = {
  sales: 'Varesalg',
  rent: 'Reolleje',
  commission: 'Kommission reolsalg',
  renters: 'Skyldig til reollejere',
  cash: 'Kontant',
  card: 'Kort',
};

const toMinor = (n: number): number => Math.round(n * 100);

export function dayJournal(
  transactions: Transaction[],
  consignors: Pick<Consignor, 'id' | 'name' | 'commissionPct' | 'storeCommission' | 'commissionHistory'>[],
  day: string,
  settings: EconomicSettings,
): DayJournal {
  const byId = new Map(consignors.map((c) => [c.id, c]));
  const buckets = new Map<string, { key: EconomicAccountKey; vatCode?: string; minor: number }>();
  const problems = new Set<string>();
  const currencies = new Set<string>();
  let sales = 0;
  let reversals = 0;

  const add = (key: EconomicAccountKey, minor: number, vatCode?: string): void => {
    const id = `${key}|${vatCode ?? ''}`;
    const b = buckets.get(id) ?? { key, ...(vatCode ? { vatCode } : {}), minor: 0 };
    b.minor += minor;
    buckets.set(id, b);
  };

  for (const tx of transactions) {
    const madeToday = localDay(tx.timestamp, settings.timeZone) === day;
    const revertedToday = tx.revertedAt != null && localDay(tx.revertedAt, settings.timeZone) === day;
    // Made and reverted the same day: nothing happened, as far as the books go.
    if (madeToday === revertedToday) continue;
    const sign = madeToday ? 1 : -1;
    if (madeToday) sales++;
    else reversals++;
    currencies.add(tx.baseCurrency ?? tx.currency);
    if (!tx.tax) problems.add(`A sale at ${new Date(tx.timestamp).toISOString()} has no VAT recorded - book it by hand.`);

    let credited = 0;
    // After every discount, so a sale whose discount is listed apart from its
    // lines (an import) is not booked as more money taken than was paid.
    const lineGross = bookLineTotals(tx).map(toMinor);
    tx.items.forEach((item, i) => {
      const gross = lineGross[i]!;
      const rate = tx.tax && !tx.tax.exempt ? tx.tax.rates[i] : null;
      const vatCode = rate == null ? undefined : settings.vatCodes[String(rate)];
      if (rate != null && !vatCode) problems.add(`No e-conomic VAT code set for ${rate}%.`);
      credited += gross;
      if (item.ref?.moduleId === 'consignment' && item.ref.kind === RENT_REF_KIND) {
        add('rent', -sign * gross, vatCode);
      } else if (item.consignorId && settings.consignment === 'agency') {
        const consignor = byId.get(item.consignorId);
        const pct = typeof item.commissionPct === 'number' ? item.commissionPct : consignor ? commissionFor(consignor, tx.eventId, tx.timestamp) : null;
        if (pct == null) {
          problems.add(`"${item.title}" belongs to a renter who is no longer listed - set their commission or book it by hand.`);
          return;
        }
        const commission = Math.round((gross * pct) / 100);
        add('commission', -sign * commission, vatCode);
        add('renters', -sign * (gross - commission));
      } else {
        add('sales', -sign * gross, vatCode);
      }
    });

    // Takings by kind; the last leg takes the cent the conversion rounding leaves, so the sale balances.
    const legs = tx.payments?.length ? tx.payments : [{ kind: tx.method === 'cash' ? ('cash' as const) : ('card' as const), amount: tx.total }];
    const factor = baseFactor(tx);
    let paid = 0;
    legs.forEach((leg, n) => {
      const minor = n === legs.length - 1 ? credited - paid : toMinor(leg.amount * factor);
      paid += minor;
      add(leg.kind === 'cash' ? 'cash' : 'card', sign * minor);
    });
  }

  if (currencies.size > 1) problems.add(`Sales in more than one currency (${[...currencies].join(', ')}) - book this day by hand.`);

  const order: EconomicAccountKey[] = ['sales', 'rent', 'commission', 'renters', 'cash', 'card'];
  const lines = [...buckets.values()]
    .filter((b) => b.minor !== 0)
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key) || (a.vatCode ?? '').localeCompare(b.vatCode ?? ''))
    .map((b): JournalLine => ({
      key: b.key,
      account: settings.accounts[b.key],
      amount: b.minor / 100,
      ...(b.vatCode ? { vatCode: b.vatCode } : {}),
      text: `${TEXT[b.key]} ${day}`,
    }));
  for (const l of lines) if (l.account == null) problems.add(`Set the e-conomic account for "${TEXT[l.key]}".`);

  return {
    day,
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    lines,
    sales,
    reversals,
    total: lines.filter((l) => l.key === 'cash' || l.key === 'card').reduce((s, l) => s + toMinor(l.amount), 0) / 100,
    problems: [...problems],
  };
}
