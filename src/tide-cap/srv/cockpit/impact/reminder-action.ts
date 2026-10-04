// Finding-action builder for the reminder lists (at_risk, overdue): the
// supplier text states the rule reason only (contract A1, H-4); the
// internal summary may name the impact.
import cds from "@sap/cds";
import type { PrepareActionInput } from "../kernel/actions";
import type { Row } from "../kernel/model-calls";
import type { ActionVia } from "../kernel/types";
import { actionSummary, reminderText, type ReminderItem, type ReminderReason } from "./domain/reminder";
import { deliveryProblemKey } from "../kernel/identity";

export const REMINDER_LISTS = ["at_risk", "overdue"] as const;

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** The rule reason of a reminder finding (never a probability). */
export function reminderReason(f: Row): ReminderReason {
  switch (f.list) {
    case "overdue":
      return { kind: "overdue", daysOverdue: num(f.overdueDetail?.daysOverdue) ?? 0 };
    case "at_risk": {
      const gap = num(f.atRiskDetail?.gapDays);
      const planned = num(f.atRiskDetail?.plannedDays);
      if (gap !== null && gap < 0) return { kind: "requested_before_po" };
      if (f.atRiskDetail?.ruleVerdict === "fires" || (gap !== null && planned !== null && gap < planned))
        return { kind: "planned_time_not_reachable", plannedDays: planned };
      return { kind: "none" };
    }
    default:
      return { kind: "none" };
  }
}

function itemOf(f: Row): ReminderItem {
  const [po, it] = String(f.objectKey ?? "").split("/");
  const title = String(f.itemTitle ?? "");
  const text = title.includes(" · ") ? title.split(" · ").slice(1).join(" · ") : null;
  return {
    PurchaseOrder: f.PurchaseOrder ?? po ?? "",
    PurchaseOrderItem: f.PurchaseOrderItem ?? it ?? "",
    Material: f.Material ?? null,
    MaterialText: text && text !== f.Material ? text : null,
    RequestedDate: f.dueDate ? String(f.dueDate).slice(0, 10) : null,
  };
}

export async function reminderAction(f: Row, via: ActionVia): Promise<PrepareActionInput> {
  if (f.list === "overdue" && !f.overdueDetail)
    f.overdueDetail = await cds.ql.SELECT.one.from("tide.cockpit.OverdueDetail").where({ finding_ID: f.ID });
  if (f.list === "at_risk" && !f.atRiskDetail)
    f.atRiskDetail = await cds.ql.SELECT.one.from("tide.cockpit.AtRiskDetail").where({ finding_ID: f.ID });
  const item = itemOf(f);
  const reason = reminderReason(f);
  const t = reminderText(item, reason);
  const key = `${item.PurchaseOrder}/${item.PurchaseOrderItem}`;
  return {
    kind: "reminder",
    objectKey: f.objectKey ?? key,
    problemKey: f.problemKey ?? deliveryProblemKey(item.PurchaseOrder, item.PurchaseOrderItem),
    operationKey: f.list === "overdue" ? "delivery_escalation" : "delivery_intervention",
    exportFormat: "reminder",
    via,
    findingID: f.ID,
    requestType: f.list === "overdue" ? "Delivery Risk - Overdue" : "Delivery Risk - At Risk",
    chain: f.chain ?? null,
    title: `${f.nextStep || "Reminder"}: ${f.itemTitle || key}`,
    summary: actionSummary(item, reason, f.impactText ?? null),
    items: [
      {
        objectKey: key,
        problemKey: f.problemKey ?? deliveryProblemKey(item.PurchaseOrder, item.PurchaseOrderItem),
        operationKey: f.list === "overdue" ? "delivery_escalation" : "delivery_intervention",
        findingID: f.ID,
        field: "ScheduleLineDeliveryDate",
        oldValue: item.RequestedDate ?? null,
        newValue: "Ask the supplier to confirm the earliest achievable delivery date",
        text: t.body,
        data: {
          PurchaseOrder: item.PurchaseOrder,
          PurchaseOrderItem: item.PurchaseOrderItem,
          ask: t.subject.split(": ").slice(1).join(": "),
          reason: t.reason,
        },
      },
    ],
  };
}

/**
 * Canonical action input for a typed delivery case. Retained Finding routes
 * adapt to reminderAction() above; typed OData and MCP start from this current
 * feature row so they cannot invent a different delivery operation or text.
 */
export async function deliveryReminderAction(
  delivery: Row,
  caseRow: Row,
  via: ActionVia,
  impact: string | null = null,
): Promise<PrepareActionInput> {
  const detail = delivery.detail ? JSON.parse(delivery.detail) : {};
  const phase = delivery.phase === "overdue" ? "overdue" : "at_risk";
  const f: Row = {
    ID: null,
    list: phase,
    objectKey: `${delivery.PurchaseOrder}/${delivery.PurchaseOrderItem}`,
    problemKey: caseRow.ID,
    PurchaseOrder: delivery.PurchaseOrder,
    PurchaseOrderItem: delivery.PurchaseOrderItem,
    Material: delivery.Material,
    itemTitle: caseRow.title,
    dueDate: delivery.dueDate,
    impactText: impact,
    atRiskDetail: phase === "at_risk" ? detail : undefined,
    overdueDetail: phase === "overdue" ? detail : undefined,
  };
  const input = await reminderAction(f, via);
  input.cases = [{ ID: caseRow.ID, operation: input.operationKey!, role: "primary" }];
  return input;
}
