import cds from "@sap/cds";
import { createHash } from "node:crypto";
import { logOutcome } from "./action-state";
import { deliveryProblemKey } from "./identity";
import { NS, inTx } from "./model-calls";
import { resolveFromSource } from "./cases";
import { executeWorkflowCommand } from "./commands";
import { inCommandScope } from "./auth";
import { fail } from "./errors";

const { SELECT, UPDATE, DELETE } = cds.ql;

export async function reconcileWaitingApprovals(
  problemKey: string,
  resolution: "confirmed" | "posted" | "resolved_elsewhere" | "escalated",
  source: string,
) {
  const links: Array<{ action_ID: string }> = await SELECT.from(`${NS}.CaseActions`).columns("action_ID").where({ header_ID: problemKey });
  const actions = links.length
    ? await SELECT.from(`${NS}.Actions`).columns("ID").where({ ID: { in: links.map((link) => link.action_ID) }, status: "waiting" })
    : [];
  for (const action of actions)
    await logOutcome(action.ID, { resolution, note: `Reconciled from ${source}.`, resolvedBy: source });
}

/** Reconciles a PO item's durable problem from authoritative current facts. */
export async function reconcileDeliveryProblem(
  PurchaseOrder: string,
  PurchaseOrderItem: string,
  source: "confirmation" | "goods_receipt" | "recompute",
) {
  return inTx(async () => {
  const problemKey = deliveryProblemKey(PurchaseOrder, PurchaseOrderItem);
  const fact = await SELECT.one.from(`${NS}.ItemFactSource`).columns("IsOpen", "OpenQuantity").where({ PurchaseOrder, PurchaseOrderItem });
  if (!fact) return { problemKey, resolved: false, openQuantity: null };
  const open = !!fact?.IsOpen && Number(fact?.OpenQuantity ?? 0) > 0;
  if (source === "confirmation") {
    const purchaseOrderItem = await SELECT.one.from("tide.s4.PurchaseOrderItem")
      .columns("PurchaseOrderQuantityUnit", "PurchasingDocumentDeletionCode")
      .where({ PurchaseOrder, PurchaseOrderItem });
    if (!purchaseOrderItem?.PurchaseOrderQuantityUnit ||
      String(purchaseOrderItem.PurchasingDocumentDeletionCode ?? "").trim())
      return { problemKey, resolved: false, openQuantity: Number(fact.OpenQuantity ?? 0) };
    const confirmations = await SELECT.from("tide.s4.SupplierConfirmationItem")
      .where({
        SuplrConfRefPurchaseOrder: PurchaseOrder,
        SuplrConfRefPurchaseOrderItem: String(Number(PurchaseOrderItem)),
        ItemIsRejectedBySupplier: false,
      });
    const evidenceDates: string[] = [];
    const confirmationProof: Array<Record<string, unknown>> = [];
    for (const confirmation of confirmations) {
      const header = await SELECT.one.from("tide.s4.SupplierConfirmation")
        .where({ SupplierConfirmation: confirmation.SupplierConfirmation });
      if (!header?.CreationDate || !Number.isFinite(Date.parse(String(header.CreationDate)))) continue;
      const lines = await SELECT.from("tide.s4.SupplierConfirmationLine")
        .where({
          SupplierConfirmation: confirmation.SupplierConfirmation,
          SupplierConfirmationItem: confirmation.SupplierConfirmationItem,
        });
      const validLines = lines.filter((line: { DeliveryDate?: string; ConfirmedQuantity?: number; PurchaseOrderQuantityUnit?: string }) =>
        !!line.DeliveryDate && Number.isFinite(Date.parse(line.DeliveryDate)) &&
        Number.isFinite(line.ConfirmedQuantity) && Number(line.ConfirmedQuantity) > 0 &&
        line.PurchaseOrderQuantityUnit === purchaseOrderItem.PurchaseOrderQuantityUnit,
      );
      const quantity = validLines.reduce((total: number, line: { ConfirmedQuantity: number }) => total + line.ConfirmedQuantity, 0);
      if (quantity > 0 && quantity >= Number(fact.OpenQuantity ?? 0)) {
        evidenceDates.push(String(header.CreationDate).slice(0, 10));
        confirmationProof.push({ confirmation, header, lines: validLines });
      }
    }
    if (!evidenceDates.length)
      return { problemKey, resolved: false, openQuantity: Number(fact.OpenQuantity ?? 0) };
    // A confirmation answers an intervention, but it does not satisfy an
    // escalation and does not prove that the remaining quantity was received.
    const links: Array<{ action_ID: string }> = await SELECT.from(`${NS}.CaseActions`)
      .columns("action_ID").where({ header_ID: problemKey, operation: "delivery_intervention" });
    const linkedActions = links.length
      ? await SELECT.from(`${NS}.Actions`).columns("ID", "decidedAt", "modifiedAt").where({ ID: { in: links.map((link) => link.action_ID) }, status: "waiting" })
      : [];
    const actions = linkedActions.length
      ? linkedActions
      : await SELECT.from(`${NS}.Actions`).columns("ID", "decidedAt", "modifiedAt").where({ problemKey, operationKey: "delivery_intervention", status: "waiting" });
    for (const action of actions) {
      if (!action.decidedAt || !evidenceDates.some((date) => date > String(action.decidedAt).slice(0, 10))) continue;
      const owners = await SELECT.from(`${NS}.CaseActions`).where({ action_ID: action.ID });
      const affected = [...new Set<string>([problemKey, ...owners.map((owner: { header_ID: string }) => owner.header_ID)])].sort();
      const evidence = { PurchaseOrder, PurchaseOrderItem, actionID: action.ID, actionModifiedAt: action.modifiedAt, fact, purchaseOrderItem, confirmationProof, evidenceDates: evidenceDates.sort() };
      await executeWorkflowCommand({
        commandID: `delivery-confirmation:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`,
        commandType: "reconcileDeliveryConfirmation",
        arguments: evidence,
        subjects: [{ kind: "action", ID: action.ID }, ...affected.map(ID => ({ kind: "case" as const, ID }))],
      }, {
        authorize: async () => {
          for (const ID of affected) {
            const header = await SELECT.one.from(`${NS}.Cases`).where({ ID });
            if (!header || !inCommandScope(cds.context!.user, header)) throw fail(404, "Case not found");
          }
        },
        execute: async () => {
          const current = await SELECT.one.from(`${NS}.Actions`).where({ ID: action.ID });
          if (current?.status !== "waiting" || current.modifiedAt !== action.modifiedAt)
            throw fail(409, "Delivery confirmation reconciliation became stale");
          await logOutcome(action.ID, { resolution: "confirmed", note: "Reconciled from linked supplier confirmation created after approval.", resolvedBy: source });
          return { actionID: action.ID, resolution: "confirmed" };
        },
      });
    }
    return { problemKey, resolved: false, openQuantity: Number(fact?.OpenQuantity ?? 0) };
  }
  if (open) return { problemKey, resolved: false, openQuantity: Number(fact?.OpenQuantity ?? 0) };
  const item = await SELECT.one.from("tide.s4.PurchaseOrderItem")
    .columns("IsCompletelyDelivered", "PurchasingDocumentDeletionCode")
    .where({ PurchaseOrder, PurchaseOrderItem });
  const schedules: Array<{ OpenPurchaseOrderQuantity: number | null }> =
    await SELECT.from("tide.s4.PurchaseOrderScheduleLine")
      .columns("OpenPurchaseOrderQuantity")
      .where({ PurchaseOrder, PurchaseOrderItem });
  if (typeof item?.PurchasingDocumentDeletionCode === "string" &&
    item.PurchasingDocumentDeletionCode.trim() !== "")
    return { problemKey, resolved: false, openQuantity: null };
  const explicitlyEnded = item?.IsCompletelyDelivered === true;
  const completeSchedule = schedules.length > 0 && schedules.every((schedule) =>
    typeof schedule.OpenPurchaseOrderQuantity === "number" &&
    Number.isFinite(schedule.OpenPurchaseOrderQuantity) &&
    schedule.OpenPurchaseOrderQuantity === 0,
  );
  if (!explicitlyEnded && !completeSchedule)
    return { problemKey, resolved: false, openQuantity: null };
    const caseRow = await SELECT.one.from(`${NS}.Cases`).where({ ID: problemKey });
    if (!caseRow) return { problemKey, resolved: false, openQuantity: 0 };
    const links = await SELECT.from(`${NS}.CaseActions`).where({ header_ID: problemKey });
    const actions = links.length
      ? await SELECT.from(`${NS}.Actions`).where({
          ID: { in: links.map((link: { action_ID: string }) => link.action_ID) },
          status: "waiting",
        })
      : [];
    const evidence = {
      PurchaseOrder,
      PurchaseOrderItem,
      source,
      caseModifiedAt: caseRow.modifiedAt,
      fact,
      item,
      schedules: schedules.map((schedule) => JSON.stringify(schedule)).sort(),
      actions: actions.map((action: { ID: string; modifiedAt: string }) => ({
        ID: action.ID, modifiedAt: action.modifiedAt,
      })).sort((left: { ID: string }, right: { ID: string }) => left.ID.localeCompare(right.ID)),
    };
    return executeWorkflowCommand({
      commandID: `delivery-source:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`,
      commandType: "reconcileDeliverySource",
      arguments: evidence,
      subjects: [
        { kind: "case", ID: problemKey },
        ...actions.map((action: { ID: string }) => ({ kind: "action" as const, ID: action.ID })),
      ],
    }, {
      authorize: async () => {
        const affected = new Set<string>([problemKey]);
        for (const action of actions) {
          const owners = await SELECT.from(`${NS}.CaseActions`).where({ action_ID: action.ID });
          for (const owner of owners) affected.add(owner.header_ID);
        }
        for (const ID of affected) {
          const header = await SELECT.one.from(`${NS}.Cases`).where({ ID });
          if (!header || !inCommandScope(cds.context!.user, header))
            throw fail(404, "Case not found");
        }
      },
      execute: async () => {
        const current = await SELECT.one.from(`${NS}.Cases`).where({ ID: problemKey });
        if (current?.modifiedAt !== caseRow.modifiedAt)
          throw fail(409, "Delivery source reconciliation became stale");
        await resolveFromSource(problemKey, "Delivery obligation ended in source facts.");
        await UPDATE.entity(`${NS}.Finding`)
          .set({ status: "closed", statusCriticality: 3 })
          .where({ PurchaseOrder, PurchaseOrderItem, status: "open" });
        await reconcileWaitingApprovals(problemKey, "resolved_elsewhere", source);
        return { problemKey, resolved: true, openQuantity: 0 };
      },
    });
  });
}

/** Morning safety net: feed hooks may fail, so current source facts re-resolve all delivery problems. */
export async function reconcileDeliveryProblems(openItems: Array<{ PurchaseOrder: string; PurchaseOrderItem: string }>) {
  const open = new Set(openItems.map((item) => deliveryProblemKey(item.PurchaseOrder, item.PurchaseOrderItem)));
  const cases: Array<{ ID: string }> = await SELECT.from(`${NS}.Cases`).columns("ID").where({ kind: "delivery", status: "open" });
  for (const row of cases) {
    if (open.has(row.ID)) continue;
    const key = row.ID.slice("delivery:".length);
    const separator = key.lastIndexOf("/");
    if (separator < 0) continue;
    await reconcileDeliveryProblem(key.slice(0, separator), key.slice(separator + 1), "recompute");
  }
}
