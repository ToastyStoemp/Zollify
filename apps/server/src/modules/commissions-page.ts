import { COMMISSION_STATUSES, COMMISSION_STATUS_LABEL, type CommissionStatus, type PublicCommission } from '@zollify/shared';

/**
 * The customer's tracking page, rendered on the server as plain HTML with no
 * script at all. Every value goes through `h`, so nothing an owner or customer
 * typed can become markup, and the page needs no inline script for a strict
 * CSP to refuse.
 */

const h = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-12-31` as "31 Dec 2026". */
export function fmtDay(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1] ?? ''} ${m[1]}` : '';
}

const fmtStamp = (at: number): string => fmtDay(new Date(at).toISOString().slice(0, 10));

export function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/** The steps shown as progress; cancelled is shown as a banner instead. */
const STEPS = COMMISSION_STATUSES.filter((s): s is Exclude<CommissionStatus, 'cancelled'> => s !== 'cancelled');

const STYLE = `
:root{--bg:#f1f4f6;--surface:#fff;--text:#141a22;--muted:#5a6472;--border:#d6dde4;--accent:#0e7c66;--accent-ink:#0a5a4a;--accent-soft:#deeee9;--warn:#9a3412;--warn-soft:#ffedd5}
@media(prefers-color-scheme:dark){:root{--bg:#020617;--surface:#0f172a;--text:#f1f5f9;--muted:#a3aebd;--border:#273449;--accent:#34d399;--accent-ink:#6ee7b7;--accent-soft:rgba(52,211,153,.16);--warn:#fdba74;--warn-soft:rgba(251,146,60,.16)}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;padding:0 16px 48px}
main{max-width:520px;margin:0 auto}
header{padding:32px 0 16px}
.shop{font-size:.78rem;letter-spacing:.16em;text-transform:uppercase;color:var(--accent-ink);font-weight:700;overflow-wrap:anywhere}
h1{font-size:1.6rem;font-weight:800;letter-spacing:-.02em;margin-top:6px;overflow-wrap:anywhere;text-wrap:balance}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.status{font-size:1.15rem;font-weight:700;color:var(--accent-ink)}
.banner{background:var(--warn-soft);color:var(--warn);font-weight:700;border-radius:10px;padding:8px 12px;margin-top:10px}
.steps{list-style:none;display:flex;gap:4px;margin-top:14px}
.steps li{flex:1;height:6px;border-radius:3px;background:var(--border)}
.steps li.done{background:var(--accent)}
.steplabels{display:flex;justify-content:space-between;gap:4px;margin-top:6px;font-size:.66rem;color:var(--muted)}
.steplabels span{flex:1;text-align:center;overflow-wrap:anywhere}
.steplabels span.now{color:var(--accent-ink);font-weight:700}
h2{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
dl{display:grid;grid-template-columns:1fr auto;gap:6px 12px}
dd{text-align:right;font-weight:600}
.bal{border-top:1px solid var(--border);padding-top:6px;margin-top:2px}
.tl{list-style:none}
.tl li{padding:10px 0;border-top:1px solid var(--border)}
.tl li:first-child{border-top:0;padding-top:0}
.tl .what{font-weight:700}
.tl .when{color:var(--muted);font-size:.8rem}
.tl .msg{margin-top:2px;overflow-wrap:anywhere;white-space:pre-wrap}
.pick .name{font-weight:700}
.pick p{overflow-wrap:anywhere;white-space:pre-wrap}
.muted{color:var(--muted);font-size:.85rem}
footer{margin-top:24px;text-align:center;color:var(--muted);font-size:.72rem}
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive" />
<meta name="referrer" content="no-referrer" />
<title>${h(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>${body}</main>
</body>
</html>
`;
}

export function renderNotFound(): string {
  return shell('Not available', '<header><h1>This page is not available</h1></header><div class="card"><p class="muted">The link may have been replaced or the commission removed. Please ask the shop for a new one.</p></div>');
}

export function renderCommission(c: PublicCommission): string {
  const cancelled = c.status === 'cancelled';
  const at = STEPS.indexOf(c.status as (typeof STEPS)[number]);
  const progress = cancelled
    ? '<div class="banner" role="status">This commission was cancelled.</div>'
    : `<ol class="steps" aria-hidden="true">${STEPS.map((_, i) => `<li class="${i <= at ? 'done' : ''}"></li>`).join('')}</ol>
<div class="steplabels" aria-hidden="true">${STEPS.map((s, i) => `<span class="${i === at ? 'now' : ''}">${h(COMMISSION_STATUS_LABEL[s])}</span>`).join('')}</div>`;

  const money = c.price > 0
    ? `<div class="card"><h2>Payment</h2><dl>
<dt>Price</dt><dd>${h(fmtMoney(c.price, c.currency))}</dd>
<dt>Paid so far</dt><dd>${h(fmtMoney(c.paid, c.currency))}</dd>
<dt class="bal">Still to pay</dt><dd class="bal">${h(fmtMoney(c.balance, c.currency))}</dd>
</dl></div>`
    : c.paid > 0
      ? `<div class="card"><h2>Payment</h2><dl><dt>Paid so far</dt><dd>${h(fmtMoney(c.paid, c.currency))}</dd></dl></div>`
      : '';

  const due = c.dueDate && fmtDay(c.dueDate) ? `<div class="card"><h2>Expected</h2><p><strong>${h(fmtDay(c.dueDate))}</strong></p></div>` : '';

  const updates = c.updates.length
    ? `<div class="card"><h2>Updates</h2><ul class="tl">${c.updates
        .map(
          (u) =>
            `<li><div class="what">${h(u.statusLabel)}</div><div class="when">${h(fmtStamp(u.at))}</div>${u.message ? `<div class="msg">${h(u.message)}</div>` : ''}</li>`,
        )
        .join('')}</ul></div>`
    : '';

  const pickup =
    c.pickup && (c.pickup.name || c.pickup.address || c.pickup.note)
      ? `<div class="card pick"><h2>Pickup</h2>${c.pickup.name ? `<p class="name">${h(c.pickup.name)}</p>` : ''}${c.pickup.address ? `<p>${h(c.pickup.address)}</p>` : ''}${c.pickup.note ? `<p class="muted">${h(c.pickup.note)}</p>` : ''}</div>`
      : '';

  return shell(
    `${c.title} - ${c.shop}`,
    `<header>${c.shop ? `<div class="shop">${h(c.shop)}</div>` : ''}<h1>${h(c.title)}</h1></header>
<div class="card"><div class="status">${h(c.statusLabel)}</div>${progress}</div>
${updates}${due}${money}${pickup}
<footer>Bookmark this page to check on your commission.</footer>`,
  );
}
