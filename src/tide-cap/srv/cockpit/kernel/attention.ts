import cds from "@sap/cds";
import { NS } from "./model-calls";

const { SELECT, UPDATE } = cds.ql;

export type Attention =
  | "done"
  | "source_changed"
  | "needs_review"
  | "in_progress"
  | "awaiting_decision"
  | "follow_up_overdue"
  | "waiting_external"
  | "awaiting_source"
  | "needs_attention";

export function deriveAttention(
  caseRow: Record<string, any>,
  actions: Array<Record<string, any>>,
  review?: Record<string, any> | null,
): Attention {
  if (caseRow.status === "closed") return "done";
  if (caseRow.sourceChanged) return "source_changed";
  if (review?.reviewStatus === "new") return "needs_review";
  if (review?.reviewStatus === "in_progress") return "in_progress";
  if (actions.some((action) => action.status === "needs_decision")) return "awaiting_decision";
  if (actions.some((action) => action.status === "waiting" && action.overdue)) return "follow_up_overdue";
  if (actions.some((action) => action.status === "waiting")) return "waiting_external";
  if (actions.some((action) => action.status === "resolved")) return "awaiting_source";
  return "needs_attention";
}

/** Rebuild the derived queue state after any case, review, or linked-action change. */
export async function touchCase(caseID: string): Promise<void> {
  const caseRow = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  if (!caseRow) return;
  const links: Array<{ action_ID: string }> = await SELECT.from(`${NS}.CaseActions`).columns("action_ID").where({ header_ID: caseID });
  const actions = links.length
    ? await SELECT.from(`${NS}.Actions`).where`ID in ${links.map((link) => link.action_ID)}`
    : [];
  const review = caseRow.kind === "requisition_review"
    ? await SELECT.one.from(`${NS}.RequisitionReviews`).where({ header_ID: caseID })
    : null;
  const attention = deriveAttention(caseRow, actions, review);
  if (attention !== caseRow.attention) {
    const affected = await UPDATE.entity(`${NS}.Cases`).set({ attention }).where({ ID: caseID, status: caseRow.status, sourceRevision: caseRow.sourceRevision, sourceChanged: caseRow.sourceChanged });
    if (!Number(affected)) return touchCase(caseID);
  }
}

export async function touchCasesForAction(actionID: string) {
  const links: Array<{ header_ID: string }> = await SELECT.from(`${NS}.CaseActions`).columns("header_ID").where({ action_ID: actionID });
  for (const link of links) await touchCase(link.header_ID);
}

/** Repair derived attention after imports or schema migrations. */
export async function rebuildAttention() {
  const cases: Array<{ ID: string }> = await SELECT.from(`${NS}.Cases`).columns("ID");
  for (const row of cases) await touchCase(row.ID);
}
