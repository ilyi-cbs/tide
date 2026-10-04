import cds from "@sap/cds";
import {
  ensureCase,
  recordSourceChange,
  reopenCase,
  setListing,
} from "./cases";
import { evidenceFingerprint } from "./evidence";
import { upsertDeliveryRisk } from "./delivery-risks";
import { NS } from "./model-calls";
import type { FindingRow } from "./types";

const { SELECT, UPSERT } = cds.ql;
const LISTS = [
  "at_risk",
  "overdue",
  "price",
  "duplicate",
  "rare",
  "pdt",
  "mm_pdt",
] as const;
type TypedList = (typeof LISTS)[number];

const config: Record<
  Exclude<TypedList, "at_risk" | "overdue">,
  { kind: string; entity: string; detail: string }
> = {
  price: { kind: "price", entity: "PriceDeviations", detail: "priceDetail" },
  duplicate: {
    kind: "duplicate",
    entity: "DuplicateMaterials",
    detail: "duplicateDetail",
  },
  rare: {
    kind: "unusual_setting",
    entity: "UnusualSettings",
    detail: "rareDetail",
  },
  pdt: {
    kind: "supplier_planned_time",
    entity: "SupplierPlannedTimes",
    detail: "pdtDetail",
  },
  mm_pdt: {
    kind: "material_planned_time",
    entity: "MaterialPlannedTimes",
    detail: "mmPdtDetail",
  },
};

export function isTypedCaseFinding(
  row: FindingRow,
): row is FindingRow & { list: TypedList } {
  return (LISTS as readonly string[]).includes(row.list);
}

export function supplierSetting(header: any, detail: any) {
  const materialMaster = detail.currentFrom === "material master";
  const record = detail.purchasingInfoRecord ?? detail.PurchasingInfoRecord;
  const days = detail.currentDays;
  if (
    !header.Material ||
    !header.Supplier ||
    !header.Plant ||
    days == null ||
    days === "" ||
    typeof days === "boolean" ||
    !Number.isFinite(Number(days)) ||
    (!materialMaster && !record)
  )
    return null;
  return JSON.stringify({
    Material: header.Material,
    Supplier: header.Supplier,
    Plant: header.Plant,
    target: materialMaster ? "MaterialPlant" : "PurchasingInfoRecordPlant",
    record: materialMaster ? null : record,
    organization: detail.PurchasingOrganization ?? null,
    category: detail.PurchasingInfoRecordCategory ?? null,
    days: Number(days),
  });
}

export function materialSetting(header: any, detail: any) {
  const days = detail.masterDays;
  if (
    !header.Material ||
    !header.Plant ||
    days == null ||
    (typeof days === "string" && !days.trim()) ||
    typeof days === "boolean" ||
    !Number.isFinite(Number(days))
  )
    return null;
  return JSON.stringify({
    Material: header.Material,
    Plant: header.Plant,
    days: Number(days),
  });
}

export async function upsertTypedCase(row: FindingRow) {
  if (!isTypedCaseFinding(row)) return null;
  if (row.list === "at_risk" || row.list === "overdue")
    return upsertDeliveryRisk(row, row.list);
  const c = config[row.list];
  const ID = `${row.list}:${row.objectKey}`;
  const detail = (row as any)[c.detail] ?? {};
  if (row.list === "pdt")
    detail.purchasingInfoRecord ??= detail.PurchasingInfoRecord;
  const baseFingerprint = evidenceFingerprint(row);
  const existing = await SELECT.one.from(`${NS}.Cases`).where({ ID });
  const retained =
    existing &&
    (await SELECT.one
      .from(`${NS}.PreventionAssessment`)
      .where({
        caseID: ID,
        baseFingerprint,
        expectedFingerprint: existing.sourceFingerprint,
        status: "available",
      })
      .orderBy("generatedAt desc"));
  const fingerprint = retained?.expectedFingerprint ?? baseFingerprint;
  let materialChange = true;
  if (
    row.list === "pdt" &&
    ["exception_accepted", "resolved_at_source"].includes(existing?.closure)
  ) {
    const previous = await SELECT.one
      .from(`${NS}.SupplierPlannedTimes`)
      .where({ header_ID: ID });
    const previousDetail = previous ? JSON.parse(previous.detail ?? "{}") : {};
    const before =
      existing.closure === "resolved_at_source"
        ? (existing.resolvedSourceCondition ?? null)
        : (existing.acceptedSourceCondition ??
          (previous
            ? supplierSetting(
                {
                  Material: previous.Material,
                  Supplier: previous.supplier,
                  Plant: previous.Plant,
                },
                previousDetail,
              )
            : null));
    const after = supplierSetting(row, detail);
    materialChange = before !== null && after !== null && before !== after;
  }
  if (
    row.list === "mm_pdt" &&
    ["exception_accepted", "resolved_at_source"].includes(existing?.closure)
  ) {
    const previous = await SELECT.one
      .from(`${NS}.MaterialPlannedTimes`)
      .where({ header_ID: ID });
    const before =
      existing.closure === "resolved_at_source"
        ? (existing.resolvedSourceCondition ?? null)
        : (existing.acceptedSourceCondition ??
          (previous
            ? materialSetting(
                { Material: previous.material, Plant: previous.plant },
                { masterDays: previous.currentDays },
              )
            : null));
    const after = materialSetting(row, detail);
    materialChange = before !== null && after !== null && before !== after;
  }
  if (
    existing?.status === "closed" &&
    materialChange &&
    existing.sourceFingerprint !== fingerprint &&
    ["exception_accepted", "resolved_at_source", "action_completed"].includes(
      existing.closure,
    )
  )
    await reopenCase(
      ID,
      "Current evidence differs from the evidence that closed this case.",
    );
  await ensureCase({
    ID,
    kind: c.kind,
    Plant: row.Plant ?? null,
    PurchasingGroup: row.PurchasingGroup ?? null,
    title: row.itemTitle ?? row.objectKey,
    priority: row.rank ?? null,
    dueDate: row.dueDate ?? null,
    sourceRevision: existing?.sourceRevision ?? 1,
    sourceFingerprint: fingerprint,
  });
  if (existing && existing.sourceFingerprint !== fingerprint)
    await recordSourceChange(
      ID,
      Number(existing.sourceRevision ?? 1) + 1,
      fingerprint,
    );
  const common = {
    header_ID: ID,
    detail: JSON.stringify({
      ...detail,
      issue: row.issue ?? null,
      source: row.source ?? null,
    }),
  };
  if (row.list === "price")
    await UPSERT.into(`${NS}.${c.entity}`).entries({
      ...common,
      PurchaseOrder: row.PurchaseOrder,
      PurchaseOrderItem: row.PurchaseOrderItem,
      Material: row.Material,
      Supplier: row.Supplier,
      Plant: row.Plant,
      PurchasingGroup: row.PurchasingGroup,
      unitPrice: detail.unitPrice,
      priorCount: detail.priorCount,
      currentPrice: detail.currentPrice,
      priorMedian: detail.priorMedian,
      ratio: detail.ratio,
      factor: detail.factor,
      potentialDifference: detail.potentialDifference,
      currency: detail.currency,
    });
  if (row.list === "duplicate")
    await UPSERT.into(`${NS}.${c.entity}`).entries({
      ...common,
      Material: row.Material,
      Plant: row.Plant,
      groupKey: detail.groupKey,
      activity: detail.activity,
      candidateCount: detail.candidateCount,
      materialType: detail.materialType,
      materialNumbers: detail.materialNumbers,
      mainPlant: detail.mainPlant,
      PurchasingGroup: detail.purchasingGroup,
    });
  if (row.list === "rare")
    await UPSERT.into(`${NS}.${c.entity}`).entries({
      ...common,
      Material: row.Material,
      Plant: row.Plant,
      MRPController: row.MRPController,
      groupSize: detail.groupSize,
      materialType: detail.materialType,
      unusualPairCount: detail.unusualPairCount,
      summary: detail.firstPair,
    });
  if (row.list === "pdt")
    await UPSERT.into(`${NS}.${c.entity}`).entries({
      ...common,
      Material: row.Material,
      Plant: row.Plant,
      supplier: row.Supplier,
      purchasingInfoRecord: detail.purchasingInfoRecord,
      currentDays: detail.currentDays,
      proposedDays: detail.proposalDays,
      p50: detail.p50,
      ownDeliveries: detail.ownDeliveries,
      value12mEUR: detail.value12mEUR,
      proposalRule: detail.proposalRule,
    });
  if (row.list === "mm_pdt")
    await UPSERT.into(`${NS}.${c.entity}`).entries({
      ...common,
      material: row.Material,
      plant: row.Plant,
      MRPController: row.MRPController,
      currentDays: detail.masterDays,
      proposedDays: detail.proposalDays,
      masterFlag: detail.masterFlag,
      orders12m: detail.orders12m,
      difference: detail.difference,
      tolerance: detail.tolerance,
    });
  if ((await SELECT.one.from(`${NS}.Cases`).where({ ID })).status === "open")
    await setListing(ID, "listed");
  return ID;
}

export async function unlistAbsentTypedCases(
  lists: string[],
  ids: Set<string>,
) {
  const kinds = lists
    .filter((list): list is Exclude<TypedList, "at_risk" | "overdue"> =>
      (Object.keys(config) as string[]).includes(list),
    )
    .map((list) => config[list].kind);
  if (!kinds.length) return;
  const rows: Array<{ ID: string }> = await SELECT.from(`${NS}.Cases`).columns(
    "ID",
  ).where`kind in ${kinds} and status = 'open' and listing = 'listed'`;
  for (const row of rows)
    if (!ids.has(row.ID)) await setListing(row.ID, "unlisted");
}

/** Idempotent deployment/repair backfill from retained v3 current rows. */
export async function backfillTypedCases() {
  const rows: FindingRow[] = await SELECT.from(`${NS}.Finding`)
    .where`status = 'open' and list in ${[...LISTS]}`;
  for (const row of rows) {
    const caseID = `${row.list}:${row.objectKey}`;
    // Prepared demo snapshots already contain their canonical typed case rows
    // and attached assessments. Startup backfill is for missing legacy cases;
    // rebuilding present rows here would replace the assessed case fingerprint
    // with a projection-derived fingerprint and make restored evidence appear
    // stale immediately after reset.
    if (await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID })) continue;
    if (row.list === "at_risk" || row.list === "overdue") {
      const detailName =
        row.list === "at_risk" ? "AtRiskDetail" : "OverdueDetail";
      (row as any)[row.list === "at_risk" ? "atRiskDetail" : "overdueDetail"] =
        await SELECT.one
          .from(`${NS}.${detailName}`)
          .where({ finding_ID: row.ID });
      await upsertTypedCase(row);
      continue;
    }
    const detailName =
      config[row.list as Exclude<TypedList, "at_risk" | "overdue">].detail;
    (row as any)[detailName] = await SELECT.one
      .from(
        `${NS}.${detailName === "priceDetail" ? "PriceDetail" : detailName === "duplicateDetail" ? "DuplicateDetail" : detailName === "rareDetail" ? "RareDetail" : detailName === "pdtDetail" ? "PdtDetail" : "MmPdtDetail"}`,
      )
      .where({ finding_ID: row.ID });
    await upsertTypedCase(row);
  }
}

/**
 * Startup migrations can normalize legacy typed case rows immediately after a
 * prepared snapshot is restored. Reattach that snapshot's assessment payloads
 * to the resulting current case fingerprints so they remain visible on the
 * read-only worklists. Subsequent live case changes still use the normal stale
 * fingerprint checks.
 */
export async function relinkPreparedAssessments() {
  const info = await SELECT.one
    .from("tide.s4.DatasetInfo")
    .columns("source", "asOf")
    .where({ ID: "current" });
  if (info?.source !== "synthetic" || !info.asOf) return 0;
  const assessments: Array<{
    assessmentID: string;
    caseID: string;
    expectedFingerprint: string;
  }> = await SELECT.from(`${NS}.PreventionAssessment`)
    .columns("assessmentID", "caseID", "expectedFingerprint")
    .where({ status: "available" });
  if (!assessments.length) return 0;
  const cases: Array<{ ID: string; sourceFingerprint: string }> =
    await SELECT.from(`${NS}.Cases`)
      .columns("ID", "sourceFingerprint")
      .where({
        ID: { in: [...new Set(assessments.map((row) => row.caseID))] },
      });
  const fingerprintByID = new Map(
    cases.map((row) => [row.ID, row.sourceFingerprint]),
  );
  let relinked = 0;
  await cds.tx(async () => {
    for (const assessment of assessments) {
      const current = fingerprintByID.get(assessment.caseID);
      if (current && current !== assessment.expectedFingerprint) {
        const existing = await SELECT.one
          .from(`${NS}.AssessmentApplicability`)
          .where({ assessment_assessmentID: assessment.assessmentID });
        if (existing?.expectedFingerprint === current) continue;
        await cds.ql.UPSERT.into(`${NS}.AssessmentApplicability`).entries({
          assessment_assessmentID: assessment.assessmentID,
          caseID: assessment.caseID,
          expectedFingerprint: current,
          baseFingerprint: current,
        });
        relinked++;
      }
    }
  });
  return relinked;
}
