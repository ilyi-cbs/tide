// Detector-facing typed write boundary. The Finding rows remain a read-only
// compatibility projection while MCP and Fiori consumers complete their move.
import { resolveFromSource } from "./cases";
import {
  unlistDeliveryCasesExcept,
  upsertDeliveryRisk,
} from "./delivery-risks";
import {
  closeFindingProjection,
  findingID,
  upsertFinding,
  writeFindings,
} from "./findings";
import { unlistAbsentTypedCases, upsertTypedCase } from "./typed-cases";
import type { FindingList, FindingRow } from "./types";

function caseID(row: FindingRow): string {
  if (row.list === "at_risk" || row.list === "overdue")
    return `delivery:${row.PurchaseOrder}/${row.PurchaseOrderItem}`;
  return findingID(row.list, row.objectKey);
}

async function upsertTyped(row: FindingRow) {
  if (row.list === "at_risk" || row.list === "overdue")
    return upsertDeliveryRisk(row, row.list);
  return upsertTypedCase(row);
}

/** Upserts one typed case, then refreshes the retained legacy read projection. */
export async function upsertDetectorCase(row: FindingRow) {
  await upsertTyped(row);
  return upsertFinding(row, { projectOnly: true });
}

/** Reconciles a detector batch in typed roots before refreshing legacy reads. */
export async function replaceDetectorCases(
  snapshotId: string,
  lists: FindingList[],
  rows: FindingRow[],
) {
  for (const row of rows) await upsertTyped(row);
  const ids = new Set(rows.map(caseID));
  const deliveryIDs = new Set(
    [...ids].filter((ID) => ID.startsWith("delivery:")),
  );
  // The at-risk morning run owns the complete delivery discovery set. Rules
  // only replace the overdue phase and merge it with the already listed risk
  // cases in its own final reconciliation.
  if (lists.includes("at_risk")) await unlistDeliveryCasesExcept(deliveryIDs);
  await unlistAbsentTypedCases(lists, ids);
  return writeFindings(snapshotId, lists, rows, { projectOnly: true });
}

/** Source resolution belongs to the typed case lifecycle, not the Finding projection. */
export async function resolveDetectorCase(
  caseID: string,
  reason?: string,
  sourceCondition?: string,
) {
  const result = await resolveFromSource(caseID, reason, sourceCondition);
  await closeFindingProjection(caseID);
  if (caseID.startsWith("delivery:")) {
    const objectKey = caseID.slice("delivery:".length);
    await Promise.all([
      closeFindingProjection(`at_risk:${objectKey}`),
      closeFindingProjection(`overdue:${objectKey}`),
    ]);
  }
  return result;
}
