import cds from "@sap/cds";
import { touchCase } from "./attention";
import { fail } from "./errors";
import { NS, inTx } from "./model-calls";
import { currentWorkflowCommand } from "./commands";

const { SELECT, INSERT, UPDATE } = cds.ql;

async function change(
  row: Record<string, any>,
  values: Record<string, unknown>,
) {
  const affected = await UPDATE.entity(`${NS}.Cases`)
    .set(values)
    .where({
      ID: row.ID,
      status: row.status,
      sourceRevision: row.sourceRevision,
      modifiedAt: row.modifiedAt,
      sourceFingerprint: row.sourceFingerprint ?? null,
      sourceChanged: row.sourceChanged,
    });
  if (Number(affected) !== 1)
    throw fail(409, "Case changed concurrently; reload before retrying");
}

type CaseInput = {
  ID: string;
  kind: string;
  Plant?: string | null;
  PurchasingGroup?: string | null;
  title?: string | null;
  priority?: number | null;
  dueDate?: string | null;
  sourceRevision?: number | null;
  sourceFingerprint?: string | null;
};

async function event(
  caseID: string,
  name: string,
  fields: Record<string, unknown> = {},
) {
  await INSERT.into(`${NS}.CaseEvents`).entries({
    ID: cds.utils.uuid(),
    header_ID: caseID,
    occurredAt: new Date().toISOString(),
    event: name,
    actor: cds.context?.user?.id ?? null,
    ...fields,
    command_ID: currentWorkflowCommand() ?? null,
  });
}

/** Create a durable case once; later detector runs only refresh non-lifecycle metadata. */
export async function ensureCase(input: CaseInput) {
  return inTx(async () => {
    const existing = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: input.ID });
    if (existing) {
      if (existing.kind !== input.kind)
        throw fail(409, "A Case identity cannot change business kind");
      const updates = Object.fromEntries(
        Object.entries(input).filter(
          ([key, value]) =>
            !["ID", "sourceRevision", "sourceFingerprint"].includes(key) &&
            value !== undefined,
        ),
      );
      if (Object.keys(updates).length)
        await change(existing, updates);
      return SELECT.one.from(`${NS}.Cases`).where({ ID: input.ID });
    }
    await INSERT.into(`${NS}.Cases`).entries({
      ...input,
      status: "open",
      listing: "listed",
      attention: "needs_attention",
    });
    await event(input.ID, "case_detected", {
      toStatus: "open",
      sourceRevision: input.sourceRevision ?? 1,
      sourceFingerprint: input.sourceFingerprint ?? null,
    });
    return SELECT.one.from(`${NS}.Cases`).where({ ID: input.ID });
  });
}

export async function setListing(
  caseID: string,
  listing: "listed" | "unlisted",
) {
  return inTx(async () => {
    const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (!row) throw fail(404, "Case not found");
    if (row.listing === listing) return row;
    await change(row, {
      listing,
      lastListedAt:
        listing === "listed" ? new Date().toISOString() : row.lastListedAt,
    });
    await event(caseID, listing === "listed" ? "relisted" : "unlisted");
    return SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  });
}

export async function recordSourceChange(
  caseID: string,
  sourceRevision: number,
  sourceFingerprint: string,
) {
  return inTx(async () => {
    const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (!row) throw fail(404, "Case not found");
    if (
      row.sourceRevision === sourceRevision &&
      row.sourceFingerprint === sourceFingerprint
    )
      return row;
    if (row.sourceFingerprint === sourceFingerprint) return row;
    await change(row, {
      sourceRevision,
      sourceFingerprint,
      sourceChanged: true,
    });
    await event(caseID, "source_changed", {
      sourceRevision,
      sourceFingerprint,
    });
    await touchCase(caseID);
    return SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  });
}

/** Marks the current source revision as reviewed and restores derived attention. */
export async function acknowledgeSourceChange(
  caseID: string,
  expectedFingerprint?: string | null,
) {
  return inTx(async () => {
    const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (!row) throw fail(404, "Case not found");
    if (expectedFingerprint && row.sourceFingerprint !== expectedFingerprint)
      throw fail(
        409,
        "Case evidence has changed; reload before acknowledging it",
      );
    if (!row.sourceChanged) return row;
    await change(row, { sourceChanged: false });
    await event(caseID, "source_change_reviewed", {
      sourceRevision: row.sourceRevision,
      sourceFingerprint: row.sourceFingerprint,
    });
    await touchCase(caseID);
    return SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  });
}

export async function resolveFromSource(
  caseID: string,
  reason = "Current source facts confirm resolution.",
  sourceCondition?: string,
) {
  return inTx(async () => {
    const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (!row) throw fail(404, "Case not found");
    if (row.kind === "supplier_planned_time" && !currentWorkflowCommand())
      throw fail(
        410,
        "Supplier fulfillment requires a source workflow command",
      );
    if (row.status === "closed") return row;
    const resolvedAt = new Date().toISOString();
    await change(row, {
      status: "closed",
      closure: "resolved_at_source",
      closureNote: reason,
      resolvedAt,
      resolvedSourceCondition: sourceCondition ?? null,
      listing: "unlisted",
      sourceChanged: false,
    });
    await event(caseID, "source_resolved", {
      fromStatus: "open",
      toStatus: "closed",
      reason,
      sourceRevision: row.sourceRevision,
      sourceCondition: sourceCondition ?? null,
    });
    await cds.ql.DELETE.from("tide.workflow.SubjectClaims").where({
      tenant: cds.context?.tenant ?? "",
      caseID,
      claimType: "case",
    });
    await touchCase(caseID);
    return SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  });
}

export async function acceptException(
  caseID: string,
  fingerprint: string,
  note?: string | null,
  sourceCondition?: string,
) {
  return inTx(async () => {
    const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (!row) throw fail(404, "Case not found");
    if (!currentWorkflowCommand())
      throw fail(
        410,
        "Exceptions require WorkflowService with commandID and reviewed evidence",
      );
    if (row.status !== "open") throw fail(409, "Case is already closed");
    if (row.sourceFingerprint !== fingerprint)
      throw fail(
        409,
        "Case evidence has changed; reload before accepting the exception",
      );
    const resolvedAt = new Date().toISOString();
    await change(row, {
      status: "closed",
      closure: "exception_accepted",
      closureNote: note ?? null,
      resolvedAt,
      listing: "unlisted",
      sourceChanged: false,
      ...(sourceCondition ? { acceptedSourceCondition: sourceCondition } : {}),
    });
    await event(caseID, "exception_accepted", {
      fromStatus: "open",
      toStatus: "closed",
      reason: note ?? null,
      sourceFingerprint: fingerprint,
      ...(sourceCondition ? { sourceCondition } : {}),
    });
    await cds.ql.DELETE.from("tide.workflow.SubjectClaims").where({
      tenant: cds.context?.tenant ?? "",
      caseID,
      claimType: "case",
    });
    await touchCase(caseID);
    return SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  });
}

export async function reopenCase(caseID: string, reason: string) {
  return inTx(async () => {
    const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (!row) throw fail(404, "Case not found");
    if (row.status === "open") return row;
    await change(row, {
      status: "open",
      closure: null,
      closureNote: null,
      resolvedAt: null,
      listing: "listed",
    });
    await event(caseID, "case_reopened", {
      fromStatus: "closed",
      toStatus: "open",
      reason,
    });
    await touchCase(caseID);
    return SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  });
}
