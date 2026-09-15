import { isoDay, monthKey, rid, round2, type Cluster, type MatchedEvent, type Txn } from './types';

/**
 * Clustering, ported from ZollTax. Everything here is pure: a list of clusters
 * in, a new list out. The view holds the list and re-renders; nothing mutates
 * behind its back.
 */

const GAP_DAYS = 1.5;

export function deriveStats(txns: Txn[]): Pick<Cluster, 'payments' | 'fees' | 'totalPay' | 'totalFee' | 'net' | 'start' | 'end'> {
  const sorted = [...txns].sort((a, b) => a.at - b.at);
  const payments = sorted.filter((t) => t.type === 'Payment');
  const fees = sorted.filter((t) => t.type === 'Fee');
  const totalPay = round2(payments.reduce((s, t) => s + t.amount, 0));
  const totalFee = round2(Math.abs(fees.reduce((s, t) => s + t.amount, 0)));
  return { payments, fees, totalPay, totalFee, net: round2(totalPay - totalFee), start: sorted[0]?.at ?? 0, end: sorted[sorted.length - 1]?.at ?? 0 };
}

export function makeCluster(device: string, txns: Txn[], over: Partial<Cluster> = {}): Cluster {
  return {
    uid: rid(),
    clusterID: '',
    device,
    txns,
    customName: '',
    country: '',
    cashAmount: 0,
    cashNote: '',
    isOnlineCluster: false,
    matchedEvent: null,
    bookedVoucherId: null,
    ...over,
    ...deriveStats(txns),
  };
}

/** Recomputes derived stats after txns changed. */
export function recalc(c: Cluster): Cluster {
  return { ...c, ...deriveStats(c.txns) };
}

/** Device runs split wherever two consecutive rows are more than the gap apart. */
export function clusterTxns(txns: Txn[], gapDays = GAP_DAYS): Cluster[] {
  const byDevice = new Map<string, Txn[]>();
  for (const t of txns) (byDevice.get(t.terminal) ?? byDevice.set(t.terminal, []).get(t.terminal)!).push(t);
  const gap = gapDays * 86_400_000;
  const out: Cluster[] = [];
  for (const dev of [...byDevice.keys()].sort()) {
    const sorted = byDevice.get(dev)!.sort((a, b) => a.at - b.at);
    let group: Txn[] = [sorted[0]!];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.at - sorted[i - 1]!.at > gap) {
        out.push(makeCluster(dev, group));
        group = [];
      }
      group.push(sorted[i]!);
    }
    if (group.length) out.push(makeCluster(dev, group));
  }
  return out;
}

/** Online orders: one cluster per calendar month. */
export function clusterOnlineByMonth(txns: Txn[]): Cluster[] {
  const byMonth = new Map<string, Txn[]>();
  for (const t of txns) {
    const key = monthKey(t.at);
    (byMonth.get(key) ?? byMonth.set(key, []).get(key)!).push(t);
  }
  return [...byMonth.entries()].map(([key, rows]) => makeCluster('Shopify Online', rows, { isOnlineCluster: true, monthKey: key }));
}

/** PN_YYYY_MM_NNN per month in date order; online clusters are PN_YYYY_MM_ONL. */
export function assignIds(clusters: Cluster[]): Cluster[] {
  const sorted = [...clusters].sort((a, b) => b.start - a.start);
  const asc = [...sorted].reverse();
  const counter = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const c of asc) {
    const key = monthKey(c.start);
    if (c.isOnlineCluster) ids.set(c.uid, `PN_${key}_ONL`);
    else {
      const n = (counter.get(key) ?? 0) + 1;
      counter.set(key, n);
      ids.set(c.uid, `PN_${key}_${String(n).padStart(3, '0')}`);
    }
  }
  return sorted.map((c) => ({ ...c, clusterID: ids.get(c.uid)! }));
}

/**
 * Folds newly parsed rows into the existing clusters: a new cluster whose
 * dates overlap an existing one on the same device is merged into it, with
 * rows de-duplicated by reference so re-importing a file adds nothing twice.
 */
export function mergeIn(existing: Cluster[], txns: Txn[]): Cluster[] {
  const fresh = [...clusterTxns(txns.filter((t) => !t.isOnline)), ...clusterOnlineByMonth(txns.filter((t) => t.isOnline))];
  if (!existing.length) return assignIds(fresh);
  const out = [...existing];
  for (const nc of fresh) {
    const i = out.findIndex((ec) => ec.device === nc.device && ec.start <= nc.end && ec.end >= nc.start);
    if (i >= 0) {
      const ec = out[i]!;
      const refs = new Set(ec.txns.map((t) => t.ref).filter(Boolean));
      const add = nc.txns.filter((t) => !t.ref || !refs.has(t.ref));
      out[i] = recalc({ ...ec, txns: [...ec.txns, ...add] });
    } else out.push(nc);
  }
  return assignIds(out);
}

// ── Edits ───────────────────────────────────────────────────────────────────

export function replace(clusters: Cluster[], next: Cluster): Cluster[] {
  return assignIds(clusters.map((c) => (c.uid === next.uid ? next : c)));
}

export function remove(clusters: Cluster[], uid: string): Cluster[] {
  return assignIds(clusters.filter((c) => c.uid !== uid));
}

export function removeTxn(clusters: Cluster[], uid: string, txnId: string): Cluster[] {
  const c = clusters.find((x) => x.uid === uid);
  if (!c) return clusters;
  const txns = c.txns.filter((t) => t.id !== txnId);
  return txns.length ? replace(clusters, recalc({ ...c, txns })) : remove(clusters, uid);
}

export function removeManual(clusters: Cluster[], uid: string): Cluster[] {
  const c = clusters.find((x) => x.uid === uid);
  if (!c) return clusters;
  const txns = c.txns.filter((t) => !t.isManual);
  return txns.length ? replace(clusters, recalc({ ...c, txns })) : remove(clusters, uid);
}

/** Two halves: before the split day, and from it onward. Null when one side is empty. */
export function splitAtDate(clusters: Cluster[], uid: string, isoDate: string): Cluster[] | null {
  const c = clusters.find((x) => x.uid === uid);
  if (!c) return null;
  const at = new Date(`${isoDate}T00:00:00`).getTime();
  const a = c.txns.filter((t) => t.at < at);
  const b = c.txns.filter((t) => t.at >= at);
  if (!a.length || !b.length) return null;
  return splitInto(clusters, c, a, b, ' (1)', ' (2)');
}

export function splitSelected(clusters: Cluster[], uid: string, txnIds: string[]): Cluster[] | null {
  const c = clusters.find((x) => x.uid === uid);
  if (!c) return null;
  const set = new Set(txnIds);
  const a = c.txns.filter((t) => set.has(t.id));
  const b = c.txns.filter((t) => !set.has(t.id));
  if (!a.length || !b.length) return null;
  return splitInto(clusters, c, a, b, ' (split)', '');
}

function splitInto(clusters: Cluster[], c: Cluster, a: Txn[], b: Txn[], sufA: string, sufB: string): Cluster[] {
  const name = (s: string): string => (c.customName ? c.customName + s : '');
  const na = makeCluster(c.device, a, { customName: name(sufA), country: c.country });
  const nb = makeCluster(c.device, b, { customName: name(sufB), country: c.country });
  return assignIds([...clusters.filter((x) => x.uid !== c.uid), na, nb]);
}

export function mergeTwo(clusters: Cluster[], uidA: string, uidB: string): Cluster[] {
  const a = clusters.find((x) => x.uid === uidA);
  const b = clusters.find((x) => x.uid === uidB);
  if (!a || !b) return clusters;
  const devices = [...new Set([...(a.devices ?? [a.device]), ...(b.devices ?? [b.device])])];
  const merged = makeCluster(devices.join(' + '), [...a.txns, ...b.txns], {
    devices,
    customName: a.customName || b.customName,
    country: a.country || b.country,
    cashAmount: round2((a.cashAmount || 0) + (b.cashAmount || 0)),
    cashNote: [a.cashNote, b.cashNote].filter(Boolean).join(', '),
    matchedEvent: a.matchedEvent ?? b.matchedEvent,
  });
  return assignIds([...clusters.filter((x) => x.uid !== uidA && x.uid !== uidB), merged]);
}

/** Folds a POS cluster into its month's online cluster, or makes it that cluster. */
export function markOnline(clusters: Cluster[], uid: string): Cluster[] {
  const c = clusters.find((x) => x.uid === uid);
  if (!c || c.isOnlineCluster) return clusters;
  const key = monthKey(c.start);
  const target = clusters.find((x) => x.uid !== uid && x.isOnlineCluster && monthKey(x.start) === key);
  if (target) {
    const refs = new Set(target.txns.map((t) => t.ref).filter(Boolean));
    const add = c.txns.filter((t) => !t.ref || !refs.has(t.ref));
    const next = recalc({
      ...target,
      txns: [...target.txns, ...add],
      cashAmount: round2((target.cashAmount || 0) + (c.cashAmount || 0)),
      cashNote: [target.cashNote, c.cashNote].filter(Boolean).join(', '),
    });
    return assignIds(clusters.filter((x) => x.uid !== uid).map((x) => (x.uid === next.uid ? next : x)));
  }
  return replace(clusters, { ...c, isOnlineCluster: true, manualOnline: true, monthKey: key });
}

export function revertOnline(clusters: Cluster[], uid: string): Cluster[] {
  const c = clusters.find((x) => x.uid === uid);
  if (!c?.manualOnline) return clusters;
  const { monthKey: _m, ...rest } = c;
  return replace(clusters, { ...rest, isOnlineCluster: false, manualOnline: false });
}

/** Other devices' clusters overlapping these dates - probably the same event. */
export function overlapping(clusters: Cluster[], c: Cluster): Cluster[] {
  if (c.isOnlineCluster) return [];
  return clusters.filter((o) => o.uid !== c.uid && o.device !== c.device && !o.isOnlineCluster && o.start <= c.end && o.end >= c.start);
}

// ── Events ──────────────────────────────────────────────────────────────────

export function overlappingEvents(c: Cluster, events: MatchedEvent[]): MatchedEvent[] {
  if (c.isOnlineCluster) return [];
  const s = isoDay(c.start);
  const e = isoDay(c.end);
  return events.filter((ev) => ev.dateStart <= e && ev.dateEnd >= s);
}

/** Prefer an event starting the same day; else any that overlaps. */
export function suggestEvent(c: Cluster, events: MatchedEvent[]): MatchedEvent | null {
  if (c.isOnlineCluster) return null;
  const s = isoDay(c.start);
  return events.find((ev) => ev.dateStart === s) ?? overlappingEvents(c, events)[0] ?? null;
}

export function matchTo(c: Cluster, ev: MatchedEvent | null): Cluster {
  if (!ev) return { ...c, matchedEvent: null };
  return { ...c, matchedEvent: ev, customName: c.customName || ev.name, country: c.country || ev.country };
}

/**
 * Auto merge and match: each POS cluster is assigned to the single event that
 * overlaps it (two overlapping events → left for a human); clusters resolving
 * to the same event merge into one booking across terminals.
 */
export function autoMergeAndMatch(clusters: Cluster[], events: MatchedEvent[]): { clusters: Cluster[]; matched: number; merged: number; ambiguous: number } {
  const pos = clusters.filter((c) => !c.isOnlineCluster);
  const mapping = new Map<string, MatchedEvent>();
  let ambiguous = 0;
  for (const c of pos) {
    if (c.matchedEvent) {
      mapping.set(c.uid, c.matchedEvent);
      continue;
    }
    const cands = overlappingEvents(c, events);
    if (cands.length === 1) mapping.set(c.uid, cands[0]!);
    else if (cands.length > 1) ambiguous++;
  }
  const groups = new Map<string, { ev: MatchedEvent; members: Cluster[] }>();
  for (const c of pos) {
    const ev = mapping.get(c.uid);
    if (!ev) continue;
    (groups.get(ev.id) ?? groups.set(ev.id, { ev, members: [] }).get(ev.id)!).members.push(c);
  }
  let matched = 0;
  let merged = 0;
  const consumed = new Set<string>();
  const created: Cluster[] = [];
  const singles = new Map<string, Cluster>();
  for (const { ev, members } of groups.values()) {
    matched += members.length;
    if (members.length > 1) {
      members.forEach((c) => consumed.add(c.uid));
      const devices = [...new Set(members.flatMap((c) => c.devices ?? [c.device]))];
      created.push(
        makeCluster(devices.join(' + '), members.flatMap((c) => c.txns), {
          devices,
          cashAmount: round2(members.reduce((s, c) => s + (c.cashAmount || 0), 0)),
          cashNote: members.map((c) => c.cashNote).filter(Boolean).join(', '),
          matchedEvent: ev,
          customName: ev.name,
          country: ev.country,
        }),
      );
      merged++;
    } else singles.set(members[0]!.uid, matchTo(members[0]!, ev));
  }
  const next = clusters.filter((c) => !consumed.has(c.uid)).map((c) => singles.get(c.uid) ?? c).concat(created);
  return { clusters: assignIds(next), matched, merged, ambiguous };
}

/** Bookable once it is online, matched, or simply named - dates always exist. */
export function ready(c: Cluster): boolean {
  return Boolean(c.isOnlineCluster || c.matchedEvent || c.customName.trim());
}

// ── Lexware templates ───────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = { mypos: 'myPOS', shopify: 'Shopify', sumup: 'SumUp', wise: 'Wise' };

export function platformOf(txns: Txn[]): string {
  const named = [...new Set(txns.map((t) => t.source))].map((s) => PLATFORM_LABELS[s] ?? s);
  return named.length ? named.join(' + ') : 'POS';
}

export function renderTemplate(str: string, vars: Record<string, string>): string {
  if (!str) return '';
  return str
    .replace(/\[(\w+)\]/g, (_, k: string) => vars[k] ?? '')
    .replace(/\s*[---]\s*[---]\s*/g, ' - ')
    .replace(/^\s*[---]\s*/, '')
    .replace(/\s*[---]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const isGermany = (country: string): boolean => /^(germany|deutschland|de|ger|deu)$/i.test(country.trim());

export function vatRateFor(country: string, domesticVat: number): number {
  return isGermany(country) ? domesticVat : 0;
}

export const monthLabel = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
export const fmtAmt = (n: number, currency = 'EUR'): string => `${currency} ${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

export function templateVars(c: Cluster, domesticVat: number): Record<string, string> {
  const ev = c.matchedEvent;
  const name = c.customName.trim() || ev?.name || '';
  const country = c.country || ev?.country || '';
  const d = new Date(c.start);
  return {
    sales_platform: platformOf(c.txns),
    event_name: name,
    event_country: country,
    event_start: ev ? ev.dateStart : isoDay(c.start),
    event_end: ev ? ev.dateEnd : isoDay(c.end),
    month: monthLabel(c.start),
    month_num: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    year: String(d.getFullYear()),
    vat_rate: `${vatRateFor(country, domesticVat)}%`,
    cluster_id: c.clusterID,
    total: fmtAmt(c.totalPay + (c.cashAmount || 0)),
    currency: c.txns[0]?.currency ?? 'EUR',
  };
}

export interface BookingPayload {
  kind: 'revenue' | 'fees';
  voucherNumber: string;
  customer?: 'contact' | 'collective';
  customerName?: string;
  voucherDate?: string;
  dueDate?: string;
  totalGrossAmount: number;
  taxType: 'gross';
  taxRatePercent?: number;
  category?: string;
  remark?: string;
  event?: { name: string; country?: string; startDate: string; endDate: string; vatRate: number };
  pdfBase64?: string;
  filename?: string;
}

/** The revenue booking for a cluster, from its own data. Null when a POS cluster has no name. */
export function revenuePayload(c: Cluster, cfg: Record<string, string>, domesticVat: number): BookingPayload | null {
  const total = round2(c.totalPay + (c.cashAmount || 0));
  const vars = templateVars(c, domesticVat);
  const tpl = (key: string, fallback: string): string => renderTemplate(cfg[key]?.trim() || fallback, vars);
  if (c.isOnlineCluster) {
    return {
      kind: 'revenue',
      voucherNumber: `${c.clusterID}_P`,
      customer: 'contact',
      customerName: tpl('LEXWARE_ONLINE_TITLE_TEMPLATE', 'Revenue - Online Sales') || 'Revenue - Online Sales',
      voucherDate: isoDay(c.start),
      dueDate: isoDay(c.end),
      totalGrossAmount: total,
      taxType: 'gross',
      category: 'einnahmen',
      remark: tpl('LEXWARE_ONLINE_DESC_TEMPLATE', '[sales_platform] - [month]'),
    };
  }
  const ev = c.matchedEvent;
  const name = c.customName.trim() || ev?.name || '';
  if (!name) return null;
  const country = c.country || ev?.country || '';
  return {
    kind: 'revenue',
    voucherNumber: `${c.clusterID}_P`,
    customer: 'contact',
    customerName: tpl('LEXWARE_EVENT_TITLE_TEMPLATE', 'Revenue - [event_name]') || `Revenue - ${name}`,
    event: { name, country: country || undefined, startDate: ev ? ev.dateStart : isoDay(c.start), endDate: ev ? ev.dateEnd : isoDay(c.end), vatRate: vatRateFor(country, domesticVat) },
    totalGrossAmount: total,
    taxType: 'gross',
    category: 'einnahmen',
    remark: tpl('LEXWARE_EVENT_DESC_TEMPLATE', 'Point of Sales - [event_name] - [event_country]'),
  };
}

/** One fees voucher for a month, across every cluster in it. */
export function feesPayload(key: string, clusters: Cluster[], cfg: Record<string, string>): BookingPayload | null {
  const inMonth = clusters.filter((c) => monthKey(c.start) === key);
  const totalFee = round2(inMonth.reduce((s, c) => s + c.totalFee, 0));
  if (totalFee <= 0) return null;
  const [yr, mo] = key.split('_') as [string, string];
  const srcs = [...new Set(inMonth.filter((c) => c.totalFee > 0).flatMap((c) => c.txns.map((t) => t.source)))];
  const vars = {
    sales_platform: srcs.length ? srcs.map((s) => PLATFORM_LABELS[s] ?? s).join(' + ') : 'myPOS',
    month: monthLabel(new Date(Number(yr), Number(mo) - 1, 1).getTime()),
    month_num: `${yr}-${mo}`,
    year: yr,
    cluster_id: `PN_${key}_F`,
  };
  return {
    kind: 'fees',
    voucherNumber: `PN_${key}_F`,
    voucherDate: `${yr}-${mo}-28`,
    totalGrossAmount: totalFee,
    taxType: 'gross',
    taxRatePercent: 0,
    remark: renderTemplate(cfg.LEXWARE_FEE_DESC_TEMPLATE?.trim() || '[sales_platform] fees [month]', vars),
  };
}
