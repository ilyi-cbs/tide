// Feature "overview" (T8a, P-11): overview() — KPI strip, "Your day" lines and
// the three charts, from stored rows only (Findings, ItemImpacts, Actions).
// Never a model call. Buyer scope: req.user attributes PurchasingGroup / Plant
// when present (set by the guard feature); only admins have global scope.
import cds from "@sap/cds";
import type { Step, StepContext } from "../kernel/types";
import { asOfDate } from "../kernel/asof";
import { isAdmin, scopeOf } from "../kernel/auth";
import {
  computeOverview,
  inScope,
  type PriorityTrendPoint,
  type Scope,
  type TrendPoint,
} from "./domain/logic";
import { approvalVisible } from "../kernel/actions";
import { inTx, type Row } from "../kernel/model-calls";
import { exposureRevenue, PREPARATION_POLICY, sourceIdentity } from "../kernel/publication";
import { addDays } from "../kernel/calendar";
import { fail } from "../kernel/errors";

const { SELECT } = cds.ql;
const NS = "tide.cockpit";
/** Brief trends cover seven calendar days; absent runs remain gaps. */
const TREND_DAYS = 7;

export const step: Step = {
  name: "overview",
  async run(_ctx: StepContext) {
  },
};

function priorityRank(priority: number): number {
  return priority;
}

/**
 * Buyer scope from the user's role/attributes; undefined = sees everything
 * (overview/domain/logic.ts's inScope() treats it that way). Named distinctly
 * from guard/domain/logic.ts's scopeOf (same name existed in both files,
 * different Scope shape — this one has no isAdmin field, so the admin check
 * must be explicit here rather than falling out of "no PurchasingGroup/Plant
 * set", which a non-admin buyer with unconfigured attrs would also produce).
 */
export function overviewScope(user: cds.User | undefined): Scope | undefined {
  const scope = scopeOf(user ?? {});
  return scope.isAdmin ? undefined : scope;
}

export async function overview(scope?: Scope, routedBuyer?: string) {
  return inTx(() => readOverview(scope, routedBuyer));
}

async function readOverview(scope?: Scope, routedBuyer?: string) {
  const findings = await (SELECT.from(`${NS}.Finding`) as any).columns(
    "ID",
    "list",
    "status",
    "source",
    "sourceText",
    "Supplier",
    "supplierDisplay",
    "Plant",
    "PurchasingGroup",
    "PurchaseOrder",
    "PurchaseOrderItem",
    "PurchaseRequisition",
    "PurchaseRequisitionItem",
    "expert",
    "itemTitle",
    "itemSubtitle",
    "impactText",
    "deliveryPriority",
    "deliveryPriorityOrder",
    "revenueAtRisk",
    "dueDate",
    "nextStep",
    "trigger",
    "arrivedAt",
  );
  const headers: any[] = await SELECT.from(`${NS}.Cases`);
  const byCase = new Map(headers.map((row) => [row.ID, row]));
  const visibleFindings = findings.filter((row: any) => {
    const ID = ["at_risk", "overdue"].includes(row.list)
      ? `delivery:${row.PurchaseOrder}/${row.PurchaseOrderItem}`
      : row.ID;
    const header = byCase.get(ID);
    return !header || (header.status === "open" && header.listing === "listed");
  });
  const represented = new Set(
    visibleFindings.map((row: any) =>
      ["at_risk", "overdue"].includes(row.list)
        ? `delivery:${row.PurchaseOrder}/${row.PurchaseOrderItem}`
        : row.ID,
    ),
  );
  const lists: Record<string, string> = {
    price: "price",
    duplicate: "duplicate",
    unusual_setting: "rare",
    supplier_planned_time: "pdt",
    material_planned_time: "mm_pdt",
  };
  const typedEntities: Record<string, string> = {
    delivery: "DeliveryRisks",
    price: "PriceDeviations",
    duplicate: "DuplicateMaterials",
    unusual_setting: "UnusualSettings",
    supplier_planned_time: "SupplierPlannedTimes",
    material_planned_time: "MaterialPlannedTimes",
  };
  for (const header of headers.filter(
    (h) =>
      h.status === "open" &&
      h.listing === "listed" &&
      !represented.has(h.ID) &&
      typedEntities[h.kind],
  )) {
    const detail = await SELECT.one
      .from(`${NS}.${typedEntities[header.kind]}`)
      .where({ header_ID: header.ID });
    if (!detail) continue;
    visibleFindings.push({
      ...detail,
      ID: header.ID,
      list: header.kind === "delivery" ? detail.phase : lists[header.kind],
      status: "open",
      itemTitle: header.title,
      Plant: header.Plant,
      PurchasingGroup: header.PurchasingGroup,
      deliveryPriorityOrder: header.priority,
      revenueAtRisk: detail.revenueAtRisk ?? null,
      source: detail.source ?? "rule",
      dueDate: header.dueDate,
    });
  }
  const impacts = await SELECT.from(`${NS}.ItemImpact`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "revenueAtRisk",
    "salesOrderKeys",
  ).where`revenueAtRisk > 0`;
  const codeRows = await SELECT.from(`${NS}.FreetextProposal`).columns(
    "PurchaseRequisition",
    "PurchaseRequisitionItem",
    "field",
    "status",
  );
  const items = scope
    ? await SELECT.from(`${NS}.OpenItem`).columns(
        "PurchaseOrder",
        "PurchaseOrderItem",
        "Plant",
        "PurchasingGroup",
      )
    : [];
  const pendingRows: Array<{ ID: string }> = await SELECT.from(`${NS}.Actions`)
    .columns("ID")
    .where({ status: "needs_decision" });
  let pendingApprovals = pendingRows.length;
  const caller = cds.context?.user;
  if (caller) {
    pendingApprovals = 0;
    for (const row of pendingRows)
      if (await approvalVisible(row.ID, caller)) pendingApprovals++;
  }
  // The Requests route is backed by FreetextReview. Count that durable workflow
  // root instead of the compatibility projection so the landing header and list
  // cannot drift apart between source synchronizations.
  const requisitionReviewQuery = SELECT.from(`${NS}.FreetextReview`)
    .columns("lifecycleStatus", "count(1) as n")
    .groupBy("lifecycleStatus");
  if (scope) {
    const grants = scope.grants ?? (scope.Plant && scope.PurchasingGroup
      ? [{ Plant: scope.Plant, PurchasingGroup: scope.PurchasingGroup }] : []);
    requisitionReviewQuery.where({ xpr: grants.length ? grants.flatMap((grant, index) => [
      ...(index ? ["or"] : []),
      { xpr: [{ ref: ["Plant"] }, "=", { val: grant.Plant }, "and",
        { ref: ["routedGroup"] }, "=", { val: grant.PurchasingGroup }] },
    ]) : [{ val: 1 }, "=", { val: 0 }] });
  }
  if (routedBuyer)
    requisitionReviewQuery.where({ routedBuyer });
  const requisitionReviewRows = await requisitionReviewQuery;
  const reviewCounts = new Map<string, number>(
    requisitionReviewRows.map((row: any): [string, number] => [
      String(row.lifecycleStatus),
      Number(row.n) || 0,
    ]),
  );
  const legacyOpenRequests = new Set(
    findings
      .filter((f: any) => f.list === "freetext" && f.status === "open")
      .map((f: any) => `${f.PurchaseRequisition}/${f.PurchaseRequisitionItem}`),
  ).size;
  const requestsToReview =
    (reviewCounts.get("needs_review") ?? 0) +
    (reviewCounts.get("source_changed") ?? 0);
  const requestsAwaitingApproval =
    (reviewCounts.get("awaiting_approval") ?? 0) +
    (reviewCounts.get("approved") ?? 0) +
    (reviewCounts.get("awaiting_source_confirmation") ?? 0);
  const requestsCompleted =
    (reviewCounts.get("completed") ?? 0) + (reviewCounts.get("cancelled") ?? 0);
  const asOf = await asOfDate();
  const pointer = await SELECT.one.from(`${NS}.PublishedCockpit`).where({ ID: "current" });
  const snap = pointer?.snapshot_ID ? await SELECT.one.from(`${NS}.Snapshot`).where({ ID: pointer.snapshot_ID, status: "done" }) : null;
  const history = await readPublishedHistory(asOf, scope);
  const result = computeOverview({
    findings: visibleFindings,
    impacts,
    codes: codeRows.map((row: any) => ({
      key: `${row.PurchaseRequisition}/${row.PurchaseRequisitionItem}`,
      field: String(row.field ?? ""),
      status: String(row.status ?? "review"),
    })),
    items,
    pendingApprovals,
    // Fixtures and older snapshots may only contain Findings. Use their open
    // free-text rows as a compatibility fallback until the typed aggregate is
    // populated; live prepared data uses the authoritative aggregate count.
    openPurchaseRequisitions:
      requestsToReview + requestsAwaitingApproval || legacyOpenRequests,
    requestsToReview: requestsToReview || legacyOpenRequests,
    requestsAwaitingApproval,
    requestsCompleted,
    scope,
    currency: "EUR",
    asOf,
    preparedAt: snap?.finishedAt ?? null,
    trend: history.trend,
    priorityTrend: history.priorityTrend,
    changeSummary: history.changeSummary,
  });
  return { ...result, publication: {
    snapshotID: snap?.ID ?? null,
    asOf: snap?.asOf ?? null,
    publishedAt: snap?.publishedAt ?? null,
    source: snap?.observationType ?? "untrusted",
    completeness: snap?.completeness ?? "unprepared",
    liveWorkflow: true,
    windowDays: TREND_DAYS,
    coveredDays: history.priorityTrend.length,
  } };
}

/** Compatibility entry point; runtime arrival fabrication is retired. */
export async function seedDemoArrivals() {
  return;
}

/** Completed-run history, scoped before aggregation and demand deduplication. */
async function readPublishedHistory(
  asOf: string | null,
  scope?: Scope,
  windowDays = TREND_DAYS,
) {
  const empty = { priorityTrend: [] as PriorityTrendPoint[], trend: [] as TrendPoint[], changeSummary: null as null | { comparedDay: string; newCount: number; noLongerDetectedCount: number; escalatedCount: number } };
  if (!asOf) return empty;
  const source = await sourceIdentity();
  const type = source.source === "extract" ? "operational" : source.source === "synthetic" ? "synthetic" : null;
  if (!type) return empty;
  const cutoff = addDays(asOf, -(windowDays - 1));
  const snapshots: Row[] = await SELECT.from(`${NS}.Snapshot`)
    .where`status = 'done' and publishedAt is not null and policyVersion = ${PREPARATION_POLICY} and observationType = ${type} and asOf >= ${cutoff} and asOf <= ${asOf}`
    .where({ datasetName: source.name })
    .orderBy("publishedAt desc", "ID desc");
  const days = new Map<string, Row>();
  for (const snapshot of snapshots) if (!days.has(snapshot.asOf)) days.set(snapshot.asOf, snapshot);
  const ordered = [...days.values()].sort((left, right) => left.asOf.localeCompare(right.asOf));
  if (!ordered.length) return empty;
  const ids = ordered.map((snapshot) => snapshot.ID);
  const observations: Row[] = await SELECT.from(`${NS}.CaseObservation`).where({ snapshot_ID: { in: ids }, kind: "delivery", status: "open", listing: "listed" });
  const exposures: Row[] = await SELECT.from(`${NS}.ExposureObservation`).where({ snapshot_ID: { in: ids } });
  const visible = observations.filter((row) => inScope(row, scope));
  const problems = (ID: string) => new Map(visible.filter((row) => row.snapshot_ID === ID).map((row) => [row.caseID, Number(row.priority)]));
  const priorityTrend = ordered.map((snapshot) => {
    const rows = [...problems(snapshot.ID).values()];
    return withTrendTotal({ day: snapshot.asOf, critical: rows.filter((priority) => priority === 0).length, high: rows.filter((priority) => priority === 1).length, medium: rows.filter((priority) => priority === 2).length, low: rows.filter((priority) => priority === 3).length });
  });
  const trend = ordered.map((snapshot) => ({ asOf: snapshot.asOf, revenueAtRisk: Math.round(exposureRevenue(exposures.filter((row) => row.snapshot_ID === snapshot.ID && inScope(row, scope))) * 100) / 100 }));
  const current = ordered.at(-1)!;
  const previous = ordered.at(-2);
  const before = previous ? problems(previous.ID) : null;
  const after = problems(current.ID);
  const changeSummary = before && previous ? {
    comparedDay: previous.asOf,
    newCount: [...after.keys()].filter((ID) => !before.has(ID)).length,
    noLongerDetectedCount: [...before.keys()].filter((ID) => !after.has(ID)).length,
    escalatedCount: [...after.entries()].filter(([ID, priority]) => before.has(ID) && priorityRank(priority) < priorityRank(before.get(ID)!)).length,
  } : null;
  return { priorityTrend, trend, changeSummary };
}

/** Compatibility entry point; fabricated priority history is retired. */
export async function seedDemoPriorityHistory(_enabled = false) {
  return;
}

/** Compatibility entry point; fabricated revenue history is retired. */
export async function seedDemoRevenueTrend(_enabled = false) {
  return;
}

function withTrendTotal(point: PriorityTrendPoint): PriorityTrendPoint {
  return {
    ...point,
    total:
      Number(point.critical) +
      Number(point.high) +
      Number(point.medium) +
      Number(point.low),
  };
}

export function register(srv: cds.Service) {
  srv.on("publicationHistory", (req: cds.Request) => inTx(async () => {
    const windowDays = Number(req.data.windowDays);
    if (windowDays !== 7 && windowDays !== 30) throw fail(400, "Choose a 7 or 30 calendar-day history window");
    const source = await sourceIdentity();
    const history = await readPublishedHistory(source.asOf, overviewScope(req.user), windowDays);
    return { ...history, windowDays, coveredDays: history.priorityTrend.length, source: source.source === "extract" ? "operational" : source.source === "synthetic" ? "synthetic" : "untrusted" };
  }));
  srv.on("overview", (req: cds.Request) =>
    overview(
      overviewScope(req.user),
      isAdmin(req.user) ? undefined : req.user.id,
    ),
  );
}
