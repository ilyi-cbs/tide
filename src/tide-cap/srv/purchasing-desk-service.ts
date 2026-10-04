import cds from "@sap/cds";
import { sanitizeErrors } from "./core/errors";
import { fail } from "./cockpit/kernel/errors";
import {
  DRY_RUN,
  datasetInfo,
  ensurePreparedDataset,
  latestRealSnapshot,
  recomputeItem,
  startPrepareDay,
  NS,
} from "./cockpit/prepare";
import { modelWork } from "./cockpit/kernel/model-calls";
import {
  GRID,
  addDays,
  at,
  daysBetween,
  pdtRule,
  round1,
  type Grid,
} from "./cockpit/logic";
import {
  addToChangeListAction,
  exportActionCsv,
  prepareReminderAction,
} from "./cockpit/kernel/actions";
import { statusCriticality } from "./cockpit/kernel/findings";
import { registerKernel } from "./cockpit/kernel/service";
import { ensureMissingReviews } from "./cockpit/freetext/review";
import { refreshFreetextSources } from "./cockpit/freetext";
import { registerFeedPorts } from "./cockpit/kernel/feed-ports";
import {
  backfillTypedCases,
  relinkPreparedAssessments,
} from "./cockpit/kernel/typed-cases";
import { migrateFindingDetails } from "./cockpit/kernel/detail-migration";

const { SELECT } = cds.ql;
const LOG = cds.log("cockpit");

type Req = cds.Request;

export { addToChangeListAction, prepareReminderAction };

export async function kpis() {
  const info = await datasetInfo();
  const snap = info?.asOf ? await latestRealSnapshot(info) : null;
  const { n: pending } = await SELECT.one
    .from(`${NS}.Actions`)
    .columns("count(1) as n")
    .where({ status: "needs_decision" });
  const { n: all, d: defaults } = await SELECT.one
    .from(`${NS}.OpenItem`)
    .columns(
      "count(1) as n",
      `sum(case when pdtVerdict in ('default','not_maintained','placeholder') then 1 else 0 end) as d`,
    );
  return {
    asOf: info?.asOf ?? null,
    datasetName: info?.name ?? null,
    containsCustomerData: info ? !!info.containsCustomerData : null,
    preparedAt: snap?.finishedAt ?? null,
    backend: snap?.backend ?? null,
    openItems: snap?.openItems ?? 0,
    atRisk: snap?.atRisk ?? 0,
    late: snap?.late ?? 0,
    overdue: snap?.overdue ?? 0,
    revenueAtRiskP50: snap?.revenueAtRiskP50 ?? 0,
    revenueAtRiskP80: snap?.revenueAtRiskP80 ?? 0,
    allOpenImpactRevenue: snap?.impactRevenueAtRisk ?? 0,
    sourcesToFix: snap?.sourcesToFix ?? 0,
    pendingApprovals: Number(pending),
    defaultPdtShare: Number(all)
      ? round1((Number(defaults) / Number(all)) * 1000) / 1000
      : null,
    currency: "EUR",
  };
}

export async function sourceReadiness() {
  const current = await SELECT.one
    .from("tide.source.SourcePublications")
    .columns("load_ID")
    .where({ name: "current" });
  const load = current?.load_ID
    ? await SELECT.one
        .from("tide.source.SourceLoads")
        .columns("quality")
        .where({ ID: current.load_ID })
    : null;
  let capabilities: Record<string, { status: string; reasons: string[] }> = {};
  try {
    capabilities = JSON.parse(load?.quality || "{}").capabilities ?? {};
  } catch {
    capabilities = {};
  }
  const rows = Object.entries(capabilities).map(([capability, value]) => ({
    capability,
    status: value.status,
    reasons: value.reasons ?? [],
  }));
  return rows.length
    ? rows
    : [
        {
          capability: "all",
          status: "unknown",
          reasons: ["No source load reports readiness; reload the source"],
        },
      ];
}

export async function plan(data: {
  Material: string;
  Supplier: string;
  Plant: string;
  needDate: string;
}) {
  const info = await datasetInfo();
  const asOf: string = info?.asOf;
  const range = await SELECT.one.from(`${NS}.SourceRange`).where({
    Material: data.Material,
    Supplier: data.Supplier,
    Plant: data.Plant,
  });
  if (!range?.quantiles)
    throw fail(
      404,
      "No lead-time range for this source; run prepareDay or pick another source",
    );
  const grid: Grid = JSON.parse(range.quantiles);
  const ir = await SELECT.one.from("tide.s4.PurgInfoRecdOrgPlantData").where({
    Material: data.Material,
    Supplier: data.Supplier,
    Plant: data.Plant,
  });
  const master = await SELECT.one
    .from("tide.s4.ProductPlantSupplyPlanning")
    .where({
      Product: data.Material,
      Plant: data.Plant,
    });
  const irDays = ir?.MaterialPlannedDeliveryDurn ?? null;
  const planned =
    irDays > 0 ? irDays : (master?.PlannedDeliveryDurationInDays ?? null);
  const p50 = at(grid, 0.5) ?? 0;
  const sapOrderDate =
    planned === null ? null : addDays(data.needDate, -planned);
  const latestP50 = addDays(data.needDate, -p50);
  const lateBy = sapOrderDate ? daysBetween(latestP50, sapOrderDate) : 0;
  const rule = pdtRule(planned);
  return {
    ...data,
    asOf,
    source: range.source,
    contextLevel: range.contextLevel,
    n: range.source === "empirical" ? range.nOwn : range.contextRows,
    plannedDays: planned,
    plannedFrom: irDays > 0 ? "info record" : "material master",
    sapOrderDate,
    sapFinding:
      lateBy > 0
        ? `SAP would order ${lateBy} days too late${rule ? ` (planned delivery time is ${rule.replace("_", " ")})` : ""}`
        : null,
    rows: GRID.filter((q) => q >= 0.5).map((q) => {
      const lt = at(grid, q) ?? 0;
      const earliest = addDays(asOf, lt);
      return {
        quantile: q,
        label: `p${Math.round(q * 100)}`,
        leadTimeDays: lt,
        latestOrderDate: addDays(data.needDate, -lt),
        earliestDelivery: earliest,
        reachable: earliest <= data.needDate,
        safetyDays: round1(Math.max(lt - p50, 0)),
      };
    }),
  };
}

export default class PurchasingDeskService extends cds.ApplicationService {
  async init() {
    sanitizeErrors(this);
    registerFeedPorts({
      refreshSources: refreshFreetextSources,
      prepareDay: (user) => startPrepareDay(user, false, true),
    });
    // Restore missing review projections from durable work items before exposing the Requests list.
    const restoredReviews = await ensureMissingReviews();
    if (restoredReviews)
      LOG.info(`restored ${restoredReviews} missing requisition review(s)`);

    this.on("prepareDay", (req: Req) =>
      startPrepareDay(req.user, !!req.data.dryRun, false, req),
    );
    this.on("recompute", "OpenItems", (req: Req) => {
      const [k] = req.params as any[];
      return modelWork(() =>
        recomputeItem(req.user, {
          PurchaseOrder: k.PurchaseOrder,
          PurchaseOrderItem: k.PurchaseOrderItem,
        }),
      );
    });
    this.on("kpis", () => kpis());
    this.on("sourceReadiness", () => sourceReadiness());
    this.on("plan", (req: Req) => plan(req.data));
    this.on("prepareReminder", (req: Req) =>
      req.reject(
        410,
        "Use WorkflowService.prepareDeliveryReminder with commandID and reviewed evidence",
      ),
    );
    this.on("addToChangeList", "SourceFindings", async (req: Req) => {
      const [k] = req.params as any[];
      return addToChangeListAction(
        { Material: k.Material, Supplier: k.Supplier, Plant: k.Plant },
        req.data.days,
        "app",
      );
    });

    this.on("exportAction", (req: Req) =>
      exportActionCsv(req.data.ID, req.user),
    );

    // Derive case-status fields for legacy finding entities from current action state.
    this.after(
      "READ",
      [
        "Findings",
        "FulfillmentRisks",
        "PriceFindings",
        "DuplicateFindings",
        "RareSettingFindings",
        "SupplierPlannedTimeFindings",
        "MaterialMasterPlannedTimeFindings",
      ],
      (result: any) => {
        const rows = Array.isArray(result) ? result : result ? [result] : [];
        for (const row of rows) {
          if (
            row.statusCriticality === null ||
            row.statusCriticality === undefined
          )
            row.statusCriticality = statusCriticality(row.status);
          if (!["at_risk", "overdue"].includes(row.list)) continue;
          const active = row.activeActionStatus;
          const closed = row.status === "closed";
          row.caseStatus = closed
            ? "resolved"
            : active === "needs_decision"
              ? "approval_required"
              : active === "waiting"
                ? "waiting_for_supplier"
                : "new";
          row.caseStatusText = closed
            ? "Resolved"
            : active === "needs_decision"
              ? "Approval required"
              : active === "waiting"
                ? "Waiting for supplier"
                : "New";
          row.caseStatusCriticality = closed
            ? 3
            : active === "needs_decision"
              ? 1
              : active === "waiting"
                ? 2
                : 2;
          row.caseStatusUpdatedAt = row.arrivedAt ?? null;
        }
      },
    );

    // Register kernel-owned action handlers and operation stubs.
    registerKernel(this);
    await migrateFindingDetails();
    await backfillTypedCases();
    await relinkPreparedAssessments();

    // Prepare the current loader dataset at startup; the cache skips unchanged
    // (asOf, loadId) pairs and retries missing or failed snapshots.
    cds.on("served", () => {
      if (
        cds.env.profiles?.includes("test") ||
        process.env.TIDE_AUTO_PREPARE === "0"
      )
        return;
      setTimeout(() => {
        const ctx = new (cds.EventContext as any)({
          user: new cds.User.Privileged(),
          tenant: cds.context?.tenant,
        });
        (cds as any)._with(ctx, () =>
          ensurePreparedDataset().catch((error) =>
            LOG.error("Startup prepareDay failed", error),
          ),
        );
      }, 0).unref?.();
    });

    return super.init();
  }
}
