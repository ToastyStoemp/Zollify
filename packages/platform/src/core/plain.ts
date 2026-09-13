import { isRef, toRaw, unref } from 'vue';

/**
 * Strips Vue reactivity so a value can be stored in IndexedDB.
 *
 * The structured clone algorithm cannot clone a Proxy, so handing a reactive
 * object straight to Dexie fails with `DataCloneError: could not be cloned`.
 * A shallow `{ ...obj }` is not enough either — the spread copies the top level
 * but leaves nested objects as proxies, which is exactly how this surfaces:
 * everything looks fine until a record happens to carry a nested field.
 *
 * This lives in core's write path rather than in each view, because modules
 * write through `sdk.data` too and would otherwise each have to remember.
 *
 * Types the clone algorithm handles natively (Blob, File, Date, ArrayBuffer,
 * Map, Set) are passed through untouched rather than rebuilt — product images
 * are Blobs, and JSON round-tripping would destroy them.
 */
export function toPlain<T>(value: T): T {
  return unwrap(value) as T;
}

function unwrap(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  const raw = isRef(value) ? unref(value) : value;

  if (raw === null || typeof raw !== 'object') return raw;

  // Structured-cloneable as-is; recursing would only risk mangling them.
  if (
    raw instanceof Blob ||
    raw instanceof Date ||
    raw instanceof ArrayBuffer ||
    ArrayBuffer.isView(raw) ||
    raw instanceof Map ||
    raw instanceof Set
  ) {
    return raw;
  }

  const target = toRaw(raw as object);

  // Cycles would otherwise recurse forever; IndexedDB tolerates them, so
  // preserving the shared reference is the honest translation.
  const cached = seen.get(target);
  if (cached !== undefined) return cached;

  if (Array.isArray(target)) {
    const out: unknown[] = [];
    seen.set(target, out);
    for (const item of target) out.push(unwrap(item, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(target, out);
  for (const [key, val] of Object.entries(target)) {
    // undefined is dropped: it is not a meaningful stored value, and keeping
    // the key would make a row look like it holds an explicit blank.
    const next = unwrap(val, seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}
