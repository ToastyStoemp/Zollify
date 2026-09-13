/**
 * Product merge — fold two or more catalog products into one product with a
 * variant per source, without rewriting the immutable transaction log.
 *
 * A merge is recorded as one append-only `product.merge` op. Every reader
 * resolves a sale's `(pid, vid)` through the merge map, so historical sales
 * re-attach to the merged product's variants. The map is keyed by the source's
 * *stockKey* (bare `pid`, or `pid:vid`), never the bare product id — that keeps
 * a merge safe when the merged product REUSES one source's id as its container:
 * old product-level sales (`pid`) remap to a variant, while brand-new sales of
 * that container's variants (`pid:vid`) do not match and pass through untouched.
 */

/** Cart/stock key: `pid` for a plain product line, `pid:vid` for a variant. */
export function mergeKey(pid: string, vid: string | null | undefined): string {
  return vid ? `${pid}:${vid}` : pid;
}

/** One source line folded into the merged product. */
export interface MergeSource {
  /** Source stockKey being folded away (bare `pid`, or `pid:vid`). */
  fromKey: string;
  /** Merged product id the source now lives under. */
  toPid: string;
  /** Variant id under `toPid` the source becomes (never empty in practice). */
  toVid: string;
  /** Merged product title — rewrites the frozen `title` on historical sale lines. */
  title: string;
  /** Variant label — rewrites the frozen `variantLabel` on historical sale lines. */
  variantLabel: string;
}

export interface ProductMerge {
  /** Op / record id. */
  id: string;
  /** The product every source folds into (may equal one source's product id). */
  intoId: string;
  sources: MergeSource[];
  updatedAt: number;
}

/** Where a source stockKey now resolves to. */
export interface MergeTarget {
  pid: string;
  vid: string | null;
  title: string;
  variantLabel: string;
}

/**
 * Build the source-stockKey → target map from all merges. Latest merge wins per
 * source key, and chains are followed (a target later merged again resolves to
 * its final home) so no sale is ever left pointing at a merged-away line.
 */
export function buildMergeMap(merges: ProductMerge[]): Map<string, MergeTarget> {
  const direct = new Map<string, MergeTarget>();
  for (const m of [...merges].sort((a, b) => a.updatedAt - b.updatedAt)) {
    for (const s of m.sources) {
      direct.set(s.fromKey, {
        pid: s.toPid,
        vid: s.toVid || null,
        title: s.title,
        variantLabel: s.variantLabel,
      });
    }
  }
  const resolved = new Map<string, MergeTarget>();
  for (const [fromKey, first] of direct) {
    let t = first;
    const seen = new Set<string>([fromKey]);
    // Follow chains: if the target's own stockKey was itself merged onward.
    while (true) {
      const tKey = mergeKey(t.pid, t.vid);
      if (seen.has(tKey)) break;
      const next = direct.get(tKey);
      if (!next) break;
      seen.add(tKey);
      t = next;
    }
    resolved.set(fromKey, t);
  }
  return resolved;
}

/** Resolve one `(pid, vid)` through the merge map; null if it wasn't merged. */
export function resolveMergedRef(
  map: Map<string, MergeTarget>,
  pid: string,
  vid: string | null | undefined,
): MergeTarget | null {
  return map.get(mergeKey(pid, vid)) ?? null;
}

/** A transaction sale line (the fields a remap touches). */
interface MergeableItem {
  pid: string;
  vid: string | null;
  title: string;
  variantLabel?: string;
}

/**
 * Remap a transaction's items through the merge map. Returns a new array only
 * when something changed, so callers can skip a write when nothing moved.
 */
export function remapTxItems<T extends MergeableItem>(items: T[], map: Map<string, MergeTarget>): T[] {
  if (!map.size) return items;
  let changed = false;
  const out = items.map((it) => {
    const t = resolveMergedRef(map, it.pid, it.vid);
    if (!t) return it;
    changed = true;
    return { ...it, pid: t.pid, vid: t.vid, title: t.title, variantLabel: t.variantLabel };
  });
  return changed ? out : items;
}
