// Pure collection helpers shared across features (contract A1): grouping by
// a derived key, the one operation every feature otherwise hand-rolled.

/** Groups items by keyFn into arrays, in first-seen order per key. */
export function groupBy<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    (out.get(k) ?? out.set(k, []).get(k)!).push(item);
  }
  return out;
}

/** Groups items by keyFn into Sets of valueFn(item) (e.g. deduping while grouping). */
export function groupByToSet<T, K, V = T>(items: readonly T[], keyFn: (item: T) => K, valueFn: (item: T) => V = (i) => i as unknown as V): Map<K, Set<V>> {
  const out = new Map<K, Set<V>>();
  for (const item of items) {
    const k = keyFn(item);
    (out.get(k) ?? out.set(k, new Set()).get(k)!).add(valueFn(item));
  }
  return out;
}

/** Groups items by keyFn into arrays of valueFn(item) — order and duplicates preserved (unlike groupByToSet). */
export function groupByArray<T, K, V = T>(items: readonly T[], keyFn: (item: T) => K, valueFn: (item: T) => V = (i) => i as unknown as V): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const item of items) {
    const k = keyFn(item);
    (out.get(k) ?? out.set(k, []).get(k)!).push(valueFn(item));
  }
  return out;
}

/** Indexes items by keyFn, last one wins per key (dedupe-by-key, not grouping). */
export function indexBy<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T> {
  const out = new Map<K, T>();
  for (const item of items) out.set(keyFn(item), item);
  return out;
}
