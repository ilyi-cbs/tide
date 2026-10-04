// Feature "guard" (T8b): buyers per purchasing group, row scope per buyer,
// me(), budget() and the budget guard on every model call (P-15).
import cds from "@sap/cds";
import type { Step, StepContext } from "../kernel/types";
import { registerCallGuard, registerCallRecorder } from "../kernel/model-calls";
import { deriveBuyers, inScope, scopeOf, type Scope } from "./domain/logic";
import * as ledger from "./ledger";
import { mountProxy } from "./proxy";
import { approvalVisible } from "../kernel/actions";
import { writePreparation } from "../kernel/publication";

const { SELECT, INSERT, DELETE } = cds.ql;
const NS = "tide.cockpit";

/** Entities of PurchasingDeskService filtered by the buyer's purchasing group and plant (when they have the column). */
export const SCOPED = [
  "Cases",
  "DeliveryRisks",
  "Findings",
  "FulfillmentRisks",
  "PriceFindings",
  "DuplicateFindings",
  "RareSettingFindings",
  "SupplierPlannedTimeFindings",
  "MaterialMasterPlannedTimeFindings",
  "OpenItems",
  "SourceFindings",
  "SourceRanges",
  "SourceBacktests",
  "LineGrids",
  "PlannedTimes",
  "Buyers",
  "Events",
  "ItemImpacts",
  "Confirmations",
  "CustomerImpacts",
  "Customers",
  "PurchaseRequisitionReviews",
  "RequisitionReviews",
  "FreetextWorkItems",
];

const APPROVAL_ENTITIES = new Set([
  "Actions",
  "ActionItems",
  "ActionEvents",
  "ApprovalEvents",
]);
const PROBLEM_ENTITIES = new Set([
  "Cases",
  "CaseEvents",
  "CaseActions",
  "OperationLocks",
]);
const TYPED_CASE_ENTITIES = new Set([
  "DeliveryRisks",
  "PriceDeviations",
  "DuplicateMaterials",
  "UnusualSettings",
  "SupplierPlannedTimes",
  "MaterialPlannedTimes",
  "RequisitionReviews",
]);
const FINDING_DETAIL_KEYS: Record<string, string> = {
  RuleLines: "findingID",
  PdtDetails: "finding_ID",
  MmPdtDetails: "finding_ID",
  MmPdtSources: "finding_finding_ID",
};

export const step: Step = {
  name: "guard",
  async run(ctx: StepContext) {
    if (ctx.dryRun) return;
    const [heads, items]: [
      { PurchaseOrder: string; PurchasingGroup: string | null }[],
      { PurchaseOrder: string; Plant: string | null }[],
    ] = await Promise.all([
      SELECT.from("tide.s4.PurchaseOrder").columns(
        "PurchaseOrder",
        "PurchasingGroup",
      ),
      SELECT.from("tide.s4.PurchaseOrderItem")
        .columns("PurchaseOrder", "Plant")
        .groupBy("PurchaseOrder", "Plant"),
    ]);
    const group = new Map(
      heads.map((h) => [h.PurchaseOrder, h.PurchasingGroup]),
    );
    const rows = items.map((i) => ({
      PurchasingGroup: group.get(i.PurchaseOrder),
      Plant: i.Plant,
    }));
    let names = new Map<string, string>();
    if (cds.model?.definitions["tide.s4.PurchasingGroup"]) {
      const pg: { PurchasingGroup: string; PurchasingGroupName: string }[] =
        await SELECT.from("tide.s4.PurchasingGroup").columns(
          "PurchasingGroup",
          "PurchasingGroupName",
        );
      names = new Map(
        pg.map((p) => [p.PurchasingGroup, p.PurchasingGroupName]),
      );
    }
    const buyers = deriveBuyers(rows, names);
    if (ctx.publication) ctx.publication.buyers = buyers;
    await writePreparation(ctx, async () => {
      await DELETE.from(`${NS}.Buyer`);
      if (buyers.length) await INSERT.into(`${NS}.Buyer`).entries(buyers);
    });
  },
};

/** CQN condition of the scope for an entity with (some of) the columns PurchasingGroup / Plant. */
export function scopeWhere(
  scope: Scope,
  elements: Record<string, unknown>,
  groupColumn = "PurchasingGroup",
): any[] | null {
  if (scope.isAdmin) return null;
  const grants =
    scope.grants ??
    (scope.Plant && scope.PurchasingGroup
      ? [{ Plant: scope.Plant, PurchasingGroup: scope.PurchasingGroup }]
      : []);
  if (!grants.length) return ["1 = 0"];
  const columns = ["PurchasingGroup", "Plant"].filter(
    (column) => elements[column === "PurchasingGroup" ? groupColumn : column],
  ) as Array<"PurchasingGroup" | "Plant">;
  if (!columns.length) return null;
  return [
    `(${grants
      .map(
        (grant) =>
          `(${columns
            .map(
              (column) =>
                `${column === "PurchasingGroup" ? groupColumn : column} = '${grant[column].replace(/'/g, "''")}'`,
            )
            .join(" and ")})`,
      )
      .join(" or ")})`,
  ];
}

/**
 * Scope of an entity without PurchasingGroup / Plant but with PurchaseOrder:
 * only orders of the buyer's group (and items of the buyer's plant).
 */
export function orderScopeWhere(
  scope: Scope,
  elements: Record<string, unknown>,
): any | null {
  if (
    scope.isAdmin ||
    elements.PurchasingGroup ||
    elements.Plant ||
    !elements.PurchaseOrder
  )
    return null;
  const grants =
    scope.grants ??
    (scope.Plant && scope.PurchasingGroup
      ? [{ Plant: scope.Plant, PurchasingGroup: scope.PurchasingGroup }]
      : []);
  if (!grants.length) return { xpr: [{ val: 1 }, "=", { val: 0 }] };
  return {
    xpr: grants.flatMap((grant, index) => [
      ...(index ? ["or"] : []),
      {
        xpr: [
          { ref: ["PurchaseOrder"] },
          "in",
          SELECT.from("tide.s4.PurchaseOrderItem")
            .columns("PurchaseOrder")
            .where({
              Plant: grant.Plant,
              PurchaseOrder: {
                in: SELECT.from("tide.s4.PurchaseOrder")
                  .columns("PurchaseOrder")
                  .where({ PurchasingGroup: grant.PurchasingGroup }),
              },
            }),
        ],
      },
    ]),
  };
}

function applyScope(req: cds.Request) {
  const scope = scopeOf(req.user);
  const target = req.target as
    { elements?: Record<string, unknown> } | undefined;
  const elements = target?.elements ?? {};
  const review = [
    "PurchaseRequisitionReviews",
    "RequisitionReviews",
    "FreetextWorkItems",
  ].includes(req.target?.name?.split(".").at(-1) ?? "");
  const where = scopeWhere(
    scope,
    elements,
    review && elements.routedGroup ? "routedGroup" : "PurchasingGroup",
  );
  if (where) (req.query as any).where(where[0]);
  const byOrder = orderScopeWhere(scope, elements);
  if (byOrder) (req.query as any).where(byOrder);
  if (review && !scope.isAdmin)
    (req.query as any).where(
      `routedBuyer = '${req.user.id.replace(/'/g, "''")}'`,
    );
}

function applyDetailScope(req: cds.Request) {
  const scope = scopeOf(req.user);
  if (scope.isAdmin) return;
  const name = req.target!.name.split(".").at(-1)!;
  const findingKey = FINDING_DETAIL_KEYS[name];
  const ownerEntity = findingKey ? "Finding" : "OpenItem";
  const owners: any = SELECT.from(`${NS}.${ownerEntity}`).columns(
    findingKey ? "ID" : "PurchaseOrder",
  );
  owners.SELECT.from.as = "scopeOwner";
  const predicate = scopeWhere(
    scope,
    (cds.model!.definitions[`${NS}.${ownerEntity}`] as any).elements,
  );
  if (predicate) owners.where(predicate[0]);
  if (findingKey) {
    (req.query as any).where({ [findingKey]: { in: owners } });
  } else {
    const query = req.query as any;
    const outer = (query.SELECT.from.as ||= "buyerDetail");
    owners.where([
      { ref: ["scopeOwner", "PurchaseOrder"] },
      "=",
      { ref: [outer, "PurchaseOrder"] },
      "and",
      { ref: ["scopeOwner", "PurchaseOrderItem"] },
      "=",
      { ref: [outer, "PurchaseOrderItem"] },
    ]);
    query.where(["exists", owners]);
  }
}

async function applyWorkflowScope(req: cds.Request) {
  const scope = scopeOf(req.user);
  if (scope.isAdmin) return;
  const name = req.target?.name?.split(".").at(-1) ?? "";
  if (PROBLEM_ENTITIES.has(name) || TYPED_CASE_ENTITIES.has(name)) {
    if (name === "Cases") {
      const target = req.target as { elements?: Record<string, unknown> };
      const where = scopeWhere(scope, target.elements ?? {});
      if (where) (req.query as any).where(where[0]);
    } else {
      const casesQuery: any = SELECT.from(`${NS}.Cases`).columns("ID");
      const caseWhere = scopeWhere(
        scope,
        (cds.model!.definitions[`${NS}.Cases`] as any)?.elements ?? {},
      );
      if (caseWhere) casesQuery.where(caseWhere[0]);
      const cases: Array<{ ID: string }> = await casesQuery;
      (req.query as any).where(
        cases.length
          ? { header_ID: { in: cases.map((row) => row.ID) } }
          : { header_ID: "__none__" },
      );
    }
    return;
  }
  if (!APPROVAL_ENTITIES.has(name)) return;
  const actions: Array<{ ID: string }> = await SELECT.from(
    `${NS}.Actions`,
  ).columns("ID");
  const allowed: string[] = [];
  for (const action of actions)
    if (await approvalVisible(action.ID, req.user)) allowed.push(action.ID);
  const key =
    name === "Actions"
      ? "ID"
      : name === "ApprovalEvents"
        ? "approval_ID"
        : "action_ID";
  (req.query as any).where(
    allowed.length
      ? { [key]: { in: allowed } }
      : { [key]: "00000000-0000-0000-0000-000000000000" },
  );
}

async function applyCustomerScope(req: cds.Request) {
  const scope = scopeOf(req.user);
  if (scope.isAdmin) return;
  const [impacts, items]: [
    Array<{
      Customer: string;
      PurchaseOrder: string;
      PurchaseOrderItem: string;
    }>,
    any[],
  ] = await Promise.all([
    SELECT.from(`${NS}.CustomerImpact`).columns(
      "Customer",
      "PurchaseOrder",
      "PurchaseOrderItem",
    ),
    SELECT.from(`${NS}.OpenItem`).columns(
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Plant",
      "PurchasingGroup",
    ),
  ]);
  const byKey = new Map(
    items.map((item) => [
      `${item.PurchaseOrder}/${item.PurchaseOrderItem}`,
      item,
    ]),
  );
  const allowed = new Set<string>();
  const excluded = new Set<string>();
  for (const impact of impacts) {
    const item = byKey.get(
      `${impact.PurchaseOrder}/${impact.PurchaseOrderItem}`,
    );
    if (item && inScope(scope, item)) allowed.add(impact.Customer);
    else excluded.add(impact.Customer);
  }
  // Stored totals span buyers. Exclude mixed-scope totals rather than leaking
  // another team's exposure through a customer shared by both teams.
  const customers = [...allowed].filter((customer) => !excluded.has(customer));
  (req.query as any).where({
    Customer: { in: customers.length ? customers : ["__none__"] },
  });
}

export function outOfScope(scope: Scope, row: unknown): boolean {
  if (scope.isAdmin || !row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  if (!("PurchasingGroup" in r) && !("Plant" in r)) return false;
  return !inScope(
    scope,
    r as { PurchasingGroup?: string | null; Plant?: string | null },
  );
}

/** Drops out-of-scope rows of a tool result: an array, or an object with array fields (rows, items, …). */
export function filterResult(scope: Scope, result: any): any {
  if (scope.isAdmin || !result || typeof result !== "object") return result;
  if (Array.isArray(result)) return result.filter((r) => !outOfScope(scope, r));
  for (const [k, v] of Object.entries(result)) {
    if (!Array.isArray(v)) continue;
    const kept = v.filter((r) => !outOfScope(scope, r));
    if (kept.length !== v.length) {
      result[k] = kept;
      if (k === "rows" && typeof result.rowsShown === "number")
        result.rowsShown = kept.length;
    }
  }
  return result;
}

function requireBuyerScope(req: cds.Request) {
  const scope = scopeOf(req.user);
  if (!scope.isAdmin && !scope.grants?.length)
    req.reject(403, "Buyer scope is not configured for this user.");
}

const ASSISTANT_SERVICES = ["CockpitMcpService", "AssistantRuntimeService"];

/** Chat assistant services: results are cut to the caller's buyer scope. */
function guardAssistantServices() {
  for (const name of ASSISTANT_SERVICES) {
    const agent = (cds.services as any)[name] as cds.Service | undefined;
    if (!agent || (agent as any)._tideGuard) continue;
    (agent as any)._tideGuard = true;
    agent.before("*", requireBuyerScope);
    agent.after("*", (result: any, req: cds.Request) => {
      if (!req?.user || (req as any).target) return; // entity reads are scoped by their own where
      const scope = scopeOf(req.user);
      if (scope.isAdmin) return;
      const out = filterResult(scope, result);
      if (Array.isArray(result) && out !== result)
        result.splice(0, result.length, ...out);
    });
  }
}

// Chat proxy and assistant guards: registered once the app is served
// (feature modules load after 'bootstrap').
cds.on("served", () => {
  mountProxy((cds as any).app);
  guardAssistantServices();
});

export function register(srv: cds.Service) {
  srv.before("*", (req) => {
    if (req.event !== "me" && req.event !== "budget") requireBuyerScope(req);
  });
  for (const e of SCOPED)
    if ((srv as any).entities[e]) srv.before("READ", e, applyScope);
  for (const entity of [
    "ItemImpacts",
    "SalesOrderImpacts",
    "ProductionOrderImpacts",
    ...Object.keys(FINDING_DETAIL_KEYS),
  ])
    if ((srv as any).entities[entity])
      srv.before("READ", entity, applyDetailScope);
  for (const e of [
    ...APPROVAL_ENTITIES,
    ...PROBLEM_ENTITIES,
    ...TYPED_CASE_ENTITIES,
  ])
    if ((srv as any).entities[e]) srv.before("READ", e, applyWorkflowScope);
  srv.before("READ", "Questions", (req) => {
    (req.query as any).where({ createdBy: req.user.id });
  });
  srv.before("READ", "Answers", (req) => {
    (req.query as any).where({
      question_ID: {
        in: SELECT.from(`${NS}.PredictionQuestion`)
          .columns("ID")
          .where({ createdBy: req.user.id }),
      },
    });
  });
  srv.before("READ", "Customers", applyCustomerScope);
  for (const entity of ["Problems", "ProblemEvents", "FindingEvidence"])
    srv.before("READ", entity, async (req) => {
      const scope = scopeOf(req.user);
      if (scope.isAdmin) return;
      const findings: any[] = await SELECT.from(`${NS}.Finding`).columns(
        "ID",
        "problemKey",
        "Plant",
        "PurchasingGroup",
      );
      const keys = [
        ...new Set(
          findings
            .filter((row) => inScope(scope, row))
            .flatMap((row) => [row.problemKey, row.ID])
            .filter(Boolean),
        ),
      ];
      (req.query as any).where({
        problemKey: { in: keys.length ? keys : ["__none__"] },
      });
    });

  srv.on("budget", () => ledger.state());

  srv.on("me", async (req: cds.Request) => {
    const u = req.user;
    const scope = scopeOf(u);
    const [buyer, info, snap]: any[] = await Promise.all([
      SELECT.one.from(`${NS}.Buyer`).where({ userId: u.id }),
      SELECT.one.from("tide.s4.DatasetInfo").where({ ID: "current" }),
      SELECT.one
        .from(`${NS}.Snapshot`)
        .columns("ID", "status", "finishedAt", "backend", "message")
        .where`message is null or message not like 'dry run%'`.orderBy(
        "startedAt desc",
      ),
    ]);
    return {
      userId: u.id,
      name: buyer?.name ?? u.id,
      PurchasingGroup: scope.PurchasingGroup,
      Plant: scope.Plant,
      isAdmin: scope.isAdmin,
      mockAuthentication: (cds.env.requires as any).auth?.kind === "mocked",
      asOf: info?.asOf ?? null,
      datasetName: info?.name ?? null,
      snapshotId: snap?.ID ?? null,
      snapshotStatus: snap?.status ?? null,
      snapshotHasFailures: /failed (runs|steps):/i.test(
        String(snap?.message ?? ""),
      ),
      preparedAt: snap?.finishedAt ?? null,
      backend: snap?.backend ?? null,
    };
  });

  // Guard seams (kernel/model-calls.ts): checked before every paid call and
  // every dry-run estimate; recorded after a real run.
  registerCallGuard((est) => ledger.check(est.label, est.costUnits));
  registerCallRecorder((used) =>
    ledger.record(used.label, used.calls, used.costUnits),
  );
}
