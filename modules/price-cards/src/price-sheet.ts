import type { DiscountRule, Product } from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';

/**
 * Builds a merged, print-ready price sheet from the catalog + discount rules.
 * Ported from ZollTool.
 *
 * Merging mirrors how a stall actually quotes prices: a variant name shared by
 * two or more products (a *size* like "A4") collapses across every product into
 * one line ("A4 - 25"); design variants unique to a product (keychain designs)
 * collapse into the product, and same-price products of one type then merge into
 * a single "any [type]" line. Discounts that touch a line (by type, product, or
 * variant) are attached as short deal tags. Callers pick which lines to include.
 */

export interface PriceUnit {
  pid: string;
  vid: string;
}
export interface PriceLine {
  /** Stable key for selection state. */
  id: string;
  label: string;
  qual?: string;
  price: number;
  deals: string[];
  units: PriceUnit[];
}
export interface PriceGroup {
  type: string;
  lines: PriceLine[];
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface Unit {
  pid: string;
  vid: string;
  type: string;
  title: string;
  vname: string;
  price: number;
}
interface Entry {
  type: string;
  kind: 'size' | 'prod';
  key: string;
  label: string;
  qual?: string;
  price: number;
  units: Unit[];
}

export function buildPriceGroups(products: Product[], discounts: DiscountRule[], currency: string): PriceGroup[] {
  const live = products.filter((p) => !p.deletedAt && p.forSale !== false);

  // 1 - flatten catalog to sellable units (a product, or one row per variant).
  const units: Unit[] = [];
  for (const p of live) {
    const type = (p.type || '').trim() || 'Other';
    const title = (p.title || '').replace(/\s*[---]\s*$/, '').trim() || '(untitled)';
    if (p.variants?.length) {
      for (const v of p.variants) {
        units.push({ pid: p.id, vid: v.id, type, title, vname: (v.name || '').trim(), price: round2(v.price ?? p.price ?? 0) });
      }
    } else {
      units.push({ pid: p.id, vid: '', type, title, vname: '', price: round2(p.price ?? 0) });
    }
  }

  // 2 - which variant names are "sizes" (used by ≥2 products of that type).
  const nameOwners = new Map<string, Set<string>>();
  for (const u of units) {
    if (!u.vname) continue;
    const k = `${u.type}|${u.vname.toLowerCase()}`;
    let s = nameOwners.get(k);
    if (!s) nameOwners.set(k, (s = new Set()));
    s.add(u.pid);
  }
  const isSize = (u: Unit): boolean => !!u.vname && (nameOwners.get(`${u.type}|${u.vname.toLowerCase()}`)?.size ?? 0) >= 2;

  // 3 - group units into size-entries (by shared name) or product-entries.
  const entryMap = new Map<string, Entry>();
  const add = (key: string, make: () => Entry, u: Unit): void => {
    let e = entryMap.get(key);
    if (!e) entryMap.set(key, (e = make()));
    e.units.push(u);
  };
  for (const u of units) {
    if (isSize(u)) {
      const key = `${u.type}|size|${u.vname.toLowerCase()}|${u.price}`;
      add(key, () => ({ type: u.type, kind: 'size', key, label: u.vname, price: u.price, units: [] }), u);
    } else {
      const key = `${u.type}|prod|${u.pid}|${u.price}`;
      add(key, () => ({ type: u.type, kind: 'prod', key, label: u.title, price: u.price, units: [] }), u);
    }
  }
  const entries = [...entryMap.values()];
  for (const e of entries) {
    if (e.kind === 'size') {
      const titles = new Set(e.units.map((u) => u.title));
      if (titles.size === 1) e.qual = e.units[0]!.title; // a size unique to one print → name it
    } else {
      const designs = e.units.filter((u) => u.vname);
      if (designs.length > 1) e.qual = `${designs.length} designs`;
      else if (designs.length === 1) e.qual = designs[0]!.vname;
    }
  }

  // 4 - merge same-price product-entries of one type into a single "any" line.
  const finals: Entry[] = entries.filter((e) => e.kind === 'size');
  const byTypePrice = new Map<string, Entry[]>();
  for (const e of entries.filter((e) => e.kind === 'prod')) {
    const k = `${e.type}|${e.price}`;
    let a = byTypePrice.get(k);
    if (!a) byTypePrice.set(k, (a = []));
    a.push(e);
  }
  for (const group of byTypePrice.values()) {
    const distinctProducts = new Set(group.flatMap((e) => e.units.map((u) => u.pid)));
    // Collapse to "any [type]" only for a real design range (3+ products at one
    // price), so two distinct items that merely share a price stay named.
    if (group.length >= 3 && distinctProducts.size >= 3) {
      const g0 = group[0]!;
      finals.push({ type: g0.type, kind: 'prod', key: `${g0.type}|any|${g0.price}`, label: g0.type, qual: 'any design', price: g0.price, units: group.flatMap((e) => e.units) });
    } else {
      finals.push(...group);
    }
  }

  // 5 - attach discounts.
  const dealsFor = (e: Entry): string[] => {
    const pids = new Set(e.units.map((u) => u.pid));
    const vkeys = new Set(e.units.map((u) => `${u.pid}:${u.vid}`));
    const out: string[] = [];
    for (const d of discounts) {
      if (d.deletedAt) continue;
      const hit =
        d.productTypes?.includes(e.type) ||
        d.productIds?.some((id) => pids.has(id)) ||
        d.variantIds?.some((vk) => vkeys.has(vk));
      if (hit) out.push(dealText(d, currency));
    }
    return [...new Set(out.filter(Boolean))];
  };

  // 6 - types with a single product collapse into a shared "Other" group.
  const OTHER = 'Other';
  const productsPerType = new Map<string, Set<string>>();
  for (const e of finals) {
    let s = productsPerType.get(e.type);
    if (!s) productsPerType.set(e.type, (s = new Set()));
    e.units.forEach((u) => s!.add(u.pid));
  }
  for (const e of finals) {
    if (e.type !== OTHER && (productsPerType.get(e.type)?.size ?? 0) <= 1) e.type = OTHER;
  }

  // 7 - group by type, ordered lines; "Other" sorts last.
  const byType = new Map<string, PriceLine[]>();
  for (const e of finals) {
    const line: PriceLine = { id: e.key, label: e.label, qual: e.qual, price: e.price, deals: dealsFor(e), units: e.units.map((u) => ({ pid: u.pid, vid: u.vid })) };
    let a = byType.get(e.type);
    if (!a) byType.set(e.type, (a = []));
    a.push(line);
  }
  return [...byType.entries()]
    .map(([type, lines]) => ({ type, lines: lines.sort((a, b) => a.price - b.price || a.label.localeCompare(b.label)) }))
    .sort((a, b) => (a.type === OTHER ? 1 : 0) - (b.type === OTHER ? 1 : 0) || a.type.localeCompare(b.type));
}

function dealText(d: DiscountRule, currency: string): string {
  const m = (n: number): string => fmtPrice(n, currency);
  if (d.type === 'tiered' && d.tiers?.length) return d.tiers.map((t) => `${t.qty} for ${m(t.total)}`).join(' · ');
  if (d.type === 'bxgy') return `buy ${d.buyQty ?? 2}, ${d.freeQty ?? 1} free`;
  if (d.type === 'nth_pct') return `every ${ordinal(d.nth ?? 3)} ${d.percent ?? 0}% off`;
  if (d.type === 'combo') return `bundle −${m(d.comboDiscountAmount ?? 0)}`;
  return '';
}
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A self-contained, print-ready HTML price sheet for the given (already filtered) groups. */
export function buildPriceSheetHtml(
  groups: PriceGroup[],
  opts: { title: string; currency: string; subtitle?: string; logo?: string; footer?: string },
): string {
  const section = (g: PriceGroup): string => `
    <section>
      <h2>${esc(g.type)}</h2>
      <ul>${g.lines
        .map(
          (l) => `<li>
          <span class="nm">${esc(l.label)}${l.qual ? ` <span class="q">${esc(l.qual)}</span>` : ''}</span>
          <span class="dot"></span>
          <span class="pr">${esc(fmtPrice(l.price, opts.currency))}</span>
          ${l.deals.length ? `<span class="dl">${l.deals.map((d) => `<span class="tag">${esc(d)}</span>`).join('')}</span>` : ''}
        </li>`,
        )
        .join('')}</ul>
    </section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
  :root{--ink:#26221b;--muted:#8c8578;--faint:#bcb4a4;--line:#e6e0d3;--deal:#0c766b;--deal-bg:#e7f2ef;--deal-line:#c3e0d9;}
  *{box-sizing:border-box;}
  body{margin:0;background:#f2efe6;color:var(--ink);font-family:"Hanken Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.32;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:940px;margin:0 auto;padding:22px 22px 48px;}
  .bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px;}
  .logo{height:48px;width:auto;max-width:160px;object-fit:contain;flex:none;}
  .head{min-width:0;}
  h1{font-weight:700;font-size:1.45rem;letter-spacing:-.01em;margin:0;}
  .sub{color:var(--muted);font-size:.82rem;margin:3px 0 0;}
  footer{margin-top:14px;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:.8rem;text-align:center;}
  footer div{margin:1px 0;}
  button{margin-left:auto;font:inherit;font-weight:600;font-size:.82rem;background:var(--deal);color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;}
  .cols{columns:2;column-gap:18px;}
  @media(max-width:640px){.cols{columns:1;}}
  section{break-inside:avoid;background:#fff;border:1px solid var(--line);border-radius:9px;padding:9px 12px;margin:0 0 12px;}
  h2{font-weight:700;font-size:.95rem;margin:0 0 5px;padding-bottom:5px;border-bottom:1px solid var(--line);}
  ul{list-style:none;margin:0;padding:0;}
  li{display:grid;grid-template-columns:1fr auto;align-items:baseline;column-gap:8px;padding:3px 0;}
  li+li{border-top:1px dashed var(--line);}
  .nm{font-weight:500;}
  .q{color:var(--muted);font-weight:400;font-size:.85em;}
  .dot{grid-column:auto;border-bottom:1px dotted var(--faint);transform:translateY(-3px);align-self:center;min-width:10px;}
  .pr{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .dl{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;}
  .tag{font-weight:600;font-size:.68rem;color:var(--deal);background:var(--deal-bg);border:1px solid var(--deal-line);border-radius:999px;padding:1px 7px;}
  @media print{
    html,body{background:#fff;font-size:10.5px;}
    .wrap{padding:0;max-width:none;}
    button,.noprint{display:none;}
    .logo{height:40px;}
    footer{font-size:.72rem;margin-top:10px;}
    section{box-shadow:none;border-radius:0;border:0;border-top:1.5px solid var(--ink);padding:6px 0 4px;margin:0 0 8px;background:transparent;break-inside:avoid;}
    h2{font-size:.9rem;padding-bottom:3px;border-bottom:0;}
    .cols{columns:2;column-gap:14px;}
    @page{size:A4 portrait;margin:9mm;}
  }
</style></head>
<body><div class="wrap">
  <div class="bar">
    ${opts.logo ? `<img class="logo" src="${opts.logo}" alt="">` : ''}
    <div class="head"><h1>${esc(opts.title)}</h1>${opts.subtitle ? `<p class="sub">${esc(opts.subtitle)}</p>` : ''}</div>
    <button class="noprint" onclick="window.print()">Print / Save PDF</button>
  </div>
  <div class="cols">${groups.map(section).join('')}</div>
  ${opts.footer ? `<footer>${opts.footer.split('\n').map((l) => `<div>${esc(l)}</div>`).join('')}</footer>` : ''}
</div></body></html>`;
}
