// Overview (P-11): KPI strip, "Your day" lines and the three charts, computed
// from stored rows only. Pure functions, no CDS imports, no model call.

export type ListKey =
  | "at_risk"
  | "overdue"
  | "price"
  | "pdt"
  | "mm_pdt"
  | "freetext"
  | "duplicate"
  | "rare";

export interface FindingIn {
  ID?: string;
  list: string;
  status?: string | null;
  source?: string | null;
  sourceText?: string | null;
  Plant?: string | null;
  PurchasingGroup?: string | null;
  PurchaseOrder?: string | null;
  PurchaseOrderItem?: string | null;
  Supplier?: string | null;
  supplierDisplay?: string | null;
  PurchaseRequisition?: string | null;
  PurchaseRequisitionItem?: string | null;
  freetextDetail?: { codingText?: string | null } | null;
  expert?: string | null;
  itemTitle?: string | null;
  itemSubtitle?: string | null;
  impactText?: string | null;
  impactCriticality?: number | null;
  deliveryPriority?: "Critical" | "High" | "Medium" | "Low" | null;
  deliveryPriorityOrder?: number | null;
  revenueAtRisk?: number | null;
  dueDate?: string | null;
  nextStep?: string | null;
  trigger?: string | null;
  arrivedAt?: string | null;
}

export interface ImpactIn {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  revenueAtRisk?: number | null;
  /** JSON [{key: "SO/item", netAmount}] (or ["SO/item"]) of the affected sales order items. */
  salesOrderKeys?: string | null;
}

/** Sales order items of an impact with their amounts; null when not stored (legacy rows). */
export function salesOrderAmounts(
  i: ImpactIn,
): Array<[key: string, amount: number]> | null {
  if (!i.salesOrderKeys) return null;
  let list: unknown;
  try {
    list = JSON.parse(i.salesOrderKeys);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;
  const total = Number(i.revenueAtRisk ?? 0);
  const out: Array<[string, number]> = [];
  for (const e of list) {
    if (typeof e === "string") out.push([e, total / list.length]);
    else if (e && typeof e === "object" && (e as any).key)
      out.push([String((e as any).key), Number((e as any).netAmount ?? 0)]);
  }
  return out.length ? out : null;
}

/** Plant / purchasing group of a PO item (for the buyer scope of ItemImpact rows). */
export interface ItemScopeIn {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  Plant?: string | null;
  PurchasingGroup?: string | null;
}

export interface Scope {
  grants?: Array<{ Plant: string; PurchasingGroup: string }>;
  Plant?: string | null;
  PurchasingGroup?: string | null;
}

export interface CountRow {
  dim1: string;
  dim2: string;
  count: number;
}

export interface DayLine {
  key: string;
  text: string;
  count: number;
  amount: number | null;
  list: string;
}

/** One row of "Top priorities" / "Arrived since this morning" (buyer words only, never the raw list key). */
export interface BriefItem {
  ID: string;
  itemTitle: string;
  /** "Supplier 0001 GmbH · Plant 1010", for identifying the item without a click-through. */
  itemSubtitle: string;
  /** "Customer order at risk · 12,400 EUR" or the finding's issue when there is no impact yet. */
  impactText: string;
  listText: string;
  list: string;
  nextStep: string;
  /** Null when the finding has no due date (e.g. a material-level or free-text row). */
  dueDate: string | null;
  /** Buyer word of how the result was produced ("AI estimate", "Check", …); NS-B4. */
  sourceText: string;
  /** Collapsed trust bucket of `source`, for the coloured tag: ai | rule | history | unknown. */
  sourceTag: SourceTag;
}

/** One day's revenue at risk, for the header trend sparkline; oldest first. */
export interface TrendPoint {
  asOf: string;
  revenueAtRisk: number;
}

/** Open delivery work by operational urgency, oldest first in Overview.priorityTrend. */
export interface PriorityTrendPoint {
  day: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  total?: number;
}

export interface ChangeSummary {
  comparedDay: string;
  newCount: number;
  /** Findings no longer emitted by a detector; this is not a business-closure signal. */
  noLongerDetectedCount: number;
  escalatedCount: number;
}

export interface RevenueByPriority {
  priority: string;
  findingCount: number;
  revenueAtRisk: number;
}

export interface SupplierExposure {
  supplier: string;
  findingCount: number;
  criticalCount: number;
  revenueAtRisk: number;
  priority: string;
}

export interface OverviewKpis {
  atRisk: number;
  /** Null when no at-risk delivery has a known customer value. */
  revenueAtRisk: number | null;
  /** True when some at-risk deliveries lack a customer value. */
  revenuePartial?: boolean;
  openPurchaseRequisitions: number;
  requestsToReview: number;
  requestsAwaitingApproval: number;
  requestsCompleted: number;
  requestReviewPercent: number;
  codesPrefilled: number;
  codesTotal: number;
  codesToReview: number;
  pdtFindings: number;
  preventionFindings: number;
  pendingApprovals: number;
  currency: string;
}

export interface Overview {
  /** As-of date of the loaded dataset (YYYY-MM-DD); refreshed on every call so the header never goes stale. */
  asOf: string | null;
  /** When the current snapshot finished (ISO timestamp); null before the first run. */
  preparedAt: string | null;
  /** One or two plain-language sentences summarising the facts below; the page's headline. No model call, template only. */
  narrative: string;
  /** Revenue at risk of the last few real (non-dry-run) snapshots, oldest first; the header trend sparkline. */
  trend: TrendPoint[];
  /** Daily open findings by severity, oldest first; the Findings header trend. */
  priorityTrend: PriorityTrendPoint[];
  kpis: OverviewKpis;
  dayLines: DayLine[];
  /** Worst-first (impactCriticality, then revenue at risk), across every open list; the page's main "look here first". */
  topPriorities: BriefItem[];
  /** Findings that arrived after this morning's run (Finding.trigger = 'arrived'); empty most of the time. */
  arrivedToday: BriefItem[];
  byListSource: CountRow[];
  codesByStatus: CountRow[];
  byPlant: CountRow[];
  changeSummary: ChangeSummary | null;
  revenueByPriority: RevenueByPriority[];
  topSuppliers: SupplierExposure[];
}

/** Buyer words of each list (the first view never shows the raw keys). */
export const LIST_LABEL: Record<ListKey, string> = {
  at_risk: "Deliveries at risk",
  overdue: "Overdue items",
  price: "Price findings",
  pdt: "Planned delivery time worklist",
  mm_pdt: "Material master planned delivery time",
  freetext: "Free-text inbox",
  duplicate: "Duplicate descriptions",
  rare: "Rare combinations",
};
export const LIST_ORDER = Object.keys(LIST_LABEL) as ListKey[];

/** Buyer words of the sources (contract §2); used when a row has no sourceText. */
export const SOURCE_WORD: Record<string, string> = {
  rule: "Check",
  lookup: "Master data",
  empirical: "Past deliveries",
  tabpfn: "AI estimate",
  calculation: "Calculated",
  confirmation: "Supplier confirmation",
  fallback: "Past deliveries",
  none: "–",
};

/**
 * Collapsed trust bucket of `source` (contract §2's 8 values), for a coloured
 * tag on "Top priorities" / "Arrived" rows: how a result was produced, not
 * what list it belongs to. `ai` = a model guessed it; `rule` = deterministic,
 * no guessing; `history` = grounded in actual past or confirmed data, not a
 * live model call; `unknown` = no source yet (dry-run planning only — a real
 * Finding a buyer sees should never carry this).
 */
export type SourceTag = "ai" | "rule" | "history" | "unknown";

export const SOURCE_TAG: Record<string, SourceTag> = {
  tabpfn: "ai",
  rule: "rule",
  calculation: "rule",
  lookup: "rule",
  empirical: "history",
  fallback: "history",
  confirmation: "history",
  none: "unknown",
};

function sourceTagOf(source: string | null | undefined): SourceTag {
  return SOURCE_TAG[source ?? "none"] ?? "unknown";
}

/** Free-text proposal status (CodeProposal.status) in buyer words. */
export const CODE_STATUS_WORD: Record<string, string> = {
  prefilled: "Pre-filled",
  review: "To check",
  never_automatic: "You decide",
  no_threshold: "To check",
};

export const FIELD_WORD: Record<string, string> = {
  PurchasingGroup: "Purchasing group",
  MaterialGroup: "Material group",
  Supplier: "Supplier",
};

const NO_VALUE = "–";

export function isOpen(f: { status?: string | null }): boolean {
  return !f.status || f.status === "open";
}

export function inScope(row: Scope, scope: Scope | undefined): boolean {
  if (!scope) return true;
  if (!row.Plant || !row.PurchasingGroup) return false;
  const grants =
    scope.grants ??
    (scope.Plant && scope.PurchasingGroup
      ? [{ Plant: scope.Plant, PurchasingGroup: scope.PurchasingGroup }]
      : []);
  return grants.some(
    (grant) =>
      row.Plant === grant.Plant &&
      row.PurchasingGroup === grant.PurchasingGroup,
  );
}

export interface CodeStatus {
  key?: string;
  field: string;
  status: string;
}

/**
 * Free-text proposal statuses of one freetext Finding, read from `expert` JSON.
 * Agreed key: `proposals: [{field, value, status}]` with status of CodeProposal
 * (prefilled | review | never_automatic | no_threshold). Tolerated as well: an
 * object map `{field: {status}}`, and a single top-level `status` or
 * `prefilled: boolean`.
 */
export function codeStatuses(expert: string | null | undefined): CodeStatus[] {
  if (!expert) return [];
  try {
    const proposals = JSON.parse(expert)?.proposals;
    return Array.isArray(proposals)
      ? proposals.map((p: any) => ({
          field: String(p.field ?? ""),
          status: String(p.status ?? "review"),
        }))
      : [];
  } catch {
    return [];
  }
}

export function money(amount: number, currency = "EUR"): string {
  return `${Math.round(amount).toLocaleString("en-US")} ${currency}`;
}

function listWord(list: string): string {
  return LIST_LABEL[list as ListKey] ?? list.replace(/_/g, " ");
}

function countRows(
  m: Map<string, Map<string, number>>,
  order1?: string[],
): CountRow[] {
  const keys = [...m.keys()];
  if (order1)
    keys.sort(
      (a, b) => rank(order1, a) - rank(order1, b) || a.localeCompare(b),
    );
  else keys.sort();
  const out: CountRow[] = [];
  for (const d1 of keys) {
    const inner = m.get(d1)!;
    for (const d2 of [...inner.keys()].sort())
      out.push({ dim1: d1, dim2: d2, count: inner.get(d2)! });
  }
  return out;
}

function rank(order: string[], v: string): number {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
}

function bump(m: Map<string, Map<string, number>>, a: string, b: string) {
  let inner = m.get(a);
  if (!inner) m.set(a, (inner = new Map()));
  inner.set(b, (inner.get(b) ?? 0) + 1);
}

const itemKey = (r: {
  PurchaseOrder?: string | null;
  PurchaseOrderItem?: string | null;
}) => `${r.PurchaseOrder ?? ""}/${r.PurchaseOrderItem ?? ""}`;

export interface OverviewInput {
  findings: FindingIn[];
  impacts: ImpactIn[];
  /** Current free-text proposals; used when the durable proposal table is populated. */
  codes?: CodeStatus[];
  /** Plant / purchasing group per PO item; missing items fall back to the findings. */
  items?: ItemScopeIn[];
  pendingApprovals: number;
  scope?: Scope;
  currency?: string;
  /** As-of date of the loaded dataset (YYYY-MM-DD), null when no dataset is loaded yet. */
  asOf?: string | null;
  /** When the current snapshot finished (ISO timestamp), null before the first run. */
  preparedAt?: string | null;
  /** Revenue at risk of the last few real snapshots, oldest first; passed through unchanged. */
  trend?: TrendPoint[];
  /** Daily open findings by severity, oldest first; passed through unchanged. */
  priorityTrend?: PriorityTrendPoint[];
  /** Authoritative count of open typed purchase-requisition reviews. */
  openPurchaseRequisitions?: number;
  /** Authoritative lifecycle counts for the buyer's requisition-review queue. */
  requestsToReview?: number;
  requestsAwaitingApproval?: number;
  requestsCompleted?: number;
  changeSummary?: ChangeSummary | null;
}

/** Lists whose closed rows mean the PO item is no longer open (received). */
const ITEM_LISTS = new Set(["at_risk", "overdue"]);

export function computeOverview(input: OverviewInput): Overview {
  const currency = input.currency ?? "EUR";
  const scope = input.scope;
  const all = input.findings.filter((f) => inScope(f, scope));
  const open = all.filter(isOpen);
  const count = (list: string) => open.filter((f) => f.list === list).length;

  // PO item scope: legacy open items first, then the item lists of the findings.
  const itemScope = new Map<string, Scope>();
  for (const f of input.findings)
    if (f.PurchaseOrder && ITEM_LISTS.has(f.list))
      itemScope.set(itemKey(f), {
        Plant: f.Plant,
        PurchasingGroup: f.PurchasingGroup,
      });
  for (const i of input.items ?? [])
    itemScope.set(itemKey(i), {
      Plant: i.Plant,
      PurchasingGroup: i.PurchasingGroup,
    });

  // Match the Fulfillment Risks list exactly: both its rows and its headline
  // total come from open at-risk/overdue Findings, not all calculated impacts.
  const deliveryFindings = open.filter(
    (f) =>
      f.PurchaseOrder &&
      ITEM_LISTS.has(f.list) &&
      inScope(itemScope.get(itemKey(f)) ?? {}, scope),
  );
  const revenueItems = deliveryFindings.filter(
    (f) => Number(f.revenueAtRisk ?? 0) > 0,
  ).length;
  const unvalued = deliveryFindings.filter(
    (f) => f.revenueAtRisk == null,
  ).length;
  const revenue =
    unvalued && unvalued === deliveryFindings.length
      ? null
      : Math.round(
          deliveryFindings.reduce(
            (sum, f) => sum + Number(f.revenueAtRisk ?? 0),
            0,
          ) * 100,
        ) / 100;

  const openFreetext = open.filter((f) => f.list === "freetext");
  const openFreetextKeys = new Set(
    openFreetext.map(
      (f) =>
        `${f.PurchaseRequisition ?? ""}/${f.PurchaseRequisitionItem ?? ""}`,
    ),
  );
  const codes = input.codes?.length
    ? input.codes.filter((c) => !c.key || openFreetextKeys.has(c.key))
    : openFreetext.flatMap((f) => codeStatuses(f.expert));
  const codesPrefilled = codes.filter((c) => c.status === "prefilled").length;
  const requestsToReview = input.requestsToReview ?? openFreetext.length;
  const requestsAwaitingApproval = input.requestsAwaitingApproval ?? 0;
  const requestsCompleted = input.requestsCompleted ?? 0;
  const requestReviewTotal =
    requestsToReview + requestsAwaitingApproval + requestsCompleted;
  const kpis: OverviewKpis = {
    atRisk: count("at_risk"),
    revenueAtRisk: revenue,
    ...(revenue !== null && unvalued > 0 ? { revenuePartial: true } : {}),
    openPurchaseRequisitions:
      input.openPurchaseRequisitions ?? openFreetext.length,
    requestsToReview,
    requestsAwaitingApproval,
    requestsCompleted,
    requestReviewPercent: requestReviewTotal
      ? Math.round(
          ((requestsAwaitingApproval + requestsCompleted) /
            requestReviewTotal) *
            100,
        )
      : 0,
    codesPrefilled,
    codesTotal: codes.length,
    codesToReview: codes.length - codesPrefilled,
    pdtFindings: count("pdt") + count("mm_pdt"),
    preventionFindings:
      count("price") +
      count("duplicate") +
      count("rare") +
      count("pdt") +
      count("mm_pdt"),
    pendingApprovals: input.pendingApprovals,
    currency,
  };

  return {
    asOf: input.asOf ?? null,
    preparedAt: input.preparedAt ?? null,
    narrative: narrative(kpis),
    trend: input.trend ?? [],
    priorityTrend: (input.priorityTrend ?? []).map(withTrendTotal),
    kpis,
    dayLines: dayLines(
      kpis,
      revenueItems,
      kpis.preventionFindings,
      count("freetext"),
    ),
    topPriorities: topPriorities(open),
    arrivedToday: arrivedToday(open),
    byListSource: byListSource(open),
    codesByStatus: codesByStatus(codes),
    byPlant: byPlant(open),
    changeSummary: input.changeSummary ?? null,
    revenueByPriority: revenueByPriority(deliveryFindings),
    topSuppliers: topSuppliers(deliveryFindings),
  };
}

function withTrendTotal(point: PriorityTrendPoint): PriorityTrendPoint {
  return {
    ...point,
    total:
      Number(point.critical ?? 0) +
      Number(point.high ?? 0) +
      Number(point.medium ?? 0) +
      Number(point.low ?? 0),
  };
}

const PRIORITY_LABEL: Record<number, string> = {
  0: "Critical",
  1: "High",
  2: "Medium",
  3: "Low",
};

function priorityRank(priority: number): number {
  return Number.isFinite(priority) ? priority : 4;
}

function revenueByPriority(findings: FindingIn[]): RevenueByPriority[] {
  return [0, 1, 2, 3].map((priority) => {
    const rows = findings.filter(
      (finding) => Number(finding.deliveryPriorityOrder) === priority,
    );
    return {
      priority: PRIORITY_LABEL[priority],
      findingCount: rows.length,
      revenueAtRisk:
        Math.round(
          rows.reduce(
            (sum, finding) => sum + Number(finding.revenueAtRisk ?? 0),
            0,
          ) * 100,
        ) / 100,
    };
  });
}

function topSuppliers(findings: FindingIn[], limit = 3): SupplierExposure[] {
  const suppliers = new Map<string, SupplierExposure>();
  for (const finding of findings) {
    const supplier = finding.supplierDisplay || finding.Supplier;
    if (!supplier) continue;
    const key = finding.Supplier || supplier;
    const current = suppliers.get(key) ?? {
      supplier,
      findingCount: 0,
      criticalCount: 0,
      revenueAtRisk: 0,
      priority: "None",
    };
    current.findingCount += 1;
    current.criticalCount +=
      Number(finding.deliveryPriorityOrder) === 0 ? 1 : 0;
    current.revenueAtRisk += Number(finding.revenueAtRisk ?? 0);
    const priority = Number(finding.deliveryPriorityOrder);
    const currentPriority = Number(
      Object.keys(PRIORITY_LABEL).find(
        (key) => PRIORITY_LABEL[Number(key)] === current.priority,
      ) ?? 4,
    );
    if (priorityRank(priority) < priorityRank(currentPriority))
      current.priority = PRIORITY_LABEL[priority];
    suppliers.set(key, current);
  }
  return [...suppliers.values()]
    .map((supplier) => ({
      ...supplier,
      revenueAtRisk: Math.round(supplier.revenueAtRisk * 100) / 100,
    }))
    .sort(
      (left, right) =>
        right.revenueAtRisk - left.revenueAtRisk ||
        right.criticalCount - left.criticalCount ||
        left.supplier.localeCompare(right.supplier),
    )
    .slice(0, limit);
}

/**
 * Plain-language summary of the KPIs (the page's headline sentence). Built
 * from the same computed facts, by template — no model call, so it is
 * available immediately and never inconsistent with the tiles below it.
 * A quiet day still gets one reassuring sentence rather than an empty panel.
 */
export function narrative(k: OverviewKpis): string {
  const sentences: string[] = [];
  const revenue = k.revenueAtRisk ?? 0;
  if (k.atRisk > 0 || revenue > 0) {
    const parts = [
      `${k.atRisk} ${k.atRisk === 1 ? "delivery" : "deliveries"} at risk of arriving late`,
    ];
    if (revenue > 0)
      parts.push(
        `exposing ${k.revenuePartial ? "at least " : ""}${money(revenue, k.currency)} in customer revenue`,
      );
    else if (k.atRisk > 0 && k.revenueAtRisk === null)
      parts.push("customer revenue exposure unavailable");
    sentences.push(`${parts.join(", ")}.`);
  } else {
    sentences.push("No deliveries are currently at risk.");
  }
  const pending: string[] = [];
  if (k.pendingApprovals > 0)
    pending.push(
      `${k.pendingApprovals} action${k.pendingApprovals === 1 ? "" : "s"} awaiting your decision`,
    );
  // pdtFindings is not added here: every open pdt/mm_pdt finding now has an
  // prepared Action, so it is already counted inside pendingApprovals — repeating it here
  // would double-count the same items.
  if (k.codesToReview > 0)
    pending.push(
      `${k.codesToReview} free-text request${k.codesToReview === 1 ? "" : "s"} to code`,
    );
  if (pending.length) sentences.push(`${capitalize(joinList(pending))}.`);
  return sentences.join(" ");
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]}, and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The "Your day" lines (P-11); a line with nothing to do is left out. */
export function dayLines(
  k: OverviewKpis,
  revenueItems: number,
  prevention: number,
  freetext: number,
): DayLine[] {
  const lines: DayLine[] = [];
  if (k.revenueAtRisk !== null && k.revenueAtRisk > 0)
    lines.push({
      key: "revenue",
      text: `Revenue at risk · ${k.revenuePartial ? "at least " : ""}${money(k.revenueAtRisk, k.currency)}`,
      count: revenueItems,
      amount: k.revenueAtRisk,
      list: "at_risk",
    });
  const rows: Array<[string, string, number, string]> = [
    ["at_risk", "Deliveries that may be late", k.atRisk, "at_risk"],
    ["prevention", "Prevention findings to review", prevention, "prevention"],
    ["freetext", "Free-text requests to code", freetext, "freetext"],
  ];
  for (const [key, label, n, list] of rows)
    if (n > 0)
      lines.push({ key, text: `${label}: ${n}`, count: n, amount: null, list });
  return lines;
}

export function byListSource(open: FindingIn[]): CountRow[] {
  const m = new Map<string, Map<string, number>>();
  for (const f of open)
    bump(
      m,
      listWord(f.list),
      f.sourceText || SOURCE_WORD[f.source ?? "none"] || NO_VALUE,
    );
  return countRows(
    m,
    LIST_ORDER.map((l) => LIST_LABEL[l]),
  );
}

export function codesByStatus(codes: CodeStatus[]): CountRow[] {
  const m = new Map<string, Map<string, number>>();
  for (const c of codes)
    bump(
      m,
      FIELD_WORD[c.field] ?? (c.field || NO_VALUE),
      CODE_STATUS_WORD[c.status] ?? "To check",
    );
  return countRows(m, Object.values(FIELD_WORD));
}

export function byPlant(open: FindingIn[]): CountRow[] {
  const m = new Map<string, Map<string, number>>();
  for (const f of open)
    if (f.list !== "freetext") bump(m, f.Plant || NO_VALUE, listWord(f.list));
  return countRows(m);
}

/** 1 (red) worst .. 3 (green) best; 0/null (neutral, no impact computed) sorts after every real level. */
function criticalityRank(c: number | null | undefined): number {
  return c ? c : 4;
}

function briefItem(f: FindingIn): BriefItem {
  return {
    ID: String(f.ID ?? ""),
    itemTitle: f.itemTitle || f.ID || "",
    itemSubtitle: f.itemSubtitle || "",
    impactText: f.impactText || "",
    listText: listWord(f.list),
    list: f.list,
    nextStep: f.nextStep || "",
    dueDate: f.dueDate || null,
    sourceText: f.sourceText || SOURCE_WORD[f.source ?? "none"] || NO_VALUE,
    sourceTag: sourceTagOf(f.source),
  };
}

/**
 * Worst-first across every open list (P-11+): impact severity first (red
 * before yellow before green before neutral), then revenue at risk, so the
 * single highest-value thing to look at surfaces regardless of which list
 * it lives in. Findings without an ID (legacy/fixture rows) are skipped —
 * there is nowhere to navigate them to.
 */
export function topPriorities(open: FindingIn[], limit = 5): BriefItem[] {
  return open
    .filter((f) => f.ID && f.list !== "freetext")
    .slice()
    .sort((a, b) => {
      const c =
        criticalityRank(a.impactCriticality) -
        criticalityRank(b.impactCriticality);
      if (c) return c;
      return Number(b.revenueAtRisk ?? 0) - Number(a.revenueAtRisk ?? 0);
    })
    .slice(0, limit)
    .map(briefItem);
}

/** Findings whose `trigger` is 'arrived' (checked as they came in today, not in this morning's run). */
export function arrivedToday(open: FindingIn[], limit = 10): BriefItem[] {
  return open
    .filter((f) => f.ID && f.trigger === "arrived")
    .slice()
    .sort((a, b) => (b.arrivedAt ?? "").localeCompare(a.arrivedAt ?? ""))
    .slice(0, limit)
    .map(briefItem);
}
