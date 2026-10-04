import cds from "@sap/cds";
import { createHash } from "node:crypto";
import { CASE_ENTITIES } from "./case-preparation";
import { inScope, scopeOf } from "./auth";
import { fail } from "./errors";
import {
  NS,
  awaitRun,
  callCore,
  meterRun,
  modelWork,
  type Meter,
  type Row,
} from "./model-calls";
import { asOfDate } from "./asof";
import {
  assessPriceCandidates,
  syncPriceModelRows,
} from "../rules/price-model";
import { leadTimeRange } from "../leadtimes/range";
import { predictOrders } from "../predict-orders";
import { masters, infoRecords } from "../leadtimes/data";
import {
  materialSettingComparison,
  supplierSettingTrigger,
} from "../leadtimes/setting-check";
import { recordSourceChange } from "./cases";
import { predictionSource } from "./prediction-source";

const { SELECT, INSERT } = cds.ql;
const TABLE = `${NS}.PreventionAssessment`;
const REVISION_FIELDS = [
  "assessmentID",
  "caseID",
  "metric",
  "status",
  "source",
  "generatedAt",
  "summary",
  "metrics",
  "expectedFingerprint",
  "baseFingerprint",
  "schemaVersion",
  "policyVersion",
  "sourceAsOf",
  "sourceLoadId",
  "sourceLoadedAt",
  "sourceRevision",
  "sourceFingerprint",
  "run_ID",
  "runs",
];
const TARGETS = [
  "ProcurementType",
  "ProcurementSubType",
  "MRPType",
  "LotSizingProcedure",
  "MRPResponsible",
];
const PLANNING_FEATURES = [
  "Plant",
  "MaterialType",
  "MaterialGroup",
  "BaseUnit",
  "PurchasingGroup",
];
export type AssessmentMetric = {
  label: string;
  current: unknown;
  value: unknown;
  unit: string;
  source: string;
  detail: unknown;
};
type Evidence = {
  status: string;
  source: string;
  summary: string;
  metrics: AssessmentMetric[];
};
const metric = (
  label: string,
  current: unknown,
  value: unknown,
  unit: string,
  source: string,
  detail: unknown,
): AssessmentMetric => ({
  label,
  current: current ?? null,
  value: value ?? null,
  unit,
  source,
  detail,
});
const unavailable = (summary: string, status = "insufficient"): Evidence => ({
  status,
  source: "empirical",
  summary,
  metrics: [],
});
const parse = (value: string | null | undefined) => JSON.parse(value ?? "{}");

function assessmentHash(row: Row) {
  const retained: Row = {
    ...row,
    expectedFingerprint: row.evidenceFingerprint ?? row.expectedFingerprint,
    baseFingerprint: row.evidenceBaseFingerprint ?? row.baseFingerprint,
  };
  return createHash("sha256")
    .update(
      JSON.stringify(
        REVISION_FIELDS.map((field) => [field, retained[field] ?? null]),
      ),
    )
    .digest("hex");
}

export function verifyAssessmentRevision(row: Row) {
  if (row.schemaVersion == null && row.payloadHash == null) return;
  if (row.schemaVersion !== 1 || row.payloadHash !== assessmentHash(row))
    throw fail(
      409,
      "Retained assessment revision failed integrity verification",
    );
}

async function assessmentSource() {
  const row = await SELECT.one
    .from("tide.s4.DatasetInfo")
    .columns("asOf", "loadId", "loadedAt")
    .where({ ID: "current" });
  return {
    asOf: row?.asOf ?? null,
    loadId: row?.loadId ?? null,
    // Loader writes "+00:00"; CAP stores Timestamps as "...Z", so hash the stored form.
    loadedAt: row?.loadedAt ? new Date(row.loadedAt).toISOString() : null,
  };
}

export function planningSupport(rows: Row[], target: string, current: unknown) {
  const counts = new Map<string, number>();
  for (const row of rows)
    if (
      row[target] !== null &&
      row[target] !== undefined &&
      String(row[target]) !== ""
    ) {
      const value = String(row[target]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  const retained = [...counts.keys()];
  return {
    retained,
    counts: Object.fromEntries(counts),
    supported:
      retained.length >= 2 &&
      [...counts.values()].every((count) => count >= 5) &&
      rows.filter((row) => retained.includes(String(row[target]))).length >=
        30 &&
      retained.includes(String(current)),
  };
}

export function assessmentJSON(row: Row) {
  verifyAssessmentRevision(row);
  return JSON.stringify({
    assessmentID: row.assessmentID,
    status: row.status,
    source: row.source,
    generatedAt: row.generatedAt,
    summary: row.summary,
    metrics: parse(row.metrics),
    expectedFingerprint: row.expectedFingerprint,
    ...(row.schemaVersion == null
      ? {}
      : {
          evidenceRevision: {
            schemaVersion: row.schemaVersion,
            policyVersion: row.policyVersion,
            payloadHash: row.payloadHash,
            sourceAsOf: row.sourceAsOf,
            sourceLoadId: row.sourceLoadId,
            sourceLoadedAt: row.sourceLoadedAt,
            sourceRevision: row.sourceRevision,
            sourceFingerprint: row.sourceFingerprint,
            expectedFingerprint:
              row.evidenceFingerprint ?? row.expectedFingerprint,
            baseFingerprint: row.evidenceBaseFingerprint ?? row.baseFingerprint,
            runIDs: parse(row.runs),
          },
        }),
  });
}

export async function latestAssessment(caseID: string, fingerprint: string) {
  const applicability: Row[] = await SELECT.from(
    `${NS}.AssessmentApplicability`,
  ).where({ caseID, expectedFingerprint: fingerprint });
  const rebound = new Map(
    applicability.map((row) => [row.assessment_assessmentID, row]),
  );
  const query = SELECT.from(TABLE).where({ caseID });
  if (rebound.size)
    query.and`(expectedFingerprint = ${fingerprint} or assessmentID in ${[...rebound.keys()]})`;
  else query.and({ expectedFingerprint: fingerprint });
  const rows: Row[] = await query.orderBy(
    "generatedAt desc",
    "assessmentID desc",
  );
  const selected = rows.find((row) => row.status === "available") ?? rows[0];
  if (!selected) return undefined;
  verifyAssessmentRevision(selected);
  const binding = rebound.get(selected.assessmentID);
  return binding
    ? {
        ...selected,
        expectedFingerprint: binding.expectedFingerprint,
        baseFingerprint: binding.baseFingerprint,
        evidenceFingerprint: selected.expectedFingerprint,
        evidenceBaseFingerprint: selected.baseFingerprint,
      }
    : selected;
}

export async function scopedPlanningRows(
  plant: string | undefined,
  user: cds.User,
): Promise<Row[]> {
  const query = SELECT.from(`${NS}.CockpitPlanningFeed`);
  if (plant !== undefined) query.where({ Plant: plant });
  const rows: Row[] = await query;
  return rows.filter((entry) => inScope(scopeOf(user), entry));
}

async function planningEvidence(row: Row, user: cds.User): Promise<Evidence> {
  const materials = row.materialNumbers
    ? String(row.materialNumbers)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [String(row.Material)];
  const plant = row.Plant ?? row.mainPlant;
  if (!plant)
    return unavailable(
      "No case plant is available for scoped peer comparison",
      "unsupported",
    );
  const scoped = await scopedPlanningRows(plant, user);
  const candidates = scoped.filter((entry) =>
    materials.includes(entry.Material),
  );
  if (!candidates.length)
    return unavailable(
      "No imported planning rows for the case candidates",
      "unsupported",
    );
  const metrics: AssessmentMetric[] = [];
  let broaderPeers: Row[] | undefined;
  let model = false;
  let fallback = false;
  let testProvider = false;
  for (const candidate of candidates) {
    const peers = scoped.filter((entry) => !materials.includes(entry.Material));
    if (row.materialNumbers) {
      const activity: Row[] = await cds.tx(() =>
        SELECT.from(`${NS}.ItemFact`)
          .columns(
            "Supplier",
            "PurchaseOrder",
            "PurchaseOrderItem",
            "PurchasingGroup",
          )
          .where({ Material: candidate.Material, Plant: plant }),
      );
      const visibleActivity = activity.filter((entry) =>
        inScope(scopeOf(user), { ...entry, Plant: plant }),
      );
      const units: Row[] = await cds.tx(() =>
        SELECT.from("tide.s4.PurchaseOrderItem")
          .columns(
            "PurchaseOrder",
            "PurchaseOrderItem",
            "PurchaseOrderQuantityUnit",
          )
          .where({ Material: candidate.Material, Plant: plant }),
      );
      const visibleKeys = new Set(
        visibleActivity.map(
          (entry) => `${entry.PurchaseOrder}/${entry.PurchaseOrderItem}`,
        ),
      );
      metrics.push(
        metric(
          `${candidate.Material}: factual context`,
          null,
          {
            ...candidate,
            suppliers: [
              ...new Set(
                visibleActivity.map((entry) => entry.Supplier).filter(Boolean),
              ),
            ],
            orderUnits: [
              ...new Set(
                units
                  .filter((entry) =>
                    visibleKeys.has(
                      `${entry.PurchaseOrder}/${entry.PurchaseOrderItem}`,
                    ),
                  )
                  .map((entry) => entry.PurchaseOrderQuantityUnit)
                  .filter(Boolean),
              ),
            ],
            orderItems: visibleActivity.length,
          },
          "",
          "empirical",
          "Base unit and order units are separate. Differences remain factual conflicts; this is not duplicate probability.",
        ),
      );
    }
    for (const target of TARGETS) {
      const localSupport = planningSupport(peers, target, candidate[target]);
      let context = peers;
      if (!localSupport.supported) {
        broaderPeers ??= (await scopedPlanningRows(undefined, user)).filter(
          (entry) => !materials.includes(entry.Material),
        );
        context = broaderPeers;
      }
      const support = planningSupport(context, target, candidate[target]);
      if (!support.retained.length) {
        metrics.push(
          metric(
            `${candidate.Material}: ${target}`,
            candidate[target],
            null,
            "",
            "empirical",
            {
              status: "missing_labels",
              reason:
                "No historical values available for this field in authorized context",
              peerRows: context.length,
            },
          ),
        );
        continue;
      }
      try {
        const started = await callCore(user, "predict", {
          spec: {
            feed: "CockpitPlanningFeed",
            target,
            features: PLANNING_FEATURES,
            task: "classification",
            train: {
              filter: [
                {
                  col: "id",
                  op: "in",
                  values: context
                    .filter((entry) =>
                      support.retained.includes(String(entry[target])),
                    )
                    .map((entry) => entry.id),
                },
              ],
              exclude: [{ col: "Material", values: materials }],
            },
            predict: { keys: [candidate.id] },
            output: { type: "probas" },
          },
        });
        const run =
          started.status === "succeeded"
            ? started
            : await awaitRun(user, started.ID);
        const meter: Meter = {
          user,
          calls: 0,
          cost: 0,
          runs: [],
          planned: [],
          backend: null,
          failed: [],
        };
        meterRun(meter, run, started.status === "succeeded");
        if (run.status !== "succeeded") continue;
        const result = await cds.tx(() =>
          SELECT.one
            .from("tide.core.PredictionResult")
            .where({ run_ID: run.ID, rowKey: candidate.id }),
        );
        const probabilities = parse(result?.probabilities);
        const sorted = Object.entries(probabilities)
          .filter(
            ([value, probability]) =>
              support.retained.includes(value) && Number.isFinite(probability),
          )
          .sort((left, right) => Number(right[1]) - Number(left[1]));
        if (!sorted.length) continue;
        const source = predictionSource(run);
        if (source === "none") continue;
        model ||= source === "tabpfn";
        fallback ||= source === "fallback";
        testProvider ||= source === "fake";
        metrics.push(
          metric(
            `${candidate.Material}: ${target}`,
            candidate[target],
            sorted[0][0],
            "",
            source,
            {
              probabilities,
              retainedClasses: support.retained,
              peerRows: context.length,
              contextScope: localSupport.supported
                ? "same plant"
                : "authorized plants",
              lowSupport: !support.supported,
              warning:
                [
                  source === "fake"
                    ? "Test-provider output; not measured TabPFN evidence."
                    : null,
                  support.supported
                    ? null
                    : "Limited peer support; review the prediction before using it.",
                ]
                  .filter(Boolean)
                  .join(" ") || null,
              runID: run.ID,
              inputFingerprint: run.inputFingerprint,
              asOf: await cds.tx(() => asOfDate()),
              limitation:
                "Peer consistency, not optimal settings or duplicate probability. Plant-local planner IDs are retained verbatim; all suggestions require review.",
            },
          ),
        );
      } catch (error: any) {
        metrics.push(
          metric(
            `${candidate.Material}: ${target}`,
            candidate[target],
            null,
            "",
            "empirical",
            {
              status: "failed",
              reason: error.message,
              peerRows: context.length,
            },
          ),
        );
      }
    }
  }
  return {
    status: model || fallback || testProvider ? "available" : "insufficient",
    source: model
      ? "mixed"
      : fallback
        ? "fallback"
        : testProvider
          ? "fake"
          : "empirical",
    summary: row.materialNumbers
      ? "Candidate context and planning plausibility only; no duplicate probability or automatic merge."
      : "Planning-field peer consistency; recommendations require planner review, not automatic setting changes.",
    metrics,
  };
}

async function deliveryEvidence(
  row: Row,
  user: cds.User,
  independent: boolean,
): Promise<Evidence> {
  const Material = row.Material ?? row.material;
  const Plant = row.Plant ?? row.plant;
  const asOf = await cds.tx(() => asOfDate());
  const master = (await cds.tx(() => masters({ Material, Plant }))).get(
    `${Material}|${Plant}`,
  );
  if (
    !master ||
    ["40", "45"].includes(master.ProcurementSubType) ||
    master.ProcurementType === "E"
  )
    return unavailable(
      "No external purchasing delivery context for this imported material/plant",
      "unsupported",
    );
  const supplier = row.supplier ?? row.Supplier;
  const since = new Date(Date.parse(asOf) - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const activity: Row[] = await cds.tx(
    () =>
      SELECT.from(`${NS}.ItemFact`)
        .columns(
          "Supplier",
          "PurchaseOrder",
          "PurchaseOrderItem",
          "Plant",
          "PurchasingGroup",
        )
        .where({ Material, Plant })
        .and`PurchaseOrderDate >= ${since} and PurchaseOrderDate < ${asOf}`,
  );
  const items = activity.filter((item) => inScope(scopeOf(user), item));
  const suppliers = supplier
    ? [supplier]
    : [...new Set(items.map((item) => item.Supplier).filter(Boolean))];
  if (!suppliers.length)
    return unavailable(
      "No supplier purchasing history for this material/plant",
      "unsupported",
    );
  const meter: Meter = {
    user,
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  };
  const metrics: AssessmentMetric[] = [];
  const sources: Row[] = [];
  const ir = await cds.tx(() => infoRecords({ Material, Plant }));
  let anyModel = false;
  for (const Supplier of suppliers) {
    let range: Row;
    try {
      range = await leadTimeRange(
        { Material, Supplier, Plant },
        asOf,
        meter,
        false,
        "own",
        independent,
      );
    } catch (error: any) {
      sources.push({
        Supplier,
        orders: items.filter((item) => item.Supplier === Supplier).length,
        range: null,
      });
      metrics.push(
        metric(`${Supplier}: delivery range`, null, null, "days", "empirical", {
          status: "failed",
          reason: error.message,
        }),
      );
      continue;
    }
    const maintained =
      ir.get(`${Material}|${Supplier}|${Plant}`)?.MaterialPlannedDeliveryDurn ??
      null;
    const current = supplier
      ? maintained
      : master.PlannedDeliveryDurationInDays;
    sources.push({
      Supplier,
      orders: items.filter((item) => item.Supplier === Supplier).length,
      range,
    });
    anyModel ||= range.source === "tabpfn";
    metrics.push(
      metric(
        `${Supplier}: delivery P10/P50/P80/P90`,
        current,
        { p10: range.p10, p50: range.p50, p80: range.p80, p90: range.p90 },
        "days",
        range.source === "none" || range.source === "rule"
          ? "empirical"
          : range.source,
        {
          ...range,
          asOf,
          infoRecordDays: maintained,
          masterDays: master.PlannedDeliveryDurationInDays,
          independentSettingProfile: independent,
          recheck: independent && supplierSettingTrigger(current, range),
          proposalDays: row.proposedDays ?? null,
          limitation:
            "Latest locally imported SAP snapshot, not live SAP. Independent setting profile excludes PlannedDays and RequestedGapDays; proposals remain unchanged.",
        },
      ),
    );
    if (range.ownP50 !== null && range.ownP50 !== undefined)
      metrics.push(
        metric(
          `${Supplier}: observed delivery P10/P50/P80/P90`,
          current,
          {
            p10: range.ownP10,
            p50: range.ownP50,
            p80: range.ownP80,
            p90: range.ownP90,
          },
          "days",
          "empirical",
          { deliveries: range.n, asOf },
        ),
      );
  }
  if (independent && !supplier) {
    const comparison = materialSettingComparison(
      master.PlannedDeliveryDurationInDays,
      sources,
    );
    metrics.push(
      metric(
        "Order-share weighted supplier model medians",
        master.PlannedDeliveryDurationInDays,
        comparison.value,
        "days",
        // Covered only reads as tabpfn when every supplier range came from the model.
        comparison.covered &&
          sources.every((source) => source.range?.source === "tabpfn")
          ? "tabpfn"
          : comparison.covered &&
              sources.some((source) => source.range?.source === "fake")
            ? "fake"
            : comparison.covered &&
                sources.some((source) => source.range?.source === "fallback")
              ? "fallback"
              : "empirical",
        {
          ...comparison,
          sources,
          proposalDays: row.proposedDays ?? null,
          limitation:
            "Full supplier coverage required; no partial-share renormalization. Weighted medians are not an aggregate quantile distribution; existing proposal policy is unchanged.",
        },
      ),
    );
  }
  const available = sources.some((source) =>
    Number.isFinite(source.range?.p50),
  );
  return {
    status: available ? "available" : "insufficient",
    source: anyModel
      ? "mixed"
      : sources.some((source) => source.range?.source === "fallback")
        ? "fallback"
        : sources.some((source) => source.range?.source === "fake")
          ? "fake"
          : "empirical",
    summary: independent
      ? "Independent model recheck against imported SAP maintained values; unchanged proposal policy."
      : "Supplier-specific model ranges with separate observed delivery evidence.",
    metrics,
  };
}

async function priceEvidence(row: Row, user: cds.User): Promise<Evidence> {
  const detail = parse(row.detail);
  const asOf = await cds.tx(() => asOfDate());
  const all = await syncPriceModelRows();
  const candidate = all.find(
    (item) =>
      item.PurchaseOrder === row.PurchaseOrder &&
      item.PurchaseOrderItem === row.PurchaseOrderItem,
  );
  const model = candidate
    ? (
        await assessPriceCandidates(
          user,
          asOf,
          [candidate],
          undefined,
          all,
          true,
        )
      )[0]?.assessment
    : null;
  const metrics = [
    metric(
      "Historical normalized unit price",
      row.unitPrice,
      row.priorMedian,
      row.currency ?? "",
      "empirical",
      {
        priorCount: row.priorCount,
        factor: row.factor,
        ratio: row.ratio,
        proposalPrice: detail.proposalPrice,
        limitation: "Factor-slip comparison, not error probability.",
      },
    ),
  ];
  if (model)
    metrics.push(
      metric(
        "Expected unit price P10/P50/P90",
        model.actualUnitPrice,
        {
          p10: model.expectedP10,
          p50: model.expectedP50,
          p90: model.expectedP90,
        },
        row.currency ?? "",
        model.source,
        {
          ...model,
          limitation:
            "Strict historical cutoff and whole-PO exclusion; model tail position is not error probability.",
        },
      ),
    );
  return {
    status: model || row.priorCount > 0 ? "available" : "insufficient",
    source:
      model?.source === "tabpfn"
        ? "mixed"
        : model?.source === "fallback"
          ? "fallback"
          : "empirical",
    summary: model
      ? "Separate model and empirical price evidence; clarification only, no price update."
      : "Empirical price evidence retained; model assessment unavailable.",
    metrics,
  };
}

async function lateEvidence(
  row: Row,
  user: cds.User,
  lateDays: number,
): Promise<Evidence> {
  const result = await predictOrders(
    user,
    {
      target: "late_by_days",
      lateDays,
      filters: { material: row.Material, plant: row.Plant },
    },
    true,
  );
  const orders: Row[] = (result as any).scoredOrders ?? [];
  const source = (result as any).source;
  return {
    status: orders.length ? "available" : "insufficient",
    source: source === "none" ? "empirical" : source,
    summary: orders.length
      ? "Scoped per-order late probability; validation is diagnostic, not an inference gate."
      : "No eligible scored orders are available.",
    metrics: orders.map((order) =>
      metric(
        `${order.PurchaseOrder}/${order.PurchaseOrderItem}: more than ${lateDays} days late`,
        null,
        order.score,
        "probability",
        source,
        {
          ...order,
          lateDays,
          basis: "RequestedDate",
          eligible: result.openItems,
          scored: orders.length,
          validation: result.validation,
          runID: result.predictionRunID,
          limitation:
            "Known late outcomes are observed, not scored; missing requested dates excluded. Ranking validation does not establish probability calibration.",
        },
      ),
    ),
  };
}

export async function assessPrevention(
  caseID: string,
  user: cds.User,
  data: Row,
) {
  return modelWork(async () => {
    const header = await cds.tx(() =>
      SELECT.one.from(`${NS}.Cases`).where({ ID: caseID }),
    );
    if (!header || !inScope(scopeOf(user), header))
      throw fail(404, "Case not found");
    if (header.status !== "open") throw fail(409, "Case is closed");
    if (!data.expectedFingerprint)
      throw fail(400, "expectedFingerprint is required");
    if (data.expectedFingerprint !== header.sourceFingerprint)
      throw fail(409, "Case evidence has changed; reload before assessing");
    const source = await cds.tx(() => assessmentSource());
    const asOf = source.asOf;
    if (!asOf) throw fail(409, "No imported dataset is available");
    const selected = data.metric || "overview";
    const allowedMetrics: Record<string, string[]> = {
      price: ["overview"],
      duplicate: ["overview", "planning"],
      unusual_setting: ["overview", "delivery", "late", "planning"],
      supplier_planned_time: ["overview", "delivery"],
      material_planned_time: ["overview", "delivery"],
    };
    if (!allowedMetrics[header.kind]?.includes(selected))
      throw fail(400, "Assessment metric is not supported for this case type");
    const lateDays = data.lateDays ?? 1;
    if (!Number.isInteger(lateDays) || lateDays < 1 || lateDays > 60)
      throw fail(400, "lateDays must be a whole number from 1 to 60");
    const row = await cds.tx(() =>
      SELECT.one
        .from(`${NS}.${CASE_ENTITIES[header.kind]}`)
        .where({ header_ID: caseID }),
    );
    if (!row) throw fail(404, "Typed case detail not found");
    const previous = await cds.tx(() =>
      latestAssessment(caseID, header.sourceFingerprint),
    );
    let evidence: Evidence;
    try {
      if (header.kind === "price" && selected === "overview")
        evidence = await priceEvidence(row, user);
      else if (header.kind === "unusual_setting" && selected === "overview") {
        const sections: Evidence[] = [];
        for (const [label, assess] of [
          ["Planning fields", () => planningEvidence(row, user)],
          ["Delivery-time ranges", () => deliveryEvidence(row, user, false)],
          [
            "Late-delivery probabilities",
            () => lateEvidence(row, user, lateDays),
          ],
        ] as const) {
          try {
            const section = await assess();
            const metrics = section.metrics.length
              ? section.metrics
              : [
                  metric(label, null, null, "", section.source, {
                    status: section.status,
                    reason: section.summary,
                  }),
                ];
            sections.push({
              ...section,
              metrics: metrics.map((entry) => ({
                ...entry,
                detail: {
                  ...(typeof entry.detail === "object" ? entry.detail : {}),
                  assessmentSection: label,
                },
              })),
            });
          } catch (error: any) {
            sections.push({
              ...unavailable(`${label}: ${error.message}`, "failed"),
              metrics: [
                metric(label, null, null, "", "empirical", {
                  status: "failed",
                  reason: error.message,
                  assessmentSection: label,
                }),
              ],
            });
          }
        }
        evidence = {
          status: sections.some((section) => section.status === "available")
            ? "available"
            : "insufficient",
          source: sections.some((section) =>
            ["mixed", "tabpfn"].includes(section.source),
          )
            ? "mixed"
            : sections.some((section) => section.source === "fallback")
              ? "fallback"
              : "empirical",
          summary:
            "Planning-field suggestions, supplier delivery ranges and requested-date late probabilities. Unavailable metrics are shown separately; all recommendations require review.",
          metrics: sections.flatMap((section) => section.metrics),
        };
      } else if (
        ["duplicate", "unusual_setting"].includes(header.kind) &&
        ["overview", "planning"].includes(selected)
      )
        evidence = await planningEvidence(row, user);
      else if (header.kind === "unusual_setting" && selected === "late")
        evidence = await lateEvidence(row, user, lateDays);
      else if (
        selected === "delivery" ||
        (["supplier_planned_time", "material_planned_time"].includes(
          header.kind,
        ) &&
          selected === "overview")
      )
        evidence = await deliveryEvidence(
          row,
          user,
          header.kind !== "unusual_setting",
        );
      else
        evidence = unavailable(
          "This metric is not supported for this case type",
          "unsupported",
        );
    } catch (error: any) {
      evidence = unavailable(
        `Assessment unavailable: ${error.message}`,
        "failed",
      );
    }
    const assessmentID = cds.utils.uuid();
    const baseFingerprint =
      previous?.baseFingerprint ?? header.sourceFingerprint;
    const expectedFingerprint =
      evidence.status === "available"
        ? createHash("sha256")
            .update(JSON.stringify({ baseFingerprint, assessmentID, evidence }))
            .digest("hex")
        : header.sourceFingerprint;
    const runIDs = [
      ...new Set(
        evidence.metrics.flatMap((entry) => {
          const detail = entry.detail as Row | null;
          return [detail?.runID, detail?.modelRunID, detail?.run_ID].filter(
            (ID): ID is string => typeof ID === "string",
          );
        }),
      ),
    ].sort();
    const record: Row = {
      assessmentID,
      caseID,
      metric: selected,
      generatedAt: new Date().toISOString(),
      ...evidence,
      metrics: JSON.stringify(evidence.metrics),
      expectedFingerprint,
      baseFingerprint,
      schemaVersion: 1,
      policyVersion: `prevention:${header.kind}:${selected}:v1`,
      sourceAsOf: asOf,
      sourceLoadId: source.loadId,
      sourceLoadedAt: source.loadedAt,
      sourceRevision: header.sourceRevision ?? null,
      sourceFingerprint: header.sourceFingerprint,
      run_ID: runIDs.length === 1 ? runIDs[0] : null,
      runs: JSON.stringify(runIDs),
    };
    record.payloadHash = assessmentHash(record);
    await cds.tx(async () => {
      const current = await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: caseID });
      if (
        !current ||
        !inScope(scopeOf(user), current) ||
        current.status !== "open" ||
        current.sourceFingerprint !== header.sourceFingerprint
      )
        throw fail(409, "Case evidence changed while assessing; reload");
      await INSERT.into(TABLE).entries(record);
      if (JSON.stringify(await assessmentSource()) !== JSON.stringify(source))
        throw fail(409, "Imported source changed while assessing; reload");
      if (expectedFingerprint !== header.sourceFingerprint)
        await recordSourceChange(
          caseID,
          Number(current.sourceRevision ?? 1) + 1,
          expectedFingerprint,
        );
    });
    return {
      assessmentID: record.assessmentID,
      status: record.status,
      source: record.source,
      generatedAt: record.generatedAt,
      summary: record.summary,
      metrics: record.metrics,
      expectedFingerprint: record.expectedFingerprint,
    };
  });
}
