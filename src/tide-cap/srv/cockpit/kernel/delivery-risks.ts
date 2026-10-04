import cds from "@sap/cds";
import { ensureCase, recordSourceChange, reopenCase, setListing } from "./cases";
import { evidenceFingerprint } from "./evidence";
import { NS } from "./model-calls";
import { asOfDate } from "./asof";
import { deliveryWorkPriority, PRIORITY_ORDER } from "../impact/domain/priority";
import { daysBetween } from "./calendar";

const { SELECT, INSERT, UPSERT } = cds.ql;

type DeliveryFinding = Record<string, any>;


/**
 * Compatibility writer while delivery list pages still read Finding. It projects
 * the same detector result into the v4 case header and typed current row.
 */
export async function upsertDeliveryRisk(row: DeliveryFinding, phase: "at_risk" | "overdue") {
  const PurchaseOrder = String(row.PurchaseOrder ?? "");
  const PurchaseOrderItem = String(row.PurchaseOrderItem ?? "");
  if (!PurchaseOrder || !PurchaseOrderItem) throw new Error("Delivery risk requires a purchase order item");
  const ID = `delivery:${PurchaseOrder}/${PurchaseOrderItem}`;
  const fingerprint = evidenceFingerprint({ ...row, list: phase, objectKey: `${PurchaseOrder}/${PurchaseOrderItem}` });
  const prior = await SELECT.one.from(`${NS}.Cases`).where({ ID });
  const currentImpact = await SELECT.one.from(`${NS}.ItemImpact`)
    .columns("expectedDate", "arrivalSource", "revenueAtRisk", "level", "needDate")
    .where({ PurchaseOrder, PurchaseOrderItem });
  const asOf = await asOfDate();
  const overdueDays = phase === "overdue" && row.dueDate && asOf
    ? Math.max(0, -daysBetween(String(row.dueDate), asOf))
    : null;
  const forecast = currentImpact?.expectedDate ?? row.predictedArrival ?? null;
  const forecastDelayDays = forecast && row.dueDate
    ? Math.max(0, daysBetween(String(row.dueDate), String(forecast)))
    : null;
  const priority = PRIORITY_ORDER[deliveryWorkPriority({
    phase,
    forecastDelayDays,
    daysOverdue: overdueDays,
    impactLevel: currentImpact?.level ?? null,
    needDate: currentImpact?.needDate ?? null,
    attention: prior?.attention ?? null,
    asOf: asOf ?? String(row.dueDate ?? forecast ?? "1970-01-01"),
  })];
  const revision = prior?.sourceFingerprint && prior.sourceFingerprint !== fingerprint
    ? Number(prior.sourceRevision ?? 1) + 1
    : Number(prior?.sourceRevision ?? 1);
  await ensureCase({
    ID,
    kind: "delivery",
    Plant: row.Plant ?? null,
    PurchasingGroup: row.PurchasingGroup ?? null,
    title: row.itemTitle ?? `${PurchaseOrder}/${PurchaseOrderItem}`,
    // Delivery cases always use the canonical impact priority (0=Critical...3=Low).
    priority,
    dueDate: row.dueDate ?? null,
    sourceRevision: revision,
    sourceFingerprint: fingerprint,
  });
  const previousRisk = await SELECT.one.from(`${NS}.DeliveryRisks`).where({ header_ID: ID });
  if (prior && prior.sourceFingerprint !== fingerprint) {
    if (prior.status === "closed" && ["exception_accepted", "resolved_at_source", "action_completed"].includes(prior.closure))
      await reopenCase(ID, "The delivery obligation evidence changed.");
    await recordSourceChange(ID, revision, fingerprint);
  }
  if (previousRisk && previousRisk.phase !== phase) {
    await INSERT.into(`${NS}.CaseEvents`).entries({
      ID: cds.utils.uuid(), header_ID: ID, occurredAt: new Date().toISOString(), event: "delivery_phase_changed",
      sourceRevision: revision, sourceFingerprint: fingerprint, actor: cds.context?.user?.id ?? null,
      reason: `${previousRisk.phase} -> ${phase}`,
    });
  }
  await UPSERT.into(`${NS}.DeliveryRisks`).entries({
    header_ID: ID,
    PurchaseOrder,
    PurchaseOrderItem,
    phase,
    Material: row.Material ?? null,
    Supplier: row.Supplier ?? null,
    Plant: row.Plant ?? null,
    PurchasingGroup: row.PurchasingGroup ?? null,
    dueDate: row.dueDate ?? null,
    predictedArrival: currentImpact?.expectedDate ?? row.predictedArrival ?? null,
    arrivalSource: currentImpact?.arrivalSource ?? row.arrivalSource ?? null,
    revenueAtRisk: currentImpact?.revenueAtRisk ?? row.revenueAtRisk ?? null,
    nextActionKind: row.nextActionKind ?? "reminder",
    source: row.source ?? "rule",
    sourceFingerprint: fingerprint,
    detail: JSON.stringify(phase === "at_risk" ? row.atRiskDetail ?? {} : row.overdueDetail ?? {}),
  });
  if ((await SELECT.one.from(`${NS}.Cases`).where({ ID })).status === "open") await setListing(ID, "listed");
  return ID;
}

/** A detector can hide an open case without changing its business lifecycle. */
export async function unlistDeliveryCasesExcept(caseIDs: Set<string>) {
  const rows: Array<{ ID: string }> = await SELECT.from(`${NS}.Cases`).columns("ID").where({ kind: "delivery", status: "open", listing: "listed" });
  for (const row of rows) if (!caseIDs.has(row.ID)) await setListing(row.ID, "unlisted");
}
