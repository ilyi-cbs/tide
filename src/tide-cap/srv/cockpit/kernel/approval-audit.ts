import cds from "@sap/cds";
import { NS } from "./model-calls";

const { INSERT } = cds.ql;

export async function recordApprovalEvent(input: {
  approvalID: string;
  event: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor?: string | null;
  note?: string | null;
  source?: string | null;
}) {
  await INSERT.into(`${NS}.ApprovalEvent`).entries({
    ID: cds.utils.uuid(),
    approval_ID: input.approvalID,
    at: new Date().toISOString(),
    event: input.event,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    actor: input.actor ?? cds.context?.user?.id ?? null,
    note: input.note ?? null,
    source: input.source ?? null,
  });
}

export async function recordProblemEvent(input: {
  problemKey: string;
  event: string;
  reason?: string | null;
  findingID?: string | null;
  source?: string | null;
}) {
  await INSERT.into(`${NS}.ProblemEvent`).entries({
    ID: cds.utils.uuid(),
    problemKey: input.problemKey,
    at: new Date().toISOString(),
    event: input.event,
    reason: input.reason ?? null,
    findingID: input.findingID ?? null,
    source: input.source ?? null,
  });
}
