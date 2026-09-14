import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import {
  EventOverlaySchema,
  PublicEventsConfigSchema,
  buildBio,
  buildIcs,
  splitPublicEvents,
  type EventOverlay,
  type PublicEvent,
  type PublicEventsConfig,
} from '@zollify/shared';
import {
  reduceEvents,
  type ModuleContext,
  type PublicModuleContext,
  type ServerModule,
} from '@zollify/server-core';

/**
 * Public events — the server half.
 *
 * Republishes the booth's events as a public page, a drop-in widget for a
 * shop, an iCal feed and an Instagram bio, at `/p/public-events/<slug>/…`.
 * Events are materialised from the account's op-log, so nothing has to be
 * pushed for the page to update; the booth just edits its events as usual.
 *
 * Only sanitised display fields are exposed. The reducer returns whole event
 * records, and `splitPublicEvents` is the single place that picks the fields
 * that may leave — never a spread of the record.
 */

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_events_config (
      accountId TEXT PRIMARY KEY,
      slug      TEXT UNIQUE,
      config    TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS public_events_overlay (
      accountId TEXT NOT NULL,
      eventId   TEXT NOT NULL,
      overlay   TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, eventId)
    );
  `);
}

// ── Data access ─────────────────────────────────────────────────────────────

function readConfig(db: Database.Database, accountId: string): PublicEventsConfig {
  const row = db.prepare('SELECT config FROM public_events_config WHERE accountId = ?').get(accountId) as
    | { config: string }
    | undefined;
  const parsed = PublicEventsConfigSchema.safeParse(row ? JSON.parse(row.config) : {});
  return parsed.success ? parsed.data : PublicEventsConfigSchema.parse({});
}

function readOverlays(db: Database.Database, accountId: string): Record<string, EventOverlay> {
  const rows = db.prepare('SELECT eventId, overlay FROM public_events_overlay WHERE accountId = ?').all(accountId) as {
    eventId: string;
    overlay: string;
  }[];
  const out: Record<string, EventOverlay> = {};
  for (const r of rows) {
    const parsed = EventOverlaySchema.safeParse(JSON.parse(r.overlay));
    if (parsed.success) out[r.eventId] = parsed.data;
  }
  return out;
}

function accountForSlug(db: Database.Database, slug: string): string | null {
  const row = db.prepare('SELECT accountId FROM public_events_config WHERE slug = ?').get(slug) as
    | { accountId: string }
    | undefined;
  return row?.accountId ?? null;
}

function accountName(db: Database.Database, accountId: string): string {
  const row = db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string } | undefined;
  return row?.name ?? '';
}

/** Current events, replayed from the op-log the way the app itself does. */
function eventsFor(db: Database.Database, accountId: string) {
  const ops = db
    .prepare("SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN ('event.upsert', 'event.close') ORDER BY seq")
    .all(accountId) as { opId: string; type: string; payload: string }[];
  return reduceEvents(ops.map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) })));
}

interface Site {
  accountId: string;
  config: PublicEventsConfig;
  org: string;
  upcoming: PublicEvent[];
  past: PublicEvent[];
  base: string;
}

/** Everything one public response needs; null when the slug is unknown or the module is off. */
function loadSite(ctx: PublicModuleContext, req: FastifyRequest, slug: string): Site | null {
  const accountId = accountForSlug(ctx.db, slug);
  if (!accountId || !ctx.isEnabled(accountId)) return null;
  const config = readConfig(ctx.db, accountId);
  const { upcoming, past } = splitPublicEvents(eventsFor(ctx.db, accountId), readOverlays(ctx.db, accountId), config.pastLimit);
  return {
    accountId,
    config,
    org: config.orgName || accountName(ctx.db, accountId),
    upcoming,
    past,
    base: `${publicOrigin(req)}/p/public-events/${slug}`,
  };
}

/** The origin visitors reach us at, honouring a reverse proxy's forwarded headers. */
function publicOrigin(req: FastifyRequest): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0]!.trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim();
  return `${proto}://${host}`;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const h = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function range(start: string, end: string): string {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end || start}T00:00:00`);
  if (Number.isNaN(s.getTime())) return '';
  const sd = s.getDate(), ed = e.getDate(), sm = MON[s.getMonth()], em = MON[e.getMonth()], sy = s.getFullYear(), ey = e.getFullYear();
  if (start === (end || start)) return `${sd} ${sm} ${sy}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${sm} ${sy}`;
  if (sy === ey) return `${sd} ${sm} – ${ed} ${em} ${sy}`;
  return `${sd} ${sm} ${sy} – ${ed} ${em} ${ey}`;
}

function place(ev: PublicEvent): string {
  const loc = [ev.city, ev.country].filter(Boolean).map(h).join(', ');
  // The flag is a pair of regional-indicator code points — safe unescaped.
  return ev.flag ? (loc ? `${ev.flag} ${loc}` : ev.flag) : loc;
}

const PAGE_STYLE = `
:root{--bg:#f1f4f6;--surface:#fff;--text:#141a22;--muted:#5a6472;--border:#d6dde4;--accent:#0e7c66;--accent-ink:#0a5a4a;--accent-soft:#deeee9;--on-accent:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#020617;--surface:#0f172a;--text:#f1f5f9;--muted:#a3aebd;--border:#273449;--accent:#34d399;--accent-ink:#6ee7b7;--accent-soft:rgba(52,211,153,.16);--on-accent:#052e22}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;padding:0 20px 64px}
.wrap{max-width:960px;margin:0 auto}
header.hero{padding:56px 0 28px;text-align:center}
.hero .org{font-size:.8rem;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-ink);font-weight:700}
.hero h1{font-size:2.2rem;font-weight:800;letter-spacing:-.02em;margin:8px 0 14px;text-wrap:balance}
.sub-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:var(--on-accent);text-decoration:none;font-weight:700;font-size:.85rem;padding:10px 18px;border-radius:10px}
.feedurl{font-size:.72rem;color:var(--muted);word-break:break-all}
h2.sec{font-size:1.05rem;font-weight:700;margin:36px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:5px}
.badge{align-self:flex-start;font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;padding:2px 8px;border-radius:6px;background:var(--accent-soft);color:var(--accent-ink);font-weight:700}
.name{font-weight:700;font-size:1.08rem}
.date{font-weight:600;font-size:.92rem}
.meta{color:var(--muted);font-size:.85rem}
.card a.link{margin-top:6px;align-self:flex-start;font-size:.82rem;font-weight:700;color:var(--accent-ink);text-decoration:none;border-bottom:1px solid currentColor}
.past{list-style:none}
.past li{padding:10px 0;border-top:1px solid var(--border);color:var(--muted);font-size:.9rem}
.empty{color:var(--muted);font-size:.92rem;padding:8px 0}
footer{margin-top:48px;text-align:center;color:var(--muted);font-size:.72rem}
`;

function card(ev: PublicEvent): string {
  const now = ev.ongoing ? '<span class="badge">Happening now</span>' : '';
  const loc = place(ev) ? `<div class="meta">${place(ev)}</div>` : '';
  const bh = [ev.hall && `Hall ${h(ev.hall)}`, ev.booth && `Booth ${h(ev.booth)}`].filter(Boolean).join(' · ');
  const booth = bh ? `<div class="meta">${bh}</div>` : '';
  const blurb = ev.blurb ? `<div class="meta">${h(ev.blurb)}</div>` : '';
  const link = ev.link ? `<a class="link" href="${h(ev.link)}" target="_blank" rel="noopener">Event details →</a>` : '';
  return `<div class="card">${now}<div class="name">${h(ev.name)}</div><div class="date">${range(ev.start, ev.end)}</div>${loc}${booth}${blurb}${link}</div>`;
}

function renderPage(site: Site): string {
  const icsUrl = `${site.base}/events.ics`;
  const webcal = icsUrl.replace(/^https?:\/\//, 'webcal://');
  const upHtml = site.upcoming.length
    ? `<div class="grid">${site.upcoming.map(card).join('')}</div>`
    : '<div class="empty">No upcoming events right now — check back soon.</div>';
  const pastHtml =
    site.config.showPast && site.past.length
      ? `<h2 class="sec">Past events</h2><ul class="past">${site.past
          .map((ev) => `<li>${h(ev.name)} · ${range(ev.start, ev.end)}${place(ev) ? ` · ${place(ev)}` : ''}</li>`)
          .join('')}</ul>`
      : '';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(site.org)} — Events</title>
<meta name="description" content="${h(site.org)} — ${h(site.config.tagline)}. Upcoming conventions and events.">
<style>${PAGE_STYLE}</style></head><body><div class="wrap">
<header class="hero">
  <div class="org">${h(site.org)}</div>
  <h1>${h(site.config.tagline)}</h1>
  <div class="sub-row">
    <a class="btn" href="${h(webcal)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> Subscribe (calendar)</a>
    <span class="feedurl">or add by URL: ${h(icsUrl)}</span>
  </div>
</header>
<main>
  <h2 class="sec">Upcoming events</h2>
  ${upHtml}
  ${pastHtml}
</main>
<footer>Events update automatically from our sales system.</footer>
</div></body></html>`;
}

/**
 * The drop-in widget, kept as source text: it runs in a stranger's page, not
 * in Node, so it is plain ES5 with no globals leaked and everything escaped.
 * Served with the feed URL baked in, so it always knows where to fetch from.
 */
const WIDGET_SRC = String.raw`
function widget(BASE) {
  var targets = document.querySelectorAll('#zollify-events, [data-zollify-events]');
  if (!targets.length) return;
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var d0 = function (s) { var d = new Date(s + 'T00:00:00'); return isNaN(d.getTime()) ? null : d; };
  var fmt = function (start, end) {
    var s = d0(start), e = d0(end || start);
    if (!s) return '';
    var sPart = WD[s.getDay()] + ', ' + MON[s.getMonth()] + ' ' + s.getDate();
    if (!e || e.getTime() === s.getTime()) return sPart + ', ' + s.getFullYear();
    if (s.getFullYear() !== e.getFullYear()) sPart += ', ' + s.getFullYear();
    return sPart + ' – ' + WD[e.getDay()] + ', ' + MON[e.getMonth()] + ' ' + e.getDate() + ', ' + e.getFullYear();
  };
  var CAL = '<svg class="zev-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="17" rx="2"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/></svg>';
  var PIN = '<svg class="zev-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>';

  if (!document.getElementById('zev-style')) {
    var st = document.createElement('style');
    st.id = 'zev-style';
    st.textContent =
      '.zev{--zev-fg:#1f2d3a;--zev-muted:#77716b;--zev-chip:#e6a83c;--zev-chip-fg:#fff;--zev-line:#efe4bf;--zev-head-bg:#f6c85f;--zev-head-fg:#1f2d3a;--zev-body-bg:#fdf8e2;--zev-now-fg:#4e8a3f;--zev-now-bg:#e2f0d4;--zev-now-border:#a9cf8e;--zev-soon-fg:#8a5a00;--zev-soon-bg:#fdeecb;--zev-soon-border:#eaca7f;font-family:inherit;color:var(--zev-fg);background:var(--zev-body-bg);border:1px solid var(--zev-line);border-radius:12px;overflow:hidden;max-width:640px;margin:0 auto}' +
      '.zev *{box-sizing:border-box}' +
      '.zev-head{padding:15px 18px 12px;background:var(--zev-head-bg);color:var(--zev-head-fg);border-bottom:1px solid rgba(0,0,0,.12);font-weight:700;font-size:1.05em}' +
      '.zev-row{display:flex;gap:14px;align-items:flex-start;padding:14px 18px}' +
      '.zev-row + .zev-row{border-top:1px solid var(--zev-line)}' +
      '.zev-chip{flex:none;width:52px;height:52px;background:var(--zev-chip);color:var(--zev-chip-fg);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}' +
      '.zev-d{font-size:1.4em;font-weight:700}' +
      '.zev-m{font-size:.58em;letter-spacing:.1em;margin-top:3px;opacity:.9}' +
      '.zev-body{min-width:0;flex:1}' +
      '.zev-name{font-weight:700;font-size:1.02em}' +
      '.zev-meta{display:flex;align-items:center;gap:7px;color:var(--zev-muted);font-size:.86em;margin-top:5px}' +
      '.zev-ic{flex:none;opacity:.7}' +
      '.zev-loc{color:var(--zev-fg)}' +
      '.zev-now,.zev-soon{display:inline-block;font-size:.6em;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:4px;padding:1px 6px;margin-left:8px;vertical-align:middle;border:1px solid}' +
      '.zev-now{color:var(--zev-now-fg);background:var(--zev-now-bg);border-color:var(--zev-now-border)}' +
      '.zev-soon{color:var(--zev-soon-fg);background:var(--zev-soon-bg);border-color:var(--zev-soon-border)}' +
      '.zev-sep{padding:7px 18px 5px;font-size:.66em;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--zev-muted);background:rgba(0,0,0,.02);border-top:1px solid var(--zev-line)}' +
      '.zev-link{display:inline-flex;align-items:center;gap:5px;margin-top:8px;font-size:.85em;font-weight:600;color:var(--zev-fg);text-decoration:none;border-bottom:1px solid currentColor}' +
      '.zev-empty{padding:20px 18px;color:var(--zev-muted);font-size:.9em}';
    document.head.appendChild(st);
  }

  var row = function (ev) {
    var s = d0(ev.start);
    var chip = '<div class="zev-chip"><span class="zev-d">' + (s ? s.getDate() : '') + '</span><span class="zev-m">' + (s ? MON[s.getMonth()].toUpperCase() : '') + '</span></div>';
    var now = ev.ongoing ? '<span class="zev-now">Now</span>' : ev.soon ? '<span class="zev-soon">Soon</span>' : '';
    var loc = [ev.city, ev.country].filter(Boolean).map(esc).join(', ');
    if (ev.flag) loc = loc ? ev.flag + ' ' + loc : ev.flag;
    var extra = [];
    if (ev.hall) extra.push('Hall ' + esc(ev.hall));
    if (ev.booth) extra.push('Booth ' + esc(ev.booth));
    var where = loc || '';
    if (extra.length) where = where ? where + ' · ' + extra.join(' · ') : extra.join(' · ');
    var locLine = where ? '<div class="zev-meta">' + PIN + '<span class="zev-loc">' + where + '</span></div>' : '';
    var link = ev.link ? '<a class="zev-link" href="' + esc(ev.link) + '" target="_blank" rel="noopener">Event details →</a>' : '';
    return '<div class="zev-row">' + chip + '<div class="zev-body"><div class="zev-name">' + esc(ev.name) + now + '</div><div class="zev-meta">' + CAL + '<span>' + fmt(ev.start, ev.end) + '</span></div>' + locLine + link + '</div></div>';
  };

  fetch(BASE + '/events.json').then(function (r) { return r.json(); }).then(function (data) {
    var up = data.upcoming || [];
    targets.forEach(function (el) {
      var limit = parseInt(el.getAttribute('data-limit') || '0', 10);
      var heading = el.getAttribute('data-heading') || 'Upcoming events';
      var shown = limit > 0 ? up.slice(0, limit) : up;
      var body = '';
      if (shown.length) {
        var wasImminent = null;
        shown.forEach(function (ev) {
          var imminent = !!(ev.ongoing || ev.soon);
          if (wasImminent === true && !imminent) body += '<div class="zev-sep">Later</div>';
          body += row(ev);
          wasImminent = imminent;
        });
      } else {
        body = '<div class="zev-empty">No upcoming events right now — check back soon.</div>';
      }
      el.innerHTML = '<div class="zev"><div class="zev-head">' + esc(heading) + '</div>' + body + '</div>';
      var mw = el.getAttribute('data-max-width');
      if (mw) { var c = el.querySelector('.zev'); if (c) c.style.maxWidth = /^[0-9]+$/.test(mw) ? mw + 'px' : mw; }
    });
  }).catch(function () {
    targets.forEach(function (el) { el.innerHTML = '<div class="zev"><div class="zev-empty">Events are unavailable right now.</div></div>'; });
  });
}
`;

// ── The module ──────────────────────────────────────────────────────────────

const CACHE_PUBLIC = 'public, max-age=300';

export const publicEventsServerModule: ServerModule = {
  id: 'public-events',
  minRole: 'admin',
  migrate,

  /** Authenticated: the booth's own settings and a preview of what visitors see. */
  routes: (ctx: ModuleContext) => async (app) => {
    app.get('/config', async (req) => {
      const who = ctx.identity(req);
      return { config: readConfig(ctx.db, who.accountId), overlays: readOverlays(ctx.db, who.accountId) };
    });

    app.put('/config', async (req, reply) => {
      const who = ctx.identity(req);
      const parsed = PublicEventsConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid settings.' });
      }
      const config = parsed.data;
      if (config.slug) {
        const owner = accountForSlug(ctx.db, config.slug);
        if (owner && owner !== who.accountId) {
          return reply.code(409).send({ error: 'slug_taken', message: 'That address is already taken — try another.' });
        }
      }
      ctx.db
        .prepare(
          `INSERT INTO public_events_config (accountId, slug, config, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT(accountId) DO UPDATE SET slug = excluded.slug, config = excluded.config, updatedAt = excluded.updatedAt`,
        )
        .run(who.accountId, config.slug, JSON.stringify(config), Date.now());
      return { config };
    });

    app.put<{ Params: { eventId: string } }>('/overlay/:eventId', async (req, reply) => {
      const who = ctx.identity(req);
      const parsed = EventOverlaySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid', message: 'Invalid event extras.' });
      ctx.db
        .prepare(
          `INSERT INTO public_events_overlay (accountId, eventId, overlay, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT(accountId, eventId) DO UPDATE SET overlay = excluded.overlay, updatedAt = excluded.updatedAt`,
        )
        .run(who.accountId, req.params.eventId, JSON.stringify(parsed.data), Date.now());
      return { overlay: parsed.data };
    });

    /** What the public would see right now, plus the URLs to hand out. */
    app.get('/preview', async (req) => {
      const who = ctx.identity(req);
      const config = readConfig(ctx.db, who.accountId);
      const { upcoming, past } = splitPublicEvents(eventsFor(ctx.db, who.accountId), readOverlays(ctx.db, who.accountId), config.pastLimit);
      const base = config.slug ? `${publicOrigin(req)}/p/public-events/${config.slug}` : null;
      return {
        published: Boolean(config.slug),
        base,
        upcoming,
        past,
        bio: buildBio(upcoming, config.igTemplate, config.igFallback),
      };
    });
  },

  /** Unauthenticated: what the world sees. */
  publicRoutes: (ctx: PublicModuleContext) => async (app) => {
    type Slug = { Params: { slug: string } };

    app.get<Slug>('/:slug', async (req, reply) => {
      const site = loadSite(ctx, req, req.params.slug);
      if (!site) return reply.code(404).type('text/plain').send('No such events page.');
      return reply.type('text/html; charset=utf-8').header('cache-control', CACHE_PUBLIC).send(renderPage(site));
    });

    app.get<Slug>('/:slug/events.json', async (req, reply) => {
      const site = loadSite(ctx, req, req.params.slug);
      if (!site) return reply.code(404).send({ error: 'not_found' });
      return reply.header('cache-control', CACHE_PUBLIC).send({ org: site.org, upcoming: site.upcoming, past: site.past });
    });

    app.get<Slug>('/:slug/embed.js', async (req, reply) => {
      const site = loadSite(ctx, req, req.params.slug);
      if (!site) return reply.code(404).type('text/plain').send('');
      return reply
        .type('text/javascript; charset=utf-8')
        .header('cache-control', 'public, max-age=600')
        .send(`;(${WIDGET_SRC})(${JSON.stringify(site.base)});\n`);
    });

    app.get<Slug>('/:slug/events.ics', async (req, reply) => {
      const site = loadSite(ctx, req, req.params.slug);
      if (!site) return reply.code(404).type('text/plain').send('');
      const all = splitPublicEvents(eventsFor(ctx.db, site.accountId), readOverlays(ctx.db, site.accountId), Infinity);
      const ics = buildIcs([...all.upcoming, ...all.past], {
        calName: `${site.org} events`,
        host: site.base.replace(/^https?:\/\//, ''),
      });
      return reply
        .type('text/calendar; charset=utf-8')
        .header('content-disposition', 'inline; filename="events.ics"')
        .send(ics);
    });

    app.get<Slug>('/:slug/instagram.txt', async (req, reply) => {
      const site = loadSite(ctx, req, req.params.slug);
      if (!site) return reply.code(404).type('text/plain').send('');
      return reply
        .type('text/plain; charset=utf-8')
        .header('cache-control', CACHE_PUBLIC)
        .send(buildBio(site.upcoming, site.config.igTemplate, site.config.igFallback));
    });
  },
};
