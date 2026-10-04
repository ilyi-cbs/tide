// Cockpit chat tools of CockpitMcpService (declared in ./mcp.cds). Every
// result reaches the model only as modelView(result) (./chat-view.ts).
import cds from "@sap/cds";
import { modelWork } from "./kernel/model-calls";
import { withWorkflowOrigin } from "./kernel/commands";
import { impactRank, impactText, sourceText } from "./kernel/case-text";
import { caseHash } from "./kernel/case-links";
import { approvalVisible } from "./kernel/actions";
import { CASE_ENTITIES } from "./kernel/case-preparation";
import { asOfDate } from "./kernel/asof";
import { fail } from "./kernel/errors";
import { NS, type Row } from "./kernel/model-calls";
import { FINDING_LISTS, type FindingList } from "./kernel/types";
import { predictOrders } from "./predict-orders";
import { modelView } from "./chat-view";
import {
  LIST_MEANING,
  LIST_TEXT,
  MAX_ROWS,
  buyerScope,
  customersOf,
  links,
  mmSources,
  plainWords,
  publicAction,
} from "./chat-rows";
import { scopeOf, inScope } from "./kernel/auth";
import { reviewRequisitionOrder } from "./freetext/review";

const { SELECT } = cds.ql;
const navigation = { caseHash };
type Req = cds.Request;

export const PRIORITY_ORDER =
  "impact severity, revenue at risk, production orders affected, shortage days, delay days";
export const PRIORITY_NOTE =
  "Source: calculated from the stock and requirements list";
export const NOTHING_WRITTEN =
  "Nothing is sent to suppliers and nothing is written to SAP; a person decides in Approvals.";

function str(req: Req, name: string, required = false): string | null {
  const v = req.data[name];
  if (v === undefined || v === null || v === "") {
    if (required) throw fail(400, `${name} is required`);
    return null;
  }
  if (typeof v !== "string" || !v.trim())
    throw fail(400, `${name} must be a nonempty string`);
  return v.trim();
}

/** Findings of the scope: named plant / group win; without both the buyer's scope applies. */
async function scopedWhere(req: Req): Promise<Row> {
  const plant = str(req, "plant");
  const group = str(req, "purchasingGroup");
  const supplier = str(req, "supplier");
  const scope = scopeOf(req.user);
  const grants = scope.grants ?? [];
  const matching = grants.filter(
    (grant) =>
      (!plant || grant.Plant === plant) &&
      (!group || grant.PurchasingGroup === group),
  );
  if (!scope.isAdmin && !matching.length)
    throw fail(403, "The requested scope is outside your purchasing scope");
  const where: Row = { status: "open" };
  if (scope.isAdmin) {
    if (plant) where.Plant = plant;
    if (group) where.PurchasingGroup = group;
  } else {
    where.ID = {
      in: SELECT.from(`${NS}.Finding`)
        .columns("ID")
        .where({
          xpr: matching.flatMap((grant, index) => [
            ...(index ? ["or"] : []),
            {
              xpr: [
                { ref: ["Plant"] },
                "=",
                { val: grant.Plant },
                "and",
                { ref: ["PurchasingGroup"] },
                "=",
                { val: grant.PurchasingGroup },
              ],
            },
          ]),
        }),
    };
  }
  if (supplier) where.Supplier = supplier;
  return where;
}

/** `list` is a CQN token name: object-style where({list}) misparses, so use the xpr form. */
function listXpr(list: string) {
  return [{ ref: ["list"] }, "=", { val: list }];
}

async function findings(where: Row, list?: string): Promise<Row[]> {
  const query = SELECT.from(`${NS}.Finding`).where(where).orderBy("rank", "ID");
  if (list) query.where(listXpr(list) as any);
  return query;
}

/** Calls a §6 operation of PurchasingDeskService as the caller; its 4xx/501 errors pass through unchanged. */
async function cockpit(req: Req, event: string, data: Row): Promise<any> {
  const srv = await cds.connect.to(
    event === "overview" ? "PublicationService" : "PurchasingDeskService",
  );
  try {
    return await srv.tx(req).send(event, data);
  } catch (e: any) {
    const status = Number(e?.status ?? e?.statusCode ?? e?.code);
    if (e?.notImplemented || status === 501)
      throw fail(501, notAvailable(event), {
        notAvailable: true,
        notAvailableMessage: notAvailable(event),
      });
    if (Number.isInteger(status) && status >= 400 && status < 500)
      throw fail(status, e.message);
    throw e;
  }
}

/** Tool error of a §6 operation whose owner has not landed yet (501). */
export const notAvailable = (op: string) =>
  `${op} is not available yet in this cockpit (not implemented yet)`;

// ------------------------------------------------------------------ tools

const CASE_ENTITY = CASE_ENTITIES;

function inAssistantContextScope(
  scope: {
    Plant: string | null;
    PurchasingGroup: string | null;
    isAdmin: boolean;
    grants?: Array<{ Plant: string; PurchasingGroup: string }>;
  },
  row: Row,
): boolean {
  return inScope(scope, row);
}

function caseLink(caseID: string, kind: string) {
  return navigation.caseHash(caseID, kind) || null;
}

const PAGE_PROFILES: Record<string, { profile: string; instructions: string }> =
  {
    "cockpit.overview": {
      profile: "overview",
      instructions:
        "The buyer is viewing the cockpit overview. Use current authorized tools to summarize priorities; distinguish checked data from recommendations.",
    },
    "cockpit.delivery-risk-list": {
      profile: "delivery-risk-list",
      instructions:
        "The buyer is viewing delivery risks. Use list_priorities or list_cases before explaining individual risks.",
    },
    "cockpit.delivery-risk-detail": {
      profile: "delivery-risk-detail",
      instructions:
        "The buyer is viewing a delivery-risk case. Read the current authorized case before explaining its evidence or recommending action.",
    },
    "cockpit.open-item": {
      profile: "open-item",
      instructions:
        "The buyer is viewing a purchase-order item. Verify its current details and any customer impact through authorized tools before answering.",
    },
    "cockpit.prevention-list": {
      profile: "prevention-list",
      instructions:
        "The buyer is viewing prevention cases. Use current authorized case data and explain evidence separately from recommendations.",
    },
    "cockpit.prevention-case": {
      profile: "prevention-case",
      instructions:
        "The buyer is reviewing a prevention case. Read the current authorized case before explaining its evidence or recommendation.",
    },
    "cockpit.customer-detail": {
      profile: "customer-detail",
      instructions:
        "The buyer is viewing a customer-impact detail. Use authorized purchasing data and do not infer causality from correlations.",
    },
    "cockpit.approvals": {
      profile: "approvals",
      instructions:
        "The buyer is viewing pending approvals. Summarize pending decisions; never approve or send anything.",
    },
    "cockpit.requests": {
      profile: "requests",
      instructions:
        "The buyer is reviewing purchasing requests. Verify the current request before recommending a next step.",
    },
    "cockpit.planning": {
      profile: "planning",
      instructions:
        "The buyer is viewing planning data. Verify current data with authorized tools and label predictions as estimates.",
    },
    "cockpit.proof": {
      profile: "proof",
      instructions:
        "The buyer is viewing proof results. Explain only what the returned checks establish.",
    },
    "cockpit.help": {
      profile: "help",
      instructions:
        "The buyer is viewing workflow help. Explain the cockpit workflow using the available app tools and instructions.",
    },
  };

export async function resolveAssistantContext(req: Req) {
  if (str(req, "app", true) !== "cockpit") return { valid: false };
  let context: Row;
  try {
    const serialized = str(req, "context", true)!;
    if (serialized.length > 4096) return { valid: false };
    context = JSON.parse(serialized) as Row;
  } catch {
    return { valid: false };
  }
  if (!context || typeof context !== "object" || Array.isArray(context))
    return { valid: false };
  if (
    Object.keys(context).some(
      (key) =>
        ![
          "version",
          "app",
          "surface",
          "entity",
          "selection",
          "filters",
          "title",
        ].includes(key),
    )
  )
    return { valid: false };
  const surface = typeof context.surface === "string" ? context.surface : "";
  const page = PAGE_PROFILES[surface];
  if (context.version !== 1 || context.app !== "cockpit" || !page)
    return { valid: false };
  if (
    context.selection &&
    (typeof context.selection !== "object" ||
      Array.isArray(context.selection) ||
      Object.keys(context.selection).some((key) => key !== "itemIds") ||
      !Array.isArray(context.selection.itemIds) ||
      context.selection.itemIds.length > 20 ||
      context.selection.itemIds.some(
        (id: unknown) => typeof id !== "string" || !id || id.length > 32,
      ))
  )
    return { valid: false };
  if (
    context.filters &&
    (typeof context.filters !== "object" ||
      Array.isArray(context.filters) ||
      Object.keys(context.filters).some(
        (key) => !["plant", "purchasingGroup", "supplier"].includes(key),
      ))
  )
    return { valid: false };
  const canonical: Row = { surface, profile: page.profile };
  const filters =
    context.filters && typeof context.filters === "object"
      ? (context.filters as Row)
      : {};
  const buyerScopeForContext = {
    ...(await buyerScope(req.user)),
    isAdmin: scopeOf(req.user).isAdmin,
  };
  if (
    typeof filters.plant === "string" &&
    filters.plant.length <= 4 &&
    (!buyerScopeForContext.Plant ||
      filters.plant === buyerScopeForContext.Plant)
  )
    canonical.plant = filters.plant;
  else if (buyerScopeForContext.Plant)
    canonical.plant = buyerScopeForContext.Plant;
  if (
    typeof filters.purchasingGroup === "string" &&
    filters.purchasingGroup.length <= 3 &&
    (!buyerScopeForContext.PurchasingGroup ||
      filters.purchasingGroup === buyerScopeForContext.PurchasingGroup)
  )
    canonical.purchasingGroup = filters.purchasingGroup;
  else if (buyerScopeForContext.PurchasingGroup)
    canonical.purchasingGroup = buyerScopeForContext.PurchasingGroup;
  const entity = context.entity;
  if (entity && typeof entity === "object" && typeof entity.id === "string") {
    if (Object.keys(entity).some((key) => !["kind", "id"].includes(key)))
      return { valid: false };
    const id = entity.id;
    if (!id || id.length > 160) return { valid: false };
    if (entity.kind === "case") {
      try {
        const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: id });
        if (row && inAssistantContextScope(buyerScopeForContext, row))
          canonical.entity = { kind: "case", id: row.ID, title: row.title };
      } catch {
        // Do not reveal whether an entity exists outside this caller's scope.
      }
    } else if (entity.kind === "finding") {
      try {
        const row = await SELECT.one.from(`${NS}.Finding`).where({ ID: id });
        if (row && inAssistantContextScope(buyerScopeForContext, row))
          canonical.entity = { kind: "finding", id: row.ID };
      } catch {
        // Treat missing and inaccessible context identically.
      }
    } else if (
      entity.kind === "purchase-order-item" &&
      /^[^/]{1,10}\/[^/]{1,5}$/.test(id)
    ) {
      const [PurchaseOrder, PurchaseOrderItem] = id.split("/");
      const row = await SELECT.one
        .from(`${NS}.ItemFact`)
        .columns(
          "PurchaseOrder",
          "PurchaseOrderItem",
          "Plant",
          "PurchasingGroup",
        )
        .where({ PurchaseOrder, PurchaseOrderItem });
      if (row && inAssistantContextScope(buyerScopeForContext, row))
        canonical.entity = { kind: "purchase-order-item", id };
    } else if (entity.kind === "customer" && /^[A-Za-z0-9_-]{1,10}$/.test(id)) {
      const impacts: Row[] = await SELECT.from(`${NS}.CustomerImpact`)
        .columns("PurchaseOrder", "PurchaseOrderItem")
        .where({ Customer: id });
      for (const impact of impacts) {
        const item = await SELECT.one
          .from(`${NS}.ItemFact`)
          .columns("Plant", "PurchasingGroup")
          .where({
            PurchaseOrder: impact.PurchaseOrder,
            PurchaseOrderItem: impact.PurchaseOrderItem,
          });
        if (item && inAssistantContextScope(buyerScopeForContext, item)) {
          canonical.entity = { kind: "customer", id };
          break;
        }
      }
    }
  }
  const payload = {
    valid: true,
    profile: page.profile,
    canonicalContext: JSON.stringify(canonical),
    instructions: page.instructions,
    // Omit allowedTools for v1 profiles. The current app-level profile remains
    // authoritative and browser context never expands or narrows its catalog.
  };
  return payload;
}

async function visibleCase(req: Req, caseID: string): Promise<Row> {
  const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  if (!row) throw fail(404, `No case ${caseID}`);
  const scope = await buyerScope(req.user);
  if (
    (scope.Plant && row.Plant && row.Plant !== scope.Plant) ||
    (scope.PurchasingGroup &&
      row.PurchasingGroup &&
      row.PurchasingGroup !== scope.PurchasingGroup)
  )
    throw fail(404, `No case ${caseID}`);
  return row;
}

async function linkedActions(caseID: string, user: cds.User): Promise<Row[]> {
  const links: Array<{ action_ID: string }> = await SELECT.from(
    `${NS}.CaseActions`,
  )
    .columns("action_ID")
    .where({ header_ID: caseID });
  if (!links.length) return [];
  const actions: Row[] = await SELECT.from(`${NS}.Actions`)
    .where({ ID: { in: links.map((link) => link.action_ID) } })
    .orderBy("createdAt desc");
  const visible = [];
  for (const action of actions)
    if (await approvalVisible(action.ID, user))
      visible.push(publicAction({ ...action, caseID }));
  return visible;
}

async function getCaseTool(req: Req) {
  const caseID = str(req, "caseID", true)!;
  const caseRow = await visibleCase(req, caseID);
  const entity = CASE_ENTITY[caseRow.kind];
  if (!entity)
    throw fail(
      501,
      `Case kind ${caseRow.kind} is not available through get_case yet`,
    );
  const detail = await SELECT.one
    .from(`${NS}.${entity}`)
    .where({ header_ID: caseID });
  if (!detail) throw fail(404, `No typed detail for case ${caseID}`);
  return {
    caseID,
    kind: caseRow.kind,
    status: caseRow.status,
    listing: caseRow.listing,
    attention: caseRow.attention,
    sourceRevision: caseRow.sourceRevision,
    modifiedAt: caseRow.modifiedAt,
    sourceFingerprint: caseRow.sourceFingerprint,
    sourceChanged: caseRow.sourceChanged,
    evidence: JSON.stringify(detail),
    link: caseLink(caseID, caseRow.kind),
    closure: caseRow.closure,
    typedEntitySet: entity,
    typedKey: caseID,
    phase: detail.phase ?? null,
    PurchaseOrder: detail.PurchaseOrder,
    PurchaseOrderItem: detail.PurchaseOrderItem,
    Material: detail.Material,
    Supplier: detail.Supplier,
    Plant: detail.Plant,
    PurchasingGroup: detail.PurchasingGroup,
    dueDate: detail.dueDate,
    predictedArrival: detail.predictedArrival,
    revenueAtRisk: detail.revenueAtRisk,
    nextActionKind: detail.nextActionKind,
    ...(await caseReasons(caseRow)),
    actions: await linkedActions(caseID, req.user),
  };
}

/** The Finding behind a case: delivery cases come from the at_risk or overdue list, others share the ID. */
async function sourceFinding(caseRow: Row): Promise<Row | null> {
  const ids =
    caseRow.kind === "delivery"
      ? ["at_risk", "overdue"].map(
          (list) => `${list}:${caseRow.ID.slice("delivery:".length)}`,
        )
      : [caseRow.ID];
  return (
    (await SELECT.one
      .from(`${NS}.Finding`)
      .where({ ID: { in: ids } })
      .orderBy("ID desc")) ?? null
  );
}

async function caseReasons(caseRow: Row) {
  const f = await sourceFinding(caseRow);
  if (!f) return {};
  const steps = String(f.chain ?? "")
    .split(/\s*→\s*/)
    .map((s) => plainWords(s))
    .filter(Boolean);
  let materialSources: Row[] | undefined;
  if (f.list === "mm_pdt") {
    const detail = await SELECT.one
      .from(`${NS}.MmPdtDetail`)
      .where({ finding_ID: f.ID });
    if (detail)
      detail.sources = await SELECT.from(`${NS}.MmPdtSource`).where({
        finding_finding_ID: f.ID,
      });
    materialSources = mmSources({ ...f, mmPdtDetail: detail });
  }
  return {
    issue: plainWords(f.issue),
    steps,
    nextStep: f.nextStep ?? null,
    ...(materialSources ? { materialSources } : {}),
  };
}

async function listCasesTool(req: Req) {
  const scope = await buyerScope(req.user);
  const where: Row = { status: "open", listing: "listed" };
  const kind = str(req, "kind");
  const plant = str(req, "plant");
  const group = str(req, "purchasingGroup");
  if (plant && scope.Plant && plant !== scope.Plant)
    throw fail(403, "The requested scope is outside your purchasing scope");
  if (group && scope.PurchasingGroup && group !== scope.PurchasingGroup)
    throw fail(403, "The requested scope is outside your purchasing scope");
  if (kind) where.kind = kind;
  if (plant ?? scope.Plant) where.Plant = plant ?? scope.Plant;
  if (group ?? scope.PurchasingGroup)
    where.PurchasingGroup = group ?? scope.PurchasingGroup;
  const search = str(req, "search")?.toLowerCase();
  let cases: Row[] = await SELECT.from(`${NS}.Cases`)
    .where(where)
    .orderBy("priority", "dueDate", "ID");
  if (search)
    cases = cases.filter((row) =>
      `${row.ID} ${row.title ?? ""}`.toLowerCase().includes(search),
    );
  return {
    source: "rule",
    total: cases.length,
    cases: cases.slice(0, MAX_ROWS).map((row) => ({
      caseID: row.ID,
      kind: row.kind,
      attention: row.attention,
      title: row.title,
      typedEntitySet: CASE_ENTITY[row.kind] ?? null,
      typedKey: row.ID,
      link: caseLink(row.ID, row.kind),
    })),
  };
}

async function getTodayTool(req: Req) {
  const scope = await buyerScope(req.user);
  const where = await scopedWhere(req);
  const [asOf, snap, counts, pending, overview]: [
    string | null,
    Row | null,
    Row[],
    Row[],
    Row,
  ] = await Promise.all([
    asOfDate(),
    SELECT.one
      .from(`${NS}.Snapshot`)
      .where({ status: "done" })
      .orderBy("finishedAt desc"),
    SELECT.from(`${NS}.Finding`)
      .columns("list", "count(1) as n")
      .where(where)
      .groupBy("list"),
    visiblePendingActions(req.user),
    cockpit(req, "overview", {}).then((o) => o ?? {}),
  ]);
  const by = new Map(counts.map((c) => [c.list, Number(c.n)]));
  return {
    source: "calculation",
    asOf,
    preparedAt: snap?.finishedAt ?? null,
    user: req.user.id,
    PurchasingGroup: scope.PurchasingGroup,
    Plant: scope.Plant,
    lists: FINDING_LISTS.map((l) => ({
      list: l,
      text: LIST_TEXT[l],
      meaning: LIST_MEANING[l],
      count: by.get(l) ?? 0,
    })),
    pendingActions: pending.length,
    kpis: overview.kpis ?? null,
    dayLines: (overview.dayLines ?? []).map((l: Row) => ({
      key: l.key,
      text: l.text,
      count: l.count,
      amount: l.amount,
      list: l.list,
      listText: l.list ? (LIST_TEXT[l.list as FindingList] ?? l.list) : null,
    })),
    note: snap
      ? `From the morning run of ${asOf}.`
      : "The day is not prepared yet.",
  };
}

async function workflow(event: string, req: Req, data: Row) {
  const srv = await cds.connect.to(
    event === "submitRequisitionReview" ? "ReviewService" : "WorkflowService",
  );
  return withWorkflowOrigin("mcp", () => srv.tx(req).send(event, data));
}

/** Workflow command behind each receipted tool and the arguments it is hashed with. */
export const COMMAND_ARGUMENTS: Record<string, string[]> = {
  prepareSupplierPlannedTimeAction: [
    "caseID",
    "days",
    "expectedModifiedAt",
    "expectedFingerprint",
  ],
  prepareCaseAction: [
    "caseID",
    "responsiblePerson",
    "responsibleMessage",
    "expectedModifiedAt",
    "expectedFingerprint",
  ],
  submitRequisitionReview: [
    "caseID",
    "expectedModifiedAt",
    "expectedReviewToken",
  ],
};
export const TOOL_COMMANDS: Record<string, string[]> = {
  prepare_case_action: [
    "prepareSupplierPlannedTimeAction",
    "prepareCaseAction",
  ],
  submit_review: ["submitRequisitionReview"],
};

const pick = (data: Row, event: string) =>
  Object.fromEntries(
    COMMAND_ARGUMENTS[event].filter((k) => k in data).map((k) => [k, data[k]]),
  );

async function prepareCaseActionTool(req: Req) {
  const caseID = str(req, "caseID", true)!;
  const caseRow = await visibleCase(req, caseID);
  const supplier = caseRow.kind === "supplier_planned_time";
  if (!supplier && req.data.days != null)
    throw fail(400, "days applies to supplier_planned_time cases only");
  if (supplier && (req.data.responsiblePerson || req.data.responsibleMessage))
    throw fail(
      400,
      "responsiblePerson and responsibleMessage apply to price cases only",
    );
  const event = supplier
    ? "prepareSupplierPlannedTimeAction"
    : "prepareCaseAction";
  return workflow(event, req, {
    ...pick(req.data, event),
    commandID: req.data.commandID,
  });
}

const submitReviewTool = (req: Req) =>
  workflow("submitRequisitionReview", req, {
    ...pick(req.data, "submitRequisitionReview"),
    commandID: req.data.commandID,
  });

async function workflowReviewSummaryTool(req: Req) {
  const caseID = str(req, "caseID", true)!;
  const header = await visibleCase(req, caseID);
  if (header.kind !== "requisition_review")
    throw fail(400, "A requisition Review is required");
  return reviewRequisitionOrder(caseID, req.user);
}

/** Persistence: the at_risk findings in scope, sorted by impact rank, plus their ItemImpact rows. */
async function loadPriorityData(req: Req, limit: number) {
  const rows = (await findings(await scopedWhere(req), "at_risk")).sort(
    (a, b) =>
      impactRank(a.impactLevel) - impactRank(b.impactLevel) ||
      (a.rank ?? 1e9) - (b.rank ?? 1e9),
  );
  const top = rows.slice(0, limit);
  const impacts: Row[] = top.length
    ? await SELECT.from(`${NS}.ItemImpact`).where({
        PurchaseOrder: { in: top.map((r) => r.PurchaseOrder) },
      })
    : [];
  const byItem = new Map(
    impacts.map((i) => [`${i.PurchaseOrder}/${i.PurchaseOrderItem}`, i]),
  );
  return { rows, top, byItem };
}

/** Business: severity counts and the revenue total over every at_risk row in scope (not just the page). */
function priorityAggregates(rows: Row[]) {
  const severity = new Map<string, number>();
  for (const r of rows)
    if (r.impactLevel)
      severity.set(r.impactLevel, (severity.get(r.impactLevel) ?? 0) + 1);
  return {
    atRiskTotal: rows.length,
    bySeverity: [...severity].map(([list, count]) => ({
      list,
      text: impactText(list),
      count,
    })),
    revenueTotal:
      Math.round(rows.reduce((a, r) => a + (r.revenueAtRisk ?? 0), 0) * 100) /
      100,
  };
}

/** Response shaping: one ranked, linked row per finding (customers looked up per row). */
async function priorityRows(top: Row[], byItem: Map<string, Row>) {
  const out = [];
  for (const [n, f] of top.entries()) {
    const i = byItem.get(`${f.PurchaseOrder}/${f.PurchaseOrderItem}`);
    out.push({
      rank: n + 1,
      ID: f.ID,
      PurchaseOrder: f.PurchaseOrder,
      PurchaseOrderItem: f.PurchaseOrderItem,
      Material: f.Material,
      Supplier: f.Supplier,
      Plant: f.Plant,
      itemTitle: f.itemTitle,
      impactLevel: f.impactLevel ?? i?.level ?? null,
      impactText: f.impactText ?? impactText(i?.level, i?.revenueAtRisk),
      revenueAtRisk: f.revenueAtRisk ?? i?.revenueAtRisk ?? null,
      currency: "EUR",
      expectedDate: i?.expectedDate ?? null,
      needDate: i?.needDate ?? null,
      delayDays: i?.delayDays ?? null,
      shortageDays: i?.shortageDays ?? null,
      productionOrders: i?.productionOrders ?? null,
      customers: f.PurchaseOrder
        ? await customersOf(f.PurchaseOrder, f.PurchaseOrderItem)
        : [],
      link: links.finding(f.ID),
    });
  }
  return out;
}

async function prioritiesTool(req: Req) {
  const limit = req.data.limit ?? MAX_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS)
    throw fail(400, `limit must be between 1 and ${MAX_ROWS}`);
  const { rows, top, byItem } = await loadPriorityData(req, limit);
  const out = await priorityRows(top, byItem);
  return {
    source: "calculation",
    sourceText: sourceText("calculation"),
    order: PRIORITY_ORDER,
    ...priorityAggregates(rows),
    currency: "EUR",
    rows: out,
    note: PRIORITY_NOTE,
  };
}

async function leadTimeRangeTool(req: Req) {
  const Material = str(req, "Material", true);
  const Plant = str(req, "Plant", true);
  const Supplier = str(req, "Supplier");
  const r: Row = await cockpit(req, "leadTimeRange", {
    Material,
    Plant,
    Supplier,
  });
  const warnings: string[] = [];
  if (r?.source === "tabpfn" || r?.source === "fallback")
    warnings.push("AI estimate, not a promise");
  return { ...r, sourceText: sourceText(r?.source), warnings };
}

async function planOrderTool(req: Req) {
  const r: Row = await cockpit(req, "planOrder", {
    Material: str(req, "Material", true),
    Plant: str(req, "Plant", true),
    Supplier: str(req, "Supplier"),
    needDate: req.data.needDate,
  });
  return { ...r, sourceText: sourceText(r?.source) };
}

async function proposeFreetextCodesTool(req: Req) {
  const rows: Row[] = await cockpit(req, "proposeCodes", {
    text: str(req, "text", true),
    Plant: str(req, "Plant", true),
    PurchasingOrganization: str(req, "PurchasingOrganization"),
    PurchaseOrderType: str(req, "PurchaseOrderType"),
    withSupplier: false,
  });
  return {
    source: "tabpfn",
    fields: (rows ?? []).map((p) => ({
      field: p.field,
      value: p.value,
      text: p.text,
      status: p.status,
      source: p.source,
    })),
  };
}

async function thresholdSimulatorTool(req: Req) {
  const field = str(req, "field", true);
  const segment = str(req, "segment");
  const rows: Row[] = await cockpit(req, "thresholdSimulator", {
    field,
    segment,
  });
  return { source: "empirical", field, segment, rows: rows ?? [] };
}

async function plannedDeliveryTimeSimulatorTool(req: Req) {
  const key = {
    Material: str(req, "Material", true),
    Supplier: str(req, "Supplier", true),
    Plant: str(req, "Plant", true),
  };
  const rows: Row[] = await cockpit(req, "bufferSimulator", key);
  return { source: "empirical", ...key, rows: rows ?? [] };
}

const predictOrdersTool = async (req: Req) => predictOrders(req.user, req.data);

async function listPendingActionsTool(req: Req) {
  const rows = await visiblePendingActions(req.user);
  return {
    source: "rule",
    total: rows.length,
    pending: rows.slice(0, MAX_ROWS).map((a) => publicAction(a)),
    note: NOTHING_WRITTEN,
  };
}

async function visiblePendingActions(user: cds.User): Promise<Row[]> {
  const rows: Row[] = await SELECT.from(`${NS}.Actions`)
    .where({ status: "needs_decision" })
    .orderBy("createdAt desc");
  const visible: Row[] = [];
  for (const row of rows)
    if (await approvalVisible(row.ID, user)) visible.push(row);
  return visible;
}

export function registerCockpitTools(srv: cds.Service) {
  // sanitizeErrors turns every error >= 500 into a generic message; a 501 of
  // an operation that is not implemented yet is safe to show, so restore it.
  srv.on("error", (err: any) => {
    if (!err?.notAvailable) return;
    err.status = 501;
    err.code = "NOT_IMPLEMENTED";
    err.message = err.notAvailableMessage ?? err.message;
  });

  const tools: Record<string, (req: Req) => Promise<unknown>> = {
    get_today: getTodayTool,
    list_cases: listCasesTool,
    get_case: getCaseTool,
    list_priorities: prioritiesTool,
    get_lead_time_range: leadTimeRangeTool,
    plan_order: planOrderTool,
    propose_freetext_codes: proposeFreetextCodesTool,
    simulate_thresholds: thresholdSimulatorTool,
    simulate_planned_delivery_time: plannedDeliveryTimeSimulatorTool,
    list_pending_actions: listPendingActionsTool,
    get_review_summary: workflowReviewSummaryTool,
    predict_orders: predictOrdersTool,
    prepare_case_action: prepareCaseActionTool,
    submit_review: submitReviewTool,
  };
  // A P-9 tool: its result reaches the model only as modelView (NS-J2).
  // Tools that may wait for a model run leave the request transaction (SQLite).
  for (const [name, impl] of Object.entries(tools))
    srv.on(name, async (req: Req) =>
      modelView(await modelWork(() => impl(req))),
    );
}
