import type { ActionKind, ExportFormat, FindingList, OperationKey } from "./types";

export const deliveryProblemKey = (po: unknown, item: unknown) => `delivery:${String(po)}/${String(item)}`;

export function findingProblemKey(f: Record<string, any>): string {
  if (f.problemKey) return String(f.problemKey);
  if (["at_risk", "overdue"].includes(f.list) && f.PurchaseOrder && f.PurchaseOrderItem)
    return deliveryProblemKey(f.PurchaseOrder, f.PurchaseOrderItem);
  if (f.list === "pdt" || f.list === "mm_pdt") {
    const detail = f.list === "mm_pdt" ? f.mmPdtDetail ?? {} : f.pdtDetail ?? {};
    const field = f.list === "mm_pdt" || detail.currentFrom === "material master"
      ? "PlannedDeliveryDurationInDays"
      : "MaterialPlannedDeliveryDurn";
    const record = f.list === "mm_pdt" ? `${f.Material}|${f.Plant}` : detail.purchasingInfoRecord ?? f.objectKey;
    return `master-data:${record}:${field}`;
  }
  if (f.list === "freetext" && f.PurchaseRequisition)
    return `requisition:${f.PurchaseRequisition}/${f.PurchaseRequisitionItem ?? ""}`;
  return `${String(f.list ?? "business")}:${String(f.objectKey)}`;
}

export function operationForFinding(list: FindingList): OperationKey {
  switch (list) {
    case "at_risk": return "delivery_intervention";
    case "overdue": return "delivery_escalation";
    case "pdt":
    case "mm_pdt": return "pdt_change";
    case "price": return "price_clarification";
    case "duplicate": return "master_data_duplicate_review";
    case "rare": return "planner_review";
    case "freetext": return "requisition_review";
  }
}

export function defaultOperation(kind: ActionKind): OperationKey {
  const operations: Record<ActionKind, OperationKey> = {
    reminder: "delivery_intervention",
    pdt_change: "pdt_change",
    worklist: "prediction_worklist",
    code_list: "code_list",
    pr_review: "requisition_review",
    post_confirmation: "post_confirmation",
    price_check: "price_check",
    price_clarification: "price_clarification",
    mdg_case: "master_data_duplicate_review",
    planner_review: "planner_review",
  };
  return operations[kind];
}

export const exportFormatFor = (kind: ActionKind): ExportFormat => kind === "reminder" ? "reminder" : "csv";
