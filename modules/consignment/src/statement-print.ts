import { fmtPrice, localIsoDay, vatSplit, type ConsignmentLine, type ConsignmentPayout, type Consignor, type CurrencyBalance, type ReportPeriod } from '@zollify/shared';

const h = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface StatementPrintInput {
  store: { name: string; address: string[]; vatId: string };
  artist: Consignor;
  /** The period the statement covers - the one still running, usually. */
  period: ReportPeriod;
  /** The artist's lines in that period, newest first. */
  lines: ConsignmentLine[];
  payouts: ConsignmentPayout[];
  /** The running balance across everything, per currency. */
  totals: CurrencyBalance[];
  storeName: (id: string) => string;
}

const money = (n: number, c: string): string => fmtPrice(n, c);
const fmtDay = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * A statement to hand an artist any day, not only at period end: what sold
 * so far this period, the split, and what the store owes them right now.
 * It says so on its face - provisional, not an invoice - because the invoice
 * (self-billing) is issued once the period closes and carries a number; two
 * documents that look alike for the same money is how one gets paid twice.
 *
 * For a VAT-registered artist the share is split into net and VAT per rate:
 * under self-billing the store writes the artist's invoice, and an invoice
 * without VAT lines is not one.
 */
export function statementHtml(input: StatementPrintInput): string {
  const { store, artist, period, lines, payouts, totals } = input;
  const currencies = [...new Set([...lines.map((l) => l.currency), ...totals.map((t) => t.currency)])].sort();
  const today = localIsoDay();

  const section = (currency: string): string => {
    const own = lines.filter((l) => l.currency === currency);
    const gross = own.reduce((s, l) => s + Math.round(l.gross * 100), 0) / 100;
    const commission = own.reduce((s, l) => s + Math.round(l.commission * 100), 0) / 100;
    const share = own.reduce((s, l) => s + Math.round(l.artistShare * 100), 0) / 100;
    const split = artist.vatRegistered ? vatSplit(own, (l) => l.artistShare) : [];
    const balance = totals.find((t) => t.currency === currency);
    const paid = payouts.filter((p) => p.currency === currency && p.date >= period.from && p.date <= period.to);
    return `
<h2>${currencies.length > 1 ? `${h(currency)} - ` : ''}Sales ${h(fmtDay(period.from))} to ${h(fmtDay(today < period.to ? today : period.to))}</h2>
${
  own.length
    ? `<table>
<thead><tr><th>Date</th><th>Item</th><th>Sold at</th><th class="n">Qty</th><th class="n">Sold<br/><small>incl. VAT</small></th><th class="n">Commission ${h(uniquePct(own))}<br/><small>incl. VAT</small></th><th class="n">Your share<br/><small>incl. VAT</small></th></tr></thead>
<tbody>
${own
  .slice()
  .sort((a, b) => a.at - b.at)
  .map(
    (l) =>
      `<tr><td>${h(localIsoDay(l.at))}</td><td>${h(l.title)}${l.variantLabel ? ` · ${h(l.variantLabel)}` : ''}</td><td>${h(input.storeName(l.storeId))}</td><td class="n">${l.qty}</td><td class="n">${h(money(l.gross, currency))}</td><td class="n">${h(money(l.commission, currency))}</td><td class="n">${h(money(l.artistShare, currency))}</td></tr>`,
  )
  .join('\n')}
</tbody>
<tfoot><tr><th colspan="4">Total this period</th><th class="n">${h(money(gross, currency))}</th><th class="n">${h(money(commission, currency))}</th><th class="n">${h(money(share, currency))}</th></tr></tfoot>
</table>`
    : `<p class="muted">Nothing sold so far this period.</p>`
}
${
  split.length
    ? `<h3>VAT in your share</h3>
<p class="muted">You are VAT-registered${artist.vatId ? ` (${h(artist.vatId)})` : ''}, so your share is shown net and with the VAT each item sold at. The commission is the store's VAT-inclusive fee.</p>
<table class="vat"><thead><tr><th>Rate</th><th class="n">Net</th><th class="n">VAT</th><th class="n">Share incl. VAT</th></tr></thead>
<tbody>${split.map((r) => `<tr><td>${r.rate == null ? 'No VAT' : `${r.rate}%`}</td><td class="n">${h(money(r.net, currency))}</td><td class="n">${h(money(r.vat, currency))}</td><td class="n">${h(money(r.gross, currency))}</td></tr>`).join('')}</tbody></table>`
    : ''
}
${paid.length ? `<h3>Paid to you this period</h3><ul>${paid.map((p) => `<li>${h(p.date)} - ${h(money(p.amount, currency))}${p.note ? ` (${h(p.note)})` : ''}</li>`).join('')}</ul>` : ''}
${
  balance
    ? `<div class="balance"><span>${balance.balance >= 0 ? 'Owed to you today' : 'You owe the store today'}</span><strong>${h(money(Math.abs(balance.balance), currency))}</strong>
<small>All your sales to date${balance.rent ? ', less space rent' : ''}${balance.fees ? ', less fees' : ''}${balance.cardFees ? ', less card costs' : ''}, less ${h(money(balance.paid, currency))} already paid.</small></div>`
    : ''
}`;
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Statement - ${h(artist.name)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#000;background:#fff;font-size:13px;max-width:820px}
header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:18px}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:15px;margin:22px 0 8px}
h3{font-size:13px;margin:16px 0 6px}
.tag{display:inline-block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;border:1px solid #000;border-radius:999px;padding:2px 8px;margin-bottom:6px}
.muted{color:#555;margin:4px 0}
address{font-style:normal;text-align:right;color:#333;line-height:1.4}
table{width:100%;border-collapse:collapse;margin-top:6px}
th,td{padding:5px 6px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#444}
th small{display:block;text-transform:none;letter-spacing:0;font-weight:400}
tfoot th{border-top:2px solid #000;border-bottom:0;font-size:12px;text-transform:none}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.vat{max-width:420px}
.balance{margin-top:16px;padding:10px 14px;border:2px solid #000;border-radius:8px;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:baseline}
.balance span{font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.balance strong{font-size:18px}
.balance small{flex-basis:100%;color:#555}
footer{margin-top:28px;font-size:11px;color:#555;border-top:1px solid #ddd;padding-top:8px}
ul{margin:4px 0;padding-left:18px}
@media print{body{padding:0}}
</style></head>
<body>
<header>
  <div>
    <div class="tag">Provisional statement - not an invoice</div>
    <h1>${h(artist.name)}</h1>
    ${artist.vatId ? `<p class="muted">Tax no. ${h(artist.vatId)}</p>` : ''}
    <p class="muted">As of ${h(fmtDay(today))}</p>
  </div>
  <address><strong>${h(store.name)}</strong><br/>${store.address.filter(Boolean).map(h).join('<br/>')}${store.vatId ? `<br/>VAT ${h(store.vatId)}` : ''}</address>
</header>
${currencies.length ? currencies.map(section).join('\n') : '<p class="muted">Nothing sold or paid yet.</p>'}
<footer>Commission is taken from what the customer paid for each item, discounts included; reverted sales are left out. The figures run until the period closes on ${h(fmtDay(period.to))}, when ${h(store.name)} issues the numbered statement (self-billing invoice) for it. Pay nothing against this document.</footer>
</body></html>`;
}

/** "40%" when every line in the list has the same commission, otherwise blank - the per-line figures say it. */
function uniquePct(lines: ConsignmentLine[]): string {
  const pcts = new Set(lines.map((l) => l.commissionPct));
  return pcts.size === 1 ? `${[...pcts][0]}%` : '';
}
