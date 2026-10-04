// P-8 context, evaluated items and rows to predict (pure).
import {
  BACKTEST_DAYS,
  Filters,
  Item,
  MAX_CONTEXT,
  MAX_ROWS,
  MIN_CONTEXT,
  MIN_EVALUATED,
  MIN_PER_CLASS,
  NEW_ORDER,
  Request,
  SAMPLE_SEED,
  addDays,
} from "./types";
import { label, supplierRegion } from "./features";

/** Buyer, purchasing group choose whose list is scored; the others define the question (and the context). */
export const CONTENT_FILTERS: (keyof Filters)[] = [
  "plant",
  "supplier",
  "supplierRegion",
  "materialType",
  "materialGroup",
  "material",
  "poDateFrom",
  "poDateTo",
];

export function contentFilters(f: Filters): Filters {
  return Object.fromEntries(
    Object.entries(f).filter(([k]) =>
      CONTENT_FILTERS.includes(k as keyof Filters),
    ),
  ) as Filters;
}

export function matches(i: Item, f: Filters): boolean {
  if (f.plant && i.Plant !== f.plant) return false;
  if (f.purchasingGroup && i.PurchasingGroup !== f.purchasingGroup)
    return false;
  if (f.supplier && i.Supplier !== f.supplier) return false;
  if (
    f.supplierRegion &&
    supplierRegion(i.SupplierCountry) !== f.supplierRegion
  )
    return false;
  if (f.materialType && i.MaterialType !== f.materialType) return false;
  if (f.materialGroup && i.MaterialGroup !== f.materialGroup) return false;
  if (f.material && i.Material !== f.material) return false;
  if (f.poDateFrom && i.PurchaseOrderDate < f.poDateFrom) return false;
  if (f.poDateTo && i.PurchaseOrderDate > f.poDateTo) return false;
  return true;
}

const byDateThenId = (a: Item, b: Item) =>
  a.PurchaseOrderDate < b.PurchaseOrderDate
    ? -1
    : a.PurchaseOrderDate > b.PurchaseOrderDate
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

export interface Labelled {
  item: Item;
  y: number;
}

/** Items ordered before `ref` with a known label; the latest MAX_CONTEXT. */
export function context(pool: Item[], req: Request, ref: string): Labelled[] {
  const out: Labelled[] = [];
  for (const i of [...pool].sort(byDateThenId)) {
    if (!(i.PurchaseOrderDate < ref)) continue;
    const y = label(i, req, ref);
    if (y !== null) out.push({ item: i, y });
  }
  return out.slice(-MAX_CONTEXT);
}

/** Reproducible sample of `max` of `n` indices (seeded, sorted). */
export function sampleIndices(
  n: number,
  max: number,
  seed = SAMPLE_SEED,
): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, max).sort((a, b) => a - b);
}

export interface Plan {
  cutoff: string;
  context: Labelled[];
  backtestContext: Labelled[];
  evaluated: Labelled[];
  notEvaluated: number;
  rows: Item[];
  newOrder: boolean;
  alreadyLate: number;
  openItems: number;
  notes: string[];
}

/** Contexts, evaluated items and rows to predict, without a model call. */
export function plan(
  items: Item[],
  req: Request,
  f: Filters,
  asOf: string,
): Plan {
  const cutoff = addDays(asOf, -BACKTEST_DAYS);
  const notes: string[] = [];
  const mine = items.filter((i) => matches(i, f));
  let pool = items.filter((i) => matches(i, contentFilters(f)));
  let ctx = context(pool, req, asOf);
  if (ctx.length < MIN_CONTEXT) {
    pool = items.filter((i) => matches(i, f.plant ? { plant: f.plant } : {}));
    ctx = context(pool, req, asOf);
    notes.push(
      `fewer than ${MIN_CONTEXT} matching items with a known outcome; context widened to plant ${f.plant ?? "all"}`,
    );
  }
  const backtestContext = context(pool, req, cutoff);
  // Evaluated items stand at the cutoff where the prediction rows stand at the as-of date: open, outcome unknown.
  let pending = mine.filter(
    (i) =>
      i.PurchaseOrderDate < cutoff &&
      (!i.AvailableDate || i.AvailableDate >= cutoff),
  );
  if (req.target === "late_by_days")
    pending = pending.filter((i) => {
      if (!i.RequestedDate) return false;
      const due = addDays(i.RequestedDate, req.lateDays ?? 0);
      return due >= cutoff && due <= asOf;
    });
  pending = pending.filter((i) => label(i, req, cutoff) === null);
  const known = pending.map((item) => ({ item, y: label(item, req, asOf) }));
  const ev = known
    .filter((x): x is Labelled => x.y !== null)
    .sort((a, b) => byDateThenId(a.item, b.item));
  const notEvaluated = known.length - ev.length;
  if (ev.length > MAX_ROWS)
    notes.push(
      `reality check on a random sample of ${MAX_ROWS} of ${ev.length} evaluated items (seed ${SAMPLE_SEED})`,
    );
  const evaluated = sampleIndices(ev.length, MAX_ROWS).map((i) => ev[i]);
  const open = mine.filter(
    (i) =>
      i.PurchaseOrderDate < asOf &&
      (i.AvailableDate ? i.AvailableDate >= asOf : i.IsOpen !== false),
  );
  const alreadyLate =
    req.target === "late_by_days"
      ? open.filter((i) => label(i, req, asOf) !== null).length
      : 0;
  let rows = open
    .filter(
      (i) =>
        label(i, req, asOf) === null &&
        (req.target !== "late_by_days" || Boolean(i.RequestedDate)),
    )
    .sort((a, b) => {
      const ra = a.RequestedDate ?? "9999";
      const rb = b.RequestedDate ?? "9999";
      return ra < rb
        ? -1
        : ra > rb
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0;
    });
  let newOrder = false;
  if (req.key && !rows.length) {
    const last = mine
      .filter((i) => i.PurchaseOrderDate < asOf)
      .sort(byDateThenId)
      .at(-1);
    if (last) {
      rows = [newOrderItem(last, asOf)];
      newOrder = true;
    }
  }
  const openItems = rows.length;
  if (rows.length > MAX_ROWS)
    notes.push(
      `prediction for the ${MAX_ROWS} open items with the earliest requested dates of ${rows.length}`,
    );
  return {
    cutoff,
    context: ctx,
    backtestContext,
    evaluated,
    notEvaluated,
    rows: rows.slice(0, MAX_ROWS),
    newOrder,
    alreadyLate,
    openItems,
    notes,
  };
}

/** No open item for the key: one row as if ordered on the as-of date, from its latest PO. */
export function newOrderItem(last: Item, asOf: string): Item {
  return {
    ...last,
    id: NEW_ORDER,
    PurchaseOrder: NEW_ORDER,
    PurchaseOrderItem: "",
    PurchaseOrderDate: asOf,
    RequestedDate: null,
    AvailableDate: null,
    PartialFirstReceipt: null,
    IsOpen: true,
  };
}

/** Enough to ask the model at all (else 0 calls, "not enough history"). */
export function enough(req: Request, p: Plan): boolean {
  if (p.evaluated.length < MIN_EVALUATED || p.backtestContext.length < 2)
    return false;
  if (req.target === "lead_time_days") return true;
  const pos = p.evaluated.filter((e) => e.y === 1).length;
  return Math.min(pos, p.evaluated.length - pos) >= MIN_PER_CLASS;
}
