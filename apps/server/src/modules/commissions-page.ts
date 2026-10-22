import { BRIEF_MAX_PICTURES, COMMISSION_PUBLIC_PATH, COMMISSION_STATUSES, COMMISSION_STATUS_LABEL, isWatchedStatus, type CommissionStatus, type PublicCommission } from '@zollify/shared';

/**
 * The customer's tracking page, rendered on the server as plain HTML. Every
 * value goes through `h`, so nothing an owner or customer typed can become
 * markup. Reading it needs no script; one small script file (never inline,
 * so the strict CSP stays) adds sending the brief and pictures, turning on
 * notifications, and the five-minute refresh that waits while the customer
 * is typing. Without script, a plain meta refresh stands in.
 */

const h = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-12-31` as "31 Dec 2026". */
export function fmtDay(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1] ?? ''} ${m[1]}` : '';
}

/** How often an open page asks for news, in seconds. */
export const REFRESH_SECONDS = 300;

/** A moment as "5 Mar 2099, 00:30" on the clock of `timeZone`; UTC when the zone is not known. */
export function fmtStamp(at: number, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(at);
  }
}

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
.brief p.text{white-space:pre-wrap;overflow-wrap:anywhere}
.brief textarea{width:100%;min-height:7rem;font:inherit;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);resize:vertical}
.brief label{display:flex;flex-direction:column;gap:4px;margin-top:10px;font-size:.92rem}
.brief .facts{margin-top:8px}
.pics{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.pics figure{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.pics img{width:88px;height:88px;object-fit:cover;border-radius:8px;border:1px solid var(--border)}
button{font:inherit;font-weight:700;padding:10px 14px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer;margin-top:10px}
@media(prefers-color-scheme:dark){button{color:#020617}}
button.link{background:none;color:var(--accent-ink);padding:0;margin:0;font-weight:600;font-size:.8rem;text-decoration:underline}
button:disabled{opacity:.6;cursor:default}
.msg{margin-top:8px;font-size:.9rem}.msg.err{color:var(--warn)}
footer{margin-top:24px;text-align:center;color:var(--muted);font-size:.72rem}
`;

function shell(title: string, body: string, head = '', opts: { watch?: boolean; script?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive" />
<meta name="referrer" content="no-referrer" />
${head}<title>${h(title)}</title>
<style>${STYLE}</style>
</head>
<body${opts.watch ? ' data-watch="1"' : ''}>
<main>${body}</main>
${opts.script ? '<script src="/p/commissions/commission.js"></script>\n' : ''}</body>
</html>
`;
}

export function renderNotFound(): string {
  return shell('Not available', '<header><h1>This page is not available</h1></header><div class="card"><p class="muted">The link may have been replaced or the commission removed. Please ask the shop for a new one.</p></div>');
}

/** What the customer asked for, their pictures, and - while it is open - the form to change both. */
function briefCard(c: PublicCommission, token: string): string {
  if (!c.canAddBrief && !c.brief?.text && !c.pictures.length) return '';
  const facts = [c.brief?.budget ? `Budget: ${c.brief.budget}` : '', c.brief?.wantedBy && fmtDay(c.brief.wantedBy) ? `Wanted by ${fmtDay(c.brief.wantedBy)}` : ''].filter(Boolean);
  const pics = c.pictures.length
    ? `<div class="pics">${c.pictures
        .map(
          (p) =>
            `<figure><img src="${h(`${COMMISSION_PUBLIC_PATH}${token}/pictures/${p.id}`)}" alt="${h(p.name)}" loading="lazy" />${c.canAddBrief ? `<button type="button" class="link" data-remove="${h(p.id)}">Remove</button>` : ''}</figure>`,
        )
        .join('')}</div>`
    : '';
  if (!c.canAddBrief) {
    return `<div class="card brief"><h2>What you asked for</h2>${c.brief?.text ? `<p class="text">${h(c.brief.text)}</p>` : ''}${facts.length ? `<p class="muted facts">${h(facts.join(' · '))}</p>` : ''}${pics}</div>`;
  }
  const room = BRIEF_MAX_PICTURES - c.pictures.length;
  return `<form id="brief" class="card brief"><h2>What you would like</h2>
<label for="brief-text">Describe it - style, size, colours, anything the artist should know.<textarea id="brief-text" maxlength="4000">${h(c.brief?.text ?? '')}</textarea></label>
${facts.length ? `<p class="muted facts">${h(facts.join(' · '))}</p>` : ''}${pics}
${room > 0 ? `<label for="brief-files">Reference pictures <span class="muted">(up to ${room} more, PNG, JPEG or WebP, 5 MB each)</span><input id="brief-files" type="file" accept="image/png,image/jpeg,image/webp" multiple /></label>` : `<input id="brief-files" type="file" hidden /><p class="muted">That is the most pictures one commission can hold.</p>`}
<button type="submit">Save</button>
<p id="brief-msg" class="msg" hidden></p>
<noscript><p class="muted">Turn on JavaScript to send a description or pictures.</p></noscript>
</form>`;
}

export function renderCommission(c: PublicCommission, token = ''): string {
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
            `<li><div class="what">${h(u.statusLabel)}</div><div class="when">${h(fmtStamp(u.at, c.timeZone))}</div>${u.message ? `<div class="msg">${h(u.message)}</div>` : ''}</li>`,
        )
        .join('')}</ul></div>`
    : '';

  const pickup =
    c.pickup && (c.pickup.name || c.pickup.address || c.pickup.note)
      ? `<div class="card pick"><h2>Pickup</h2>${c.pickup.name ? `<p class="name">${h(c.pickup.name)}</p>` : ''}${c.pickup.address ? `<p>${h(c.pickup.address)}</p>` : ''}${c.pickup.note ? `<p class="muted">${h(c.pickup.note)}</p>` : ''}</div>`
      : '';

  const watch = isWatchedStatus(c.status);
  // Offered while there is still news to come; the script shows it when the browser can take it.
  const push = token && watch && c.push
    ? `<div id="push" class="card" hidden><h2>Notifications</h2><button type="button" id="push-btn" hidden>Notify me on this device</button><p id="push-msg" class="msg" hidden></p></div>`
    : '';
  const head = [
    // The script refreshes the page every five minutes, unless the customer is typing; without script, a plain refresh does.
    watch ? `<noscript><meta http-equiv="refresh" content="${REFRESH_SECONDS}" /></noscript>\n` : '',
    token ? `<link rel="manifest" href="${h(`${COMMISSION_PUBLIC_PATH}${token}/manifest.webmanifest`)}" />\n<meta name="theme-color" content="#0e7c66" />\n<meta name="apple-mobile-web-app-capable" content="yes" />\n` : '',
  ].join('');
  return shell(
    `${c.title} - ${c.shop}`,
    `<header>${c.shop ? `<div class="shop">${h(c.shop)}</div>` : ''}<h1>${h(c.title)}</h1></header>
<div class="card"><div class="status">${h(c.statusLabel)}</div>${progress}</div>
${push}${updates}${token ? briefCard(c, token) : ''}${due}${money}${pickup}
<footer>Bookmark this page to check on your commission.<br />Times are shown in ${h(c.timeZone)}.</footer>`,
    head,
    { watch, script: !!token },
  );
}
