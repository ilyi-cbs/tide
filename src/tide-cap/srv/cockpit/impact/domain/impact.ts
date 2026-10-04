// Impact of a late PO item on customers, production and stock (source
// "calculation": no model call). Pure: no CDS, no I/O.
//
// The expected arrival is the confirmed date of the latest supplier
// confirmation if one exists, else the PO date plus the median of the item's
// lead-time grid; the cautious case uses the 0.8 level. An open item cannot
// arrive before the as-of day.
//
// - Make-to-order (account assignment E with a sales order, or a third-party
//   item with a sales order): the receipt serves one sales order item. The
//   delay counts against the component requirement date of the sales order's
//   production order (else the customer date), the customer delay against the
//   slack between production end and the customer date.
// - Everything else: an MD04-like projection of the plant segment. The item's
//   receipt moves from its requested date to the expected arrival; every other
//   element keeps its date. Requirements in [max(requested, asOf), expected)
//   that leave the projection below zero are short. Single level; SAP pegging
//   is not read.

import {
  addDays,
  daysBetween,
  workingDaysBetween,
} from "../../kernel/calendar";
import type { ImpactLevel } from "../../kernel/types";
export type { ImpactLevel };
/** P-2 severity order, most severe first: the index is the rank. */
export const LEVEL_NAMES: readonly ImpactLevel[] = [
  "customer_order_late",
  "production_affected",
  "stock_uncovered",
  "covered_by_stock",
  "no_impact",
];
export type MaterialKind =
  | "trading_goods"
  | "spare_part"
  | "non_stock"
  | "make_to_stock"
  | "make_to_order";

export const CRITICALITY: Record<ImpactLevel, number> = {
  customer_order_late: 1,
  production_affected: 1,
  stock_uncovered: 2,
  covered_by_stock: 3,
  no_impact: 0,
};

/** MRP element categories as SAP names them in MD04. */
export const CAT = {
  poItem: "BE",
  plannedOrder: "PA",
  productionOrder: "FE",
  reservation: "AR",
  salesOrder: "VC",
  independent: "PP",
  dependent: "SB",
} as const;

export const MEDIAN = 0.5;
export const CAUTIOUS = 0.8;
export const SCENARIO_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
export const MD04_ROWS = 30;
export const KINDS: Record<string, MaterialKind> = {
  HAWA: "trading_goods",
  ERSA: "spare_part",
  NLAG: "non_stock",
};
/** Buyer words of the material kind. */
export const KIND_WORDS: Record<MaterialKind, string> = {
  trading_goods: "Trading goods",
  spare_part: "Spare part",
  non_stock: "Non-stock material",
  make_to_stock: "Stock material",
  make_to_order: "Bought for a sales order",
};
/** Buyer words of the MRP element categories in the stock/requirements rows. */
export const ELEMENT_WORDS: Record<string, string> = {
  BE: "PO item",
  PA: "Planned order",
  FE: "Production order",
  AR: "Reservation",
  VC: "Sales order",
  PP: "Planned demand",
  SB: "Dependent requirement",
};
export const KIND_NOTES: Record<MaterialKind, string> = {
  trading_goods: "Trading goods: bought and sold without production.",
  spare_part: "Spare part: kept in stock for maintenance and service.",
  non_stock:
    "Non-stock material: consumed on receipt, no stock to cover a delay.",
  make_to_stock:
    "Stock material: the delay is covered or not by the plant stock.",
  make_to_order:
    "Bought for one sales order: the receipt serves that customer only.",
};
export const NOTE =
  "Make-to-stock assignment computed from the stock/requirements projection, single level; SAP pegging is not read.";
export const MAKE_TO_ORDER_NOTE =
  "Sales order stock (account assignment E) or third-party item: the receipt is assigned to this sales order.";
export const NO_RANGE_NOTE =
  "No lead-time range for this item: the requested date stands in for the expected arrival.";
export const SCENARIO_NOTE =
  "Scenarios at the levels of the lead-time grid; possible outcomes, not likelihoods.";

// ---------- dates (kernel calendar, NS-B3) ----------

export { addDays };
export const days = daysBetween;
export const workingDays = workingDaysBetween;
export const maxDate = (a: string, b: string) => (a > b ? a : b);

// ---------- grid ----------

/** Levels -> days from a JSON grid (`{"0.05":d,…}`) or an object; sorted by level. */
export function parseGrid(
  g: string | Record<string, number> | null | undefined,
): Array<[number, number]> | null {
  if (!g) return null;
  let o: Record<string, number>;
  try {
    o = typeof g === "string" ? JSON.parse(g) : g;
  } catch {
    return null;
  }
  const pts = Object.entries(o)
    .map(([k, v]) => [Number(k), Number(v)] as [number, number])
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  return pts.length ? pts : null;
}

/** Linear interpolation, clamped at the ends (numpy.interp). */
export function gridAt(pts: Array<[number, number]>, level: number): number {
  if (level <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (level >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (level <= x1) {
      const [x0, y0] = pts[i - 1];
      return y0 + ((y1 - y0) * (level - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** PO date plus the lead time at the level, whole days, not before the as-of day. */
export function arrival(
  poDate: string,
  grid: Array<[number, number]>,
  asOf: string,
  level = MEDIAN,
): string {
  return maxDate(addDays(poDate, Math.ceil(gridAt(grid, level) - 1e-9)), asOf);
}

// ---------- inputs ----------

export interface MrpElement {
  category: string; // BE PA FE AR VC PP SB
  id: string; // document number
  item: string; // document item
  line?: string; // schedule line (BE)
  date: string; // availability or requirement date
  qty: number; // + receipt, - requirement (open quantity)
  productionOrder?: string; // AR: the order of the reservation
  salesOrder?: string; // VC
  salesOrderItem?: string; // VC
}

export interface SalesOrderInfo {
  salesOrder: string;
  salesOrderItem: string;
  customer: string | null;
  customerName: string | null;
  netAmount: number | null; // EUR
  currency: string | null; // EUR
  customerDate: string | null;
}

export interface MtoLink {
  assignment: "E" | "third_party";
  order: SalesOrderInfo;
  /** Production order of the sales order item and the component of this material in it. */
  productionOrder?: {
    order: string;
    product: string | null;
    end: string | null;
  };
  component?: { reservation: string; item: string; date: string; qty: number };
}

export interface ImpactItem {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  ScheduleLine?: string | null;
  Material: string | null;
  Plant: string;
  PurchaseOrderDate: string;
  RequestedDate: string | null;
  OpenQuantity?: number | null;
  MaterialType?: string | null;
  mto?: MtoLink | MtoLink[] | null;
}

/** The plant segment of one material. */
export interface MaterialPlan {
  stock: number;
  elements: MrpElement[];
}

export interface Planning {
  asOf: string;
  plan(material: string, plant: string): MaterialPlan;
  salesOrder(so: string, item: string): SalesOrderInfo | undefined;
}

export interface Arrival {
  /** Grid of the item (LineGrid levels, else SourceRange quantiles). */
  grid?: Array<[number, number]> | null;
  gridSource?: string | null;
  /** Latest confirmation line. */
  confirmation?: { date: string; quantity?: number | null } | null;
}

// ---------- outputs ----------

export interface Md04Row {
  date: string;
  element: string;
  elementText: string;
  id: string;
  qty: number;
  available: number;
  own: boolean;
  affected: boolean;
}

export interface Scenario {
  level: number;
  arrival: string;
  revenue: number | null;
  customerDelayDays: number;
}

export interface Outcome {
  level: ImpactLevel;
  rank: number; // 0..4
  materialKind: MaterialKind;
  expectedDate: string;
  needDate: string | null;
  delayDays: number;
  customerDelayDays: number;
  revenueAtRisk: number | null;
  salesOrders: SalesOrderInfo[];
  productionOrders: string[];
  shortageFrom: string | null;
  shortageDays: number | null;
  coverageDays: number | null;
  stock: number | null;
  md04: Md04Row[];
  chain: Record<string, unknown> | null;
}

export interface Impact extends Outcome {
  kindNote: string;
  cautiousDate: string | null;
  revenueCautious: number | null;
  cautiousLevel: ImpactLevel | null;
  confirmedDate: string | null;
  confirmedAfterNeed: boolean | null;
  arrivalSource: "confirmation" | "grid" | "requested";
  note: string;
  scenarios: Scenario[] | null;
}

// ---------- make-to-order ----------

export function makeToOrder(
  it: ImpactItem,
  links: MtoLink | MtoLink[],
  expected: string,
  asOf: string,
): Outcome {
  links = Array.isArray(links) ? links : [links];
  const chain = (link: MtoLink) => {
    const customerDate =
      link.order.customerDate ?? it.RequestedDate ?? expected;
    const need = link.component?.date ?? customerDate;
    const prodEnd = link.productionOrder?.end ?? null;
    const slack = prodEnd ? Math.max(0, days(prodEnd, customerDate)) : 0;
    const delay = Math.max(0, days(need, expected));
    const customerDelay = Math.max(0, delay - slack);
    return {
      link,
      customerDate,
      need,
      prodEnd,
      slack,
      delay,
      customerDelay,
      rank: customerDelay > 0 ? 0 : delay > 0 ? 1 : 4,
    };
  };
  const chains = links.map(chain);
  const primary = [...chains].sort(
    (a, b) =>
      a.rank - b.rank || b.customerDelay - a.customerDelay || b.delay - a.delay,
  )[0];
  const {
    link,
    customerDate,
    need,
    prodEnd,
    slack,
    delay,
    customerDelay,
    rank,
  } = primary;
  const o = link.order;
  const orderKey = `${o.salesOrder}/${o.salesOrderItem}`;
  // Sales order segment: the own receipt against the component (or the sales order item itself).
  const own: MrpElement = {
    category: CAT.poItem,
    id: it.PurchaseOrder,
    item: it.PurchaseOrderItem,
    date: expected,
    qty: Math.abs(Number(it.OpenQuantity ?? link.component?.qty ?? 1)),
  };
  const need0: MrpElement = link.component
    ? {
        category: CAT.reservation,
        id: link.component.reservation,
        item: link.component.item,
        date: need,
        qty: -Math.abs(link.component.qty),
      }
    : {
        category: CAT.salesOrder,
        id: o.salesOrder,
        item: o.salesOrderItem,
        date: need,
        qty: -own.qty,
      };
  const proj = project([own, need0], 0, asOf);
  // The need date may lie before the as-of day and be clipped onto the receipt: mark it by the delay, not by the balance.
  const md04 = md04Rows(proj, new Set(), it).map((r) =>
    delay > 0 && !r.own ? { ...r, affected: true } : r,
  );
  const affected = [
    ...new Map(
      chains
        .filter((candidate) => candidate.customerDelay > 0)
        .map((candidate) => [
          `${candidate.link.order.salesOrder}/${candidate.link.order.salesOrderItem}`,
          candidate.link.order,
        ]),
    ).values(),
  ];
  const productionOrders = [
    ...new Set(
      chains
        .filter(
          (candidate) => candidate.delay > 0 && candidate.link.productionOrder,
        )
        .map((candidate) => candidate.link.productionOrder!.order),
    ),
  ];
  return {
    level: LEVEL_NAMES[rank],
    rank,
    materialKind: "make_to_order",
    expectedDate: expected,
    needDate: need,
    delayDays: delay,
    customerDelayDays: customerDelay,
    revenueAtRisk: sumRevenue(affected.map((order) => order.netAmount)),
    salesOrders: affected,
    productionOrders,
    shortageFrom: delay > 0 ? need : null,
    shortageDays: delay > 0 ? Math.max(0, workingDays(need, expected)) : null,
    coverageDays: null,
    stock: null,
    md04,
    chain: {
      purchaseOrderItem: `${it.PurchaseOrder}/${it.PurchaseOrderItem}`,
      accountAssignment:
        link.assignment === "E"
          ? "E (sales order stock)"
          : "third party (delivered to the customer)",
      salesOrder: orderKey,
      affectedSalesOrders: affected.map(
        (order) => `${order.salesOrder}/${order.salesOrderItem}`,
      ),
      salesOrderDelays: chains
        .filter((candidate) => candidate.customerDelay > 0)
        .map((candidate) => ({
          key: `${candidate.link.order.salesOrder}/${candidate.link.order.salesOrderItem}`,
          delayDays: candidate.customerDelay,
        })),
      productionRequirements: chains
        .filter(
          (candidate) => candidate.delay > 0 && candidate.link.productionOrder,
        )
        .map((candidate) => ({
          productionOrder: candidate.link.productionOrder!.order,
          finishedProduct: candidate.link.productionOrder!.product,
          requiredDate: candidate.need,
          shortageDays: Math.max(0, workingDays(candidate.need, expected)),
          affectedQuantity: candidate.link.component?.qty ?? null,
        })),
      customer: o.customer,
      customerName: o.customerName,
      netAmount: o.netAmount == null ? null : round2(o.netAmount),
      currency: o.currency,
      customerDate,
      productionOrder: link.productionOrder?.order ?? null,
      finishedProduct: link.productionOrder?.product ?? null,
      componentRequirementDate: link.component?.date ?? null,
      productionEnd: prodEnd,
      slackDays: slack,
    },
  };
}

// ---------- make-to-stock ----------

interface Projected extends MrpElement {
  available: number;
  pos: number;
}

/** Elements in date order (clipped to the as-of day), receipts before requirements on a day, with the available quantity after each. */
export function project(
  elements: MrpElement[],
  start: number,
  asOf: string,
): Projected[] {
  const e = elements.map((x, pos) => ({
    ...x,
    date: maxDate(x.date, asOf),
    pos,
  }));
  e.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      Number(a.qty < 0) - Number(b.qty < 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      a.pos - b.pos,
  );
  let avail = start;
  return e.map((x) => {
    avail += x.qty;
    return { ...x, available: round3(avail) };
  });
}

const isOwn = (x: MrpElement, it: ImpactItem) =>
  x.category === CAT.poItem &&
  x.id === it.PurchaseOrder &&
  x.item === it.PurchaseOrderItem;

function md04Rows(
  proj: Projected[],
  affected: Set<MrpElement | Projected>,
  it: ImpactItem,
): Md04Row[] {
  const hit = proj.findIndex((x) => isOwn(x, it));
  const lo = Math.max(0, (hit < 0 ? 0 : hit) - MD04_ROWS / 2);
  const aff = new Set(
    [...affected].map((a) => `${a.category}|${a.id}|${a.item}|${a.date}`),
  );
  return proj.slice(lo, lo + MD04_ROWS).map((x) => ({
    date: x.date,
    element: x.category,
    elementText: ELEMENT_WORDS[x.category] ?? x.category,
    id: `${x.id}/${x.item}`,
    qty: round3(x.qty),
    available: x.available,
    own: isOwn(x, it),
    affected:
      aff.has(`${x.category}|${x.id}|${x.item}|${x.date}`) && x.available < 0,
  }));
}

export function makeToStock(
  pl: Planning,
  it: ImpactItem,
  expected: string,
): Outcome {
  const asOf = pl.asOf;
  const plan = it.Material
    ? pl.plan(it.Material, it.Plant)
    : { stock: 0, elements: [] };
  const requested = it.RequestedDate ?? expected;
  const line = it.ScheduleLine ?? null;
  const ownEls = plan.elements.filter(
    (x) =>
      isOwn(x, it) && (line === null || !x.line || x.line === String(line)),
  );
  const others = plan.elements.filter((x) => !ownEls.includes(x));
  const moved: MrpElement[] = ownEls.length
    ? ownEls.map((x) => ({ ...x, date: expected }))
    : [
        {
          category: CAT.poItem,
          id: it.PurchaseOrder,
          item: it.PurchaseOrderItem,
          date: expected,
          qty: Math.max(0, Number(it.OpenQuantity ?? 0)),
        },
      ];
  const stock = plan.stock;
  const proj = project([...others, ...moved], stock, asOf);
  const baseline = project(
    [...others, ...moved.map((x) => ({ ...x, date: requested }))],
    stock,
    asOf,
  );
  const baselineAvailable = new Map(
    baseline.filter((x) => x.qty < 0).map((x) => [x.pos, x.available]),
  );
  const reqs = plan.elements.filter((x) => x.qty < 0);
  let coverage: number | null = null;
  if (reqs.length) {
    const last = reqs.reduce((m, x) => maxDate(m, x.date), asOf);
    const horizon = Math.max(1, workingDays(asOf, addDays(last, 1)));
    const daily = -reqs.reduce((s, x) => s + x.qty, 0) / horizon;
    coverage = daily > 0 ? Math.round((stock / daily) * 10) / 10 : null;
  }
  const start = maxDate(requested, asOf);
  const delay = Math.max(0, days(requested, expected));
  const inWindow = proj.filter(
    (x) => x.date >= start && x.date < expected && x.qty < 0,
  );
  // Attribute only shortages introduced by moving THIS receipt, not pre-existing shortages.
  const short = inWindow.filter(
    (x) => x.available < 0 && (baselineAvailable.get(x.pos) ?? -1) >= 0,
  );
  const kind = kindOf(it.MaterialType, false);
  const base = {
    materialKind: kind,
    expectedDate: expected,
    delayDays: delay,
    stock,
    coverageDays: coverage,
    md04: md04Rows(proj, new Set(short), it),
    chain: null,
  };
  if (!short.length) {
    const rank = inWindow.length ? 3 : 4;
    return {
      ...base,
      level: LEVEL_NAMES[rank],
      rank,
      needDate: inWindow[0]?.date ?? null,
      customerDelayDays: 0,
      revenueAtRisk: 0,
      salesOrders: [],
      productionOrders: [],
      shortageFrom: null,
      shortageDays: null,
    };
  }
  const first = short[0].date;
  const cats = new Set(short.map((x) => x.category));
  const rank = cats.has(CAT.salesOrder) ? 0 : cats.has(CAT.reservation) ? 1 : 2;
  const vc = short.filter((x) => x.category === CAT.salesOrder);
  const orders = new Map<string, SalesOrderInfo>();
  for (const x of vc) {
    const so = x.salesOrder ?? x.id;
    const soi = x.salesOrderItem ?? x.item;
    const info = pl.salesOrder(so, soi);
    if (info && !orders.has(`${so}/${soi}`)) orders.set(`${so}/${soi}`, info);
  }
  const prods = [
    ...new Set(
      short
        .filter((x) => x.category === CAT.reservation && x.productionOrder)
        .map((x) => x.productionOrder!),
    ),
  ];
  const salesOrders = [...orders.values()];
  return {
    ...base,
    level: LEVEL_NAMES[rank],
    rank,
    needDate: first,
    customerDelayDays: vc.length
      ? Math.max(...vc.map((x) => days(x.date, expected)))
      : 0,
    revenueAtRisk: sumRevenue(salesOrders.map((order) => order.netAmount)),
    salesOrders,
    productionOrders: prods,
    shortageFrom: first,
    shortageDays: Math.max(0, workingDays(first, expected)),
  };
}

export function kindOf(
  materialType: string | null | undefined,
  mto: boolean,
): MaterialKind {
  if (mto) return "make_to_order";
  return KINDS[materialType ?? ""] ?? "make_to_stock";
}

// ---------- assessment ----------

export function itemImpact(
  pl: Planning,
  it: ImpactItem,
  expected: string,
): Outcome {
  const links = Array.isArray(it.mto) ? it.mto : it.mto ? [it.mto] : [];
  return links.length
    ? makeToOrder(it, links, expected, pl.asOf)
    : makeToStock(pl, it, expected);
}

/** Impact at the expected arrival, the cautious case and the scenarios over the grid. */
export function assess(pl: Planning, it: ImpactItem, a: Arrival): Impact {
  const asOf = pl.asOf;
  const conf = a.confirmation ?? null;
  const grid = a.grid && a.grid.length ? a.grid : null;
  let expected: string;
  let arrivalSource: Impact["arrivalSource"];
  if (conf) {
    expected = maxDate(conf.date.slice(0, 10), asOf);
    arrivalSource = "confirmation";
  } else if (grid) {
    expected = arrival(it.PurchaseOrderDate, grid, asOf);
    arrivalSource = "grid";
  } else {
    expected = maxDate(it.RequestedDate ?? asOf, asOf);
    arrivalSource = "requested";
  }
  const out = itemImpact(pl, it, expected);
  let cautious: Outcome | null = null;
  let scenarios: Scenario[] | null = null;
  if (!conf && grid) {
    cautious = itemImpact(
      pl,
      it,
      arrival(it.PurchaseOrderDate, grid, asOf, CAUTIOUS),
    );
    if (
      out.materialKind === "make_to_order" ||
      out.materialKind === "trading_goods"
    )
      scenarios = SCENARIO_LEVELS.map((level) => {
        const r = itemImpact(
          pl,
          it,
          arrival(it.PurchaseOrderDate, grid, asOf, level),
        );
        return {
          level,
          arrival: r.expectedDate,
          revenue: r.revenueAtRisk,
          customerDelayDays: r.customerDelayDays,
        };
      });
  }
  const note =
    arrivalSource === "requested"
      ? NO_RANGE_NOTE
      : out.materialKind === "make_to_order"
        ? MAKE_TO_ORDER_NOTE
        : NOTE;
  return {
    ...out,
    kindNote: KIND_NOTES[out.materialKind],
    cautiousDate: cautious?.expectedDate ?? null,
    revenueCautious: cautious ? cautious.revenueAtRisk : null,
    cautiousLevel: cautious?.level ?? null,
    confirmedDate: conf ? conf.date.slice(0, 10) : null,
    confirmedAfterNeed: conf
      ? !!out.needDate && conf.date.slice(0, 10) > out.needDate
      : null,
    arrivalSource,
    note,
    scenarios,
  };
}

// ---------- order, texts, totals ----------

export interface SortKey {
  rank?: number | null;
  revenueAtRisk?: number | null;
  productionOrders?: number | null;
  shortageDays?: number | null;
  delayDays?: number | null;
}

/** Severity first, then revenue, production orders affected, shortage days, delay. */
export function compareImpact(
  a: SortKey | null | undefined,
  b: SortKey | null | undefined,
): number {
  const k = (x: SortKey | null | undefined) => [
    x?.rank ?? LEVEL_NAMES.length,
    -(x?.revenueAtRisk ?? 0),
    -(x?.productionOrders ?? 0),
    -(x?.shortageDays ?? 0),
    -(x?.delayDays ?? 0),
  ];
  const ka = k(a);
  const kb = k(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

export function sumRevenue(amounts: Array<number | null>): number | null {
  let total = 0;
  for (const amount of amounts) {
    if (amount == null || !Number.isFinite(amount)) return null;
    total += amount;
  }
  const rounded = round2(total);
  return Number.isFinite(rounded) ? rounded : null;
}

/** Net value of the affected sales orders; one hit by two late items counts once. */
export function revenueTotal(
  impacts: Array<{
    salesOrders?: Array<{
      salesOrder: string;
      salesOrderItem: string;
      netAmount: number | null;
    }>;
  } | null>,
): number | null {
  const seen = new Map<string, number | null>();
  for (const i of impacts)
    for (const o of i?.salesOrders ?? [])
      seen.set(`${o.salesOrder}/${o.salesOrderItem}`, o.netAmount);
  return sumRevenue([...seen.values()]);
}

/**
 * Event title after a confirmation: arrival and impact before → after. `words`
 * gives the buyer words of a level (kernel impactText), so no copy lives here.
 */
export function changeTitle(
  po: string,
  item: string,
  date: string,
  before: { level: ImpactLevel; expectedDate: string } | null,
  after: { level: ImpactLevel; expectedDate: string },
  words: (level: ImpactLevel) => string,
): string {
  const parts = [`Confirmation for PO ${po} item ${item}: delivery on ${date}`];
  if (before && before.expectedDate !== after.expectedDate)
    parts.push(
      `expected arrival ${before.expectedDate} → ${after.expectedDate}`,
    );
  if (before && before.level !== after.level)
    parts.push(`impact ${words(before.level)} → ${words(after.level)}`);
  if (!before) parts.push(`impact ${words(after.level)}`);
  return parts.join("; ").slice(0, 300);
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}
function round3(v: number) {
  return Math.round(v * 1000) / 1000;
}
