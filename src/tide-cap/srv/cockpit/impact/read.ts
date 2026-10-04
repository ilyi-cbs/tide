import cds from "@sap/cds";
import { impactText } from "../kernel/findings";
import { NS, type Row } from "../kernel/model-calls";

const { SELECT } = cds.ql;

function list(value: unknown): Row[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((row) => row && typeof row === "object")
      : [];
  } catch {
    return [];
  }
}

export async function readBusinessImpact(caseID: string) {
  const delivery: Row | undefined = await SELECT.one
    .from(`${NS}.DeliveryRisks`)
    .columns("PurchaseOrder", "PurchaseOrderItem")
    .where({ header_ID: caseID });
  if (!delivery) return null;

  const key = {
    PurchaseOrder: delivery.PurchaseOrder,
    PurchaseOrderItem: delivery.PurchaseOrderItem,
  };
  const [impact, salesOrders, productionOrders] = await Promise.all([
    SELECT.one
      .from(`${NS}.ItemImpact`)
      .columns(
        "level",
        "impactLevelText",
        "materialKind",
        "impactKindText",
        "kindNote",
        "expectedDate",
        "cautiousDate",
        "confirmedDate",
        "arrivalSource",
        "needDate",
        "delayDays",
        "customerDelayDays",
        "revenueAtRisk",
        "revenueCautious",
        "shortageFrom",
        "shortageDays",
        "coverageDays",
        "stock",
        "note",
        "scenarios",
        "md04",
      )
      .where(key),
    SELECT.from(`${NS}.SalesOrderImpact`)
      .columns(
        "SalesOrder",
        "SalesOrderItem",
        "Customer",
        "CustomerName",
        "RequiredDate",
        "PredictedDelayDays",
        "RevenueAtRisk",
        "Currency",
      )
      .where(key)
      .orderBy("RequiredDate", "SalesOrder", "SalesOrderItem"),
    SELECT.from(`${NS}.ProductionOrderImpact`)
      .columns(
        "ProductionOrder",
        "FinishedProduct",
        "RequiredDate",
        "PredictedShortageDays",
        "AffectedQuantity",
        "Unit",
      )
      .where(key)
      .orderBy("RequiredDate", "ProductionOrder"),
  ]);

  return {
    ...key,
    level: impact?.level ?? null,
    impactLevelText: impact
      ? (impact.impactLevelText ?? impactText(impact.level, null))
      : null,
    materialKind: impact?.materialKind ?? null,
    impactKindText: impact?.impactKindText ?? null,
    kindNote: impact?.kindNote ?? null,
    expectedDate: impact?.expectedDate ?? null,
    cautiousDate: impact?.cautiousDate ?? null,
    confirmedDate: impact?.confirmedDate ?? null,
    arrivalSource: impact?.arrivalSource ?? null,
    needDate: impact?.needDate ?? null,
    delayDays: impact?.delayDays ?? null,
    customerDelayDays: impact?.customerDelayDays ?? null,
    revenueAtRisk: impact?.revenueAtRisk ?? null,
    revenueCautious: impact?.revenueCautious ?? null,
    shortageFrom: impact?.shortageFrom ?? null,
    shortageDays: impact?.shortageDays ?? null,
    coverageDays: impact?.coverageDays ?? null,
    stock: impact?.stock ?? null,
    note: impact?.note ?? null,
    salesOrders,
    productionOrders,
    scenarios: list(impact?.scenarios),
    planningRows: list(impact?.md04),
  };
}
