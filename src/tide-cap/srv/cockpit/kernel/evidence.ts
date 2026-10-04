import { createHash } from "node:crypto";
import type { Row } from "./model-calls";

/** Allowlisted business evidence; persistence and presentation never enter the hash. */
const fields: Record<string, readonly string[]> = {
  at_risk: ["gapDays", "plannedDays", "ruleVerdict"],
  overdue: ["PurchaseOrderDate", "OpenQuantity", "OrderQuantity"],
  price: [
    "unitPrice",
    "currentPrice",
    "priceQuantity",
    "priorMedian",
    "priorCount",
    "ratio",
    "factor",
    "currency",
    "priceKey",
    "proposalPrice",
  ],
  duplicate: [
    "groupKey",
    "candidateCount",
    "materialType",
    "materialNumbers",
    "mainPlant",
    "purchasingGroup",
  ],
  rare: ["groupSize", "materialType", "unusualPairCount", "firstPair", "pairs"],
  pdt: [
    "currentDays",
    "currentFrom",
    "proposalDays",
    "purchasingInfoRecord",
    "PurchasingInfoRecord",
    "ownDeliveries",
    "p10",
    "p50",
    "p80",
    "p90",
    "proposalQuantile",
    "settingRecheck",
    "settingRange",
  ],
  mm_pdt: [
    "masterDays",
    "proposalDays",
    "masterFlag",
    "difference",
    "tolerance",
    "orders12m",
    "sources",
    "settingComparison",
  ],
};
const detailNames: Record<string, string> = {
  at_risk: "atRiskDetail",
  overdue: "overdueDetail",
  price: "priceDetail",
  duplicate: "duplicateDetail",
  rare: "rareDetail",
  pdt: "pdtDetail",
  mm_pdt: "mmPdtDetail",
};

function canonical(value: any): any {
  if (Array.isArray(value))
    return value
      .map(canonical)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(
          (key) =>
            !/^(ID|finding_ID|finding_finding_ID|rank|source|sourceText|note|text|title|runID|snapshot_ID|createdAt|modifiedAt|generatedAt)$/.test(
              key,
            ),
        )
        .map((key) => [key, canonical(value[key])]),
    );
  return value ?? null;
}

export function businessEvidence(row: Row): Row {
  const detail = row[detailNames[row.list]] ?? {};
  return {
    list: row.list,
    objectKey: row.objectKey,
    PurchaseOrder: row.PurchaseOrder ?? null,
    PurchaseOrderItem: row.PurchaseOrderItem ?? null,
    Material: row.Material ?? null,
    Supplier: row.Supplier ?? null,
    Plant: row.Plant ?? null,
    PurchasingGroup: row.PurchasingGroup ?? null,
    dueDate: row.dueDate ?? null,
    detail: Object.fromEntries(
      (fields[row.list] ?? []).map((key) => [key, canonical(detail[key])]),
    ),
  };
}

export function evidenceFingerprint(row: Row): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(businessEvidence(row))))
    .digest("hex");
}
