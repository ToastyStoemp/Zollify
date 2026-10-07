import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lookup as lookupCb, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  WEBHOOK_EVENTS,
  WebhookInputSchema,
  fmtPrice,
  isTimeZone,
  localDay,
  type Transaction,
  type WebhookEvent,
  type WebhookMessage,
  type Webhook,
  type WireOp,
} from '@zollify/shared';
import type { JwtClaims } from './auth';
import { reduceMerges, reduceTransactions } from './reduce';
import { WEBHOOK_WARN_AFTER, reasonOf, type ModuleProblems } from './problems';

/**
 * Webhooks: an account's events posted to Discord, Slack or any service
 * that takes JSON. Each webhook picks its events - each sale, a daily or
 * weekly summary, and the in-app notifications by category (which is how
 * modules reach a chat without knowing webhooks exist).
 *
 * Deliveries go out after the response, one at a time per webhook, and never
 * hold up a sale. A webhook that keeps failing switches itself off and says
 * so under the bell. The server only posts to public addresses: a webhook
 * pointing into its own network is refused, unless the operator allows it
 * (WEBHOOK_ALLOW_PRIVATE=1, for a LAN-only install).
 */

export interface WebhookRow {
  id: string;
  accountId: string;
  doc: string;
  createdAt: number;
}

/** Sections a module adds to a summary, for the account and period asked. */
export type ReportContributor = (accountId: string, period: { from: string; to: string; timeZone: string }) => WebhookMessage['fields'];

const FAILURES_BEFORE_OFF = 20;
const TIMEOUT_MS = 8000;
const COLORS = { good: 0x2ba673, warn: 0xc08a2e, info: 0x3b82c4 } as const;

export function migrateWebhooks(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id        TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      doc       TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_account ON webhooks(accountId);
  `);
}

// ── Where a webhook may point ───────────────────────────────────────────────

/** Everything that is not the public internet: loopback, private, link-local, carrier NAT, benchmark, multicast, and the IPv6 forms that wrap an IPv4 address. */
const BLOCKED = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) BLOCKED.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(net, bits, 'ipv6');

export function privateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, 'ipv4');
  if (family !== 6) return true;
  // ::ffff:a.b.c.d in any spelling (dotted or hex) is that IPv4 address.
  const norm = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(norm);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^::ffff:/.test(norm)) return true;
  return BLOCKED.check(norm, 'ipv6');
}

/**
 * Resolves the host at connection time and refuses a private answer there:
 * checking the name once beforehand is not enough, as a name can resolve to
 * a public address for the check and a private one a moment later.
 */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = (addresses as unknown as LookupAddress[]).filter((a) => !privateAddress(a.address));
    if (!list.length) return callback(Object.assign(new Error('That address points into a private network.'), { code: 'EPRIVATE' }), '', 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** One POST, without following redirects, reading at most a few KB of the answer. */
function postOnce(raw: string, body: string, headers: Record<string, string>): Promise<{ status: number; retryAfter: string | null; text: string }> {
  const url = new URL(raw);
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
  const send = url.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, timeout: TIMEOUT_MS, ...(allowPrivate ? {} : { lookup: safeLookup }) },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (text.length < 4096) text += chunk;
          if (text.length >= 4096) res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, retryAfter: (res.headers['retry-after'] as string | undefined) ?? null, text: text.slice(0, 4096) });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Null when the server may post to the URL; otherwise why not. */
export async function webhookTargetProblem(raw: string): Promise<string | null> {
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === '1';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a web address.';
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return 'Webhook addresses must start with https://.';
  if (url.username || url.password) return 'Leave the user name and password out of the address.';
  if (allowPrivate) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addresses.length) return 'That address does not resolve.';
    if (addresses.some((a) => privateAddress(a.address))) return 'That address points into a private network.';
  } catch {
    return 'That address does not resolve.';
  }
  return null;
}

// ── Shaping a message ───────────────────────────────────────────────────────

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function payloadFor(hook: Webhook, event: WebhookEvent, msg: WebhookMessage, accountName: string): { body: string; headers: Record<string, string> } {
  const fields = (msg.fields ?? []).filter((f) => f.value);
  if (hook.format === 'discord') {
    // No masked links ([text](url)) from account text: a product name must not become a disguised link.
    const d = (s: string) => s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)');
    msg = { ...msg, title: d(msg.title), ...(msg.body ? { body: d(msg.body) } : {}) };
    fields.splice(0, fields.length, ...fields.map((f) => ({ ...f, name: d(f.name), value: d(f.value) })));
    return {
      headers: {},
      body: JSON.stringify({
        username: 'Zollify',
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: clip(msg.title, 256),
            ...(msg.body ? { description: clip(msg.body, 4000) } : {}),
            color: COLORS[msg.tone ?? 'info'],
            fields: fields.slice(0, 25).map((f) => ({ name: clip(f.name, 256), value: clip(f.value, 1024), inline: !!f.inline })),
            footer: { text: clip(accountName, 200) },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    };
  }
  if (hook.format === 'slack') {
    // Slack reads <…> as links and mentions (<!channel>); text from the account (product names) must stay text.
    const e = (s: string | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = [`*${e(msg.title)}*`, e(msg.body), ...fields.map((f) => `*${e(f.name)}:* ${e(f.value)}`)].filter(Boolean).join('\n');
    return { headers: {}, body: JSON.stringify({ text: clip(text, 3900) }) };
  }
  const body = JSON.stringify({ event, account: accountName, at: new Date().toISOString(), title: msg.title, body: msg.body ?? '', fields });
  const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
  return { headers: { 'x-zollify-event': event, 'x-zollify-signature': `sha256=${signature}` }, body };
}

// ── The service ─────────────────────────────────────────────────────────────

export interface Webhooks {
  /** Posts to every enabled webhook of the account that listens for the event. */
  emit(accountId: string, event: WebhookEvent, msg: WebhookMessage): void;
  /** A notification, as the webhooks of its category hear it. */
  notification(accountId: string, n: { title: string; body?: string; kind?: string }): void;
  /** Announces freshly synced sales. */
  onOps(accountId: string, ops: WireOp[]): void;
  /** Sends one test message, and says how it went. */
  test(hook: Webhook, accountId: string): Promise<{ ok: boolean; status: number | null; error: string | null }>;
  /** Daily and weekly summaries whose day has come. */
  sendDueReports(now?: number): Promise<number>;
  stop(): void;
}

const NOTIFICATION_EVENTS = new Set<string>(['planner', 'stock', 'programme', 'sharing', 'discounts', 'fees', 'reports']);

export function createWebhooks(
  db: Database.Database,
  deps: { notify(accountId: string, n: { title: string; body?: string; link?: string; minRole?: 'admin' }): void; contributors: () => ReportContributor[]; problems?: ModuleProblems; log?: (err: unknown) => void },
): Webhooks {
  const rows = (accountId: string): Webhook[] =>
    (db.prepare('SELECT doc FROM webhooks WHERE accountId = ?').all(accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Webhook);
  const save = (accountId: string, hook: Webhook): void => {
    db.prepare('UPDATE webhooks SET doc = ? WHERE id = ? AND accountId = ?').run(JSON.stringify(hook), hook.id, accountId);
  };
  const accountName = (accountId: string): string =>
    (db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string } | undefined)?.name ?? 'Zollify';

  // One delivery at a time per webhook, so a chat sees events in order and a slow endpoint queues only itself.
  const queues = new Map<string, Promise<unknown>>();
  async function post(hook: Webhook, accountId: string, event: WebhookEvent, msg: WebhookMessage): Promise<{ status: number | null; error: string | null }> {
    const problem = await webhookTargetProblem(hook.url);
    if (problem) return { status: null, error: problem };
    const { body, headers } = payloadFor(hook, event, msg, accountName(accountId));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await postOnce(hook.url, body, { 'content-type': 'application/json', 'user-agent': 'Zollify-Webhooks', ...headers });
        if (res.status === 429 && attempt === 0) {
          // Discord and Slack say how long to wait; never longer than a few seconds here.
          const wait = Number(res.retryAfter ?? '1');
          await new Promise((r) => setTimeout(r, Math.min(5, Number.isFinite(wait) ? wait : 1) * 1000));
          continue;
        }
        const ok = res.status >= 200 && res.status < 300;
        return ok ? { status: res.status, error: null } : { status: res.status, error: res.text.slice(0, 200) || `HTTP ${res.status}` };
      } catch (err) {
        if (attempt === 1) return { status: null, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { status: null, error: 'No answer.' };
  }

  function record(accountId: string, hookId: string, result: { status: number | null; error: string | null }): void {
    const fresh = rows(accountId).find((h) => h.id === hookId);
    if (!fresh) return;
    const failures = result.error ? fresh.failures + 1 : 0;
    const off = failures >= FAILURES_BEFORE_OFF && fresh.enabled;
    save(accountId, { ...fresh, lastAt: Date.now(), lastStatus: result.status, lastError: result.error, failures, enabled: off ? false : fresh.enabled });
    if (!result.error) deps.problems?.resolve(accountId, 'webhook', hookId);
    else if (off || (failures >= WEBHOOK_WARN_AFTER && fresh.enabled)) {
      // Source name and a sanitised reason only: never the answer the other side sent, never the address.
      deps.problems?.report(accountId, {
        kind: 'webhook',
        key: hookId,
        severity: off ? 'error' : 'warning',
        message: off ? `Webhook "${fresh.name}" was switched off after repeated failures` : `Webhook "${fresh.name}" keeps failing`,
        detail: `${failures} failed deliveries in a row. Last: ${reasonOf(result.status, result.error)}`,
        link: '/settings?panel=core.webhooks',
        // The switch-off already has its own note under the bell.
        notify: false,
      });
    }
    if (off) deps.notify(accountId, { title: `Webhook "${fresh.name}" switched off`, body: `It failed ${failures} times in a row: ${result.error ?? ''}`.trim(), link: '/settings', minRole: 'admin' });
  }

  function emit(accountId: string, event: WebhookEvent, msg: WebhookMessage): void {
    for (const hook of rows(accountId)) {
      if (!hook.enabled || !hook.events.includes(event)) continue;
      const prev = queues.get(hook.id) ?? Promise.resolve();
      const next = prev
        .then(() => post(hook, accountId, event, msg))
        .then((r) => record(accountId, hook.id, r))
        .catch((err) => deps.log?.(err));
      queues.set(hook.id, next);
      void next.finally(() => {
        if (queues.get(hook.id) === next) queues.delete(hook.id);
      });
    }
  }

  // ── Sales ─────────────────────────────────────────────────────────────────
  const eventName = (accountId: string, eventId: string): string | null => {
    const row = db
      .prepare("SELECT payload FROM ops WHERE accountId = ? AND type = 'event.upsert' AND json_extract(payload, '$.id') = ? ORDER BY seq DESC LIMIT 1")
      .get(accountId, eventId) as { payload: string } | undefined;
    return row ? ((JSON.parse(row.payload) as { name?: string }).name ?? null) : null;
  };
  /** Sales older than this are an import or a restore, not news. */
  const RECENT_MS = 24 * 3600 * 1000;
  const PER_PUSH = 10;
  function onOps(accountId: string, ops: WireOp[]): void {
    if (!rows(accountId).some((h) => h.enabled && h.events.includes('sale'))) return;
    const sales = ops.filter((o) => o.type === 'tx.create').map((o) => o.payload as Transaction).filter((t) => t && Date.now() - t.timestamp < RECENT_MS);
    for (const tx of sales.slice(0, PER_PUSH)) emit(accountId, 'sale', saleMessage(tx, eventName(accountId, tx.eventId)));
    if (sales.length > PER_PUSH) emit(accountId, 'sale', { title: `…and ${sales.length - PER_PUSH} more sales`, body: 'They synced together; see History in Zollify.', tone: 'info' });
  }

  // ── Summaries ─────────────────────────────────────────────────────────────
  function summary(accountId: string, from: string, to: string, timeZone: string, label: string): WebhookMessage {
    const types = ['tx.create', 'tx.revert', 'product.merge'];
    const ops = (
      db.prepare(`SELECT opId, type, payload FROM ops WHERE accountId = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`).all(accountId, ...types) as {
        opId: string;
        type: string;
        payload: string;
      }[]
    ).map((o) => ({ opId: o.opId, type: o.type, payload: JSON.parse(o.payload) as unknown }));
    const txs = (reduceTransactions(ops, reduceMerges(ops)) as Transaction[]).filter((t) => !t.revertedAt && !t.revertedBy && localDay(t.timestamp, timeZone) >= from && localDay(t.timestamp, timeZone) <= to);
    const fields: NonNullable<WebhookMessage['fields']> = [];
    const byCurrency = new Map<string, { total: number; cash: number; card: number; count: number }>();
    const items = new Map<string, number>();
    const byEvent = new Map<string, number>();
    for (const tx of txs) {
      const c = tx.baseCurrency ?? tx.currency;
      const f = tx.baseTotal && tx.total ? tx.baseTotal / tx.total : 1;
      const acc = byCurrency.get(c) ?? { total: 0, cash: 0, card: 0, count: 0 };
      acc.count++;
      acc.total += Math.round((tx.baseTotal ?? tx.total) * 100);
      const legs = tx.payments?.length ? tx.payments : [{ kind: tx.method === 'card' ? 'card' : 'cash', amount: tx.total }];
      for (const l of legs) acc[l.kind === 'card' ? 'card' : 'cash'] += Math.round(l.amount * f * 100);
      byCurrency.set(c, acc);
      for (const i of tx.items) items.set(i.title, (items.get(i.title) ?? 0) + i.qty);
      byEvent.set(tx.eventId, (byEvent.get(tx.eventId) ?? 0) + 1);
    }
    for (const [c, a] of byCurrency) {
      fields.push({ name: 'Takings', value: `${fmtPrice(a.total / 100, c)} from ${a.count} sale${a.count === 1 ? '' : 's'}`, inline: true });
      fields.push({ name: 'Cash / card', value: `${fmtPrice(a.cash / 100, c)} / ${fmtPrice(a.card / 100, c)}`, inline: true });
    }
    const top = [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) fields.push({ name: 'Selling best', value: top.map(([t, q]) => `${q} × ${t}`).join('\n') });
    if (byEvent.size > 1) fields.push({ name: 'Where', value: [...byEvent.entries()].map(([id, n]) => `${eventName(accountId, id) ?? 'No event'}: ${n}`).join('\n') });
    for (const contribute of deps.contributors()) {
      try {
        fields.push(...(contribute(accountId, { from, to, timeZone }) ?? []));
      } catch (err) {
        deps.log?.(err);
      }
    }
    return { title: `${label}: ${txs.length ? `${txs.length} sale${txs.length === 1 ? '' : 's'}` : 'no sales'}`, body: from === to ? from : `${from} to ${to}`, fields, tone: txs.length ? 'good' : 'info' };
  }

  const DAY = 86_400_000;
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const plus = (d: string, days: number): string => iso(Date.parse(`${d}T00:00:00Z`) + days * DAY);
  /** Monday of the week a day is in. */
  const monday = (d: string): string => plus(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));

  async function sendDueReports(now = Date.now()): Promise<number> {
    let sent = 0;
    const all = db.prepare('SELECT accountId, doc FROM webhooks').all() as { accountId: string; doc: string }[];
    for (const row of all) {
    try {
      const hook = JSON.parse(row.doc) as Webhook & { lastDaily?: string; lastWeekly?: string };
      if (!hook.enabled) continue;
      const today = localDay(now, hook.timeZone);
      const patch: { lastDaily?: string; lastWeekly?: string } = {};
      const yesterday = plus(today, -1);
      if (hook.events.includes('report.daily') && (hook.lastDaily ?? '') < yesterday) {
        // A webhook made today starts tomorrow, rather than reporting a day it never saw.
        if (hook.lastDaily !== undefined) {
          const r = await post(hook, row.accountId, 'report.daily', summary(row.accountId, yesterday, yesterday, hook.timeZone, 'Yesterday'));
          record(row.accountId, hook.id, r);
          sent++;
        }
        patch.lastDaily = yesterday;
      }
      const lastWeek = plus(monday(today), -7);
      if (hook.events.includes('report.weekly') && (hook.lastWeekly ?? '') < lastWeek) {
        if (hook.lastWeekly !== undefined) {
          const r = await post(hook, row.accountId, 'report.weekly', summary(row.accountId, lastWeek, plus(lastWeek, 6), hook.timeZone, 'Last week'));
          record(row.accountId, hook.id, r);
          sent++;
        }
        patch.lastWeekly = lastWeek;
      }
      if (Object.keys(patch).length) {
        const fresh = rows(row.accountId).find((h) => h.id === hook.id);
        if (fresh) save(row.accountId, { ...fresh, ...patch } as Webhook);
      }
      deps.problems?.resolve(row.accountId, 'job', 'webhook-reports');
    } catch (err) {
      // One broken webhook must not stop the summaries of the others.
      deps.log?.(err);
      deps.problems?.report(row.accountId, { kind: 'job', key: 'webhook-reports', severity: 'warning', message: 'The daily and weekly webhook summaries could not be built', detail: reasonOf(null, err), link: '/settings?panel=core.webhooks' });
     }
    }
    return sent;
  }

  const timer = setInterval(() => void sendDueReports().catch((err) => deps.log?.(err)), 10 * 60 * 1000);
  timer.unref();

  return {
    emit,
    notification(accountId, n) {
      const event = (n.kind && NOTIFICATION_EVENTS.has(n.kind) ? n.kind : 'other') as WebhookEvent;
      emit(accountId, event, { title: n.title, ...(n.body ? { body: n.body } : {}), tone: event === 'fees' ? 'warn' : 'info' });
    },
    onOps,
    async test(hook, accountId) {
      const names = hook.events.map((e) => WEBHOOK_EVENTS.find((x) => x.id === e)?.label ?? e);
      const r = await post(hook, accountId, hook.events[0] ?? 'other', { title: 'Zollify is connected', body: `This channel will get: ${names.join(', ')}.`, tone: 'good' });
      record(accountId, hook.id, r);
      return { ok: !r.error, ...r };
    },
    sendDueReports,
    stop: () => clearInterval(timer),
  };
}

function saleMessage(tx: Transaction, where: string | null): WebhookMessage {
  const currency = tx.currency;
  const lines = tx.items.map((i) => `${i.qty} × ${i.title}${i.variantLabel ? ` (${i.variantLabel})` : ''} - ${fmtPrice(i.lineTotal, currency)}`);
  const how = tx.payments?.length ? [...new Set(tx.payments.map((p) => p.kind))].join(' + ') : tx.method;
  return {
    title: `Sale: ${fmtPrice(tx.total, currency)}`,
    body: clip(lines.join('\n'), 1500),
    fields: [
      { name: 'Paid', value: how, inline: true },
      ...(where ? [{ name: 'At', value: where, inline: true }] : []),
      ...(tx.soldBy?.email ? [{ name: 'Sold by', value: tx.soldBy.email.split('@')[0]!, inline: true }] : []),
      ...(tx.discounts?.length ? [{ name: 'Discounts', value: tx.discounts.map((d) => `${d.name} -${fmtPrice(d.amount, currency)}`).join('\n') }] : []),
    ],
    tone: 'good',
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** A webhook as its owner sees it: the secret only matters for JSON, but they may need it to verify. */
export function registerWebhookRoutes(app: FastifyInstance, db: Database.Database, hooks: Webhooks, problems?: ModuleProblems): void {
  const admin = async (req: Parameters<typeof app.authenticate>[0], reply: Parameters<typeof app.authenticate>[1]) => {
    const claims = req.user as JwtClaims;
    if (claims.role === 'member') return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins manage webhooks.' });
    return undefined;
  };
  const opts = { preHandler: [app.authenticate, admin] };
  const list = (accountId: string): Webhook[] =>
    (db.prepare('SELECT doc FROM webhooks WHERE accountId = ? ORDER BY createdAt').all(accountId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Webhook);
  const MAX = 20;

  async function validate(body: unknown): Promise<{ input?: ReturnType<typeof WebhookInputSchema.parse>; error?: string }> {
    const parsed = WebhookInputSchema.safeParse(body);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check the webhook.' };
    if (!isTimeZone(parsed.data.timeZone)) return { error: 'Unknown time zone.' };
    const problem = await webhookTargetProblem(parsed.data.url);
    if (problem) return { error: problem };
    return { input: parsed.data };
  }

  app.get('/api/webhooks', opts, async (req) => ({ webhooks: list((req.user as JwtClaims).accountId) }));

  app.post('/api/webhooks', opts, async (req, reply) => {
    const claims = req.user as JwtClaims;
    if (list(claims.accountId).length >= MAX) return reply.code(400).send({ error: `At most ${MAX} webhooks.` });
    const { input, error } = await validate(req.body);
    if (!input) return reply.code(400).send({ error });
    const hook: Webhook = { ...input, id: randomUUID(), secret: randomBytes(24).toString('hex'), createdAt: Date.now(), lastAt: null, lastStatus: null, lastError: null, failures: 0 };
    db.prepare('INSERT INTO webhooks (id, accountId, doc, createdAt) VALUES (?, ?, ?, ?)').run(hook.id, claims.accountId, JSON.stringify(hook), hook.createdAt);
    return reply.code(201).send({ webhook: hook });
  });

  app.put<{ Params: { id: string } }>('/api/webhooks/:id', opts, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const existing = list(claims.accountId).find((h) => h.id === req.params.id);
    if (!existing) return reply.code(404).send({ error: 'No such webhook.' });
    const { input, error } = await validate(req.body);
    if (!input) return reply.code(400).send({ error });
    // Switching it back on clears the failure count.
    const hook: Webhook = { ...existing, ...input, failures: input.enabled && !existing.enabled ? 0 : existing.failures };
    db.prepare('UPDATE webhooks SET doc = ? WHERE id = ? AND accountId = ?').run(JSON.stringify(hook), hook.id, claims.accountId);
    if (hook.enabled && !existing.enabled) problems?.resolve(claims.accountId, 'webhook', hook.id);
    return { webhook: hook };
  });

  app.delete<{ Params: { id: string } }>('/api/webhooks/:id', opts, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const info = db.prepare('DELETE FROM webhooks WHERE id = ? AND accountId = ?').run(req.params.id, claims.accountId);
    if (!info.changes) return reply.code(404).send({ error: 'No such webhook.' });
    problems?.resolve(claims.accountId, 'webhook', req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/webhooks/:id/test', opts, async (req, reply) => {
    const claims = req.user as JwtClaims;
    const hook = list(claims.accountId).find((h) => h.id === req.params.id);
    if (!hook) return reply.code(404).send({ error: 'No such webhook.' });
    return hooks.test(hook, claims.accountId);
  });
}
