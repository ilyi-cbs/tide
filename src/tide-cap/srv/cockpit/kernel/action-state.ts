// Every transition emits an Event; action completion alone does not resolve
// the linked business case.
import cds from "@sap/cds";
import { createHash } from "node:crypto";
import { NS, inTx } from "./model-calls";
import { emit } from "./events";
import { fail } from "./errors";
import { addWorkingDays } from "./calendar";
import type { ActionKind } from "./types";
import { notifyActionTransition } from "./action-listeners";
import { touchCasesForAction } from "./attention";
import { currentWorkflowCommand, executeWorkflowCommand } from "./commands";
import { inCommandScope } from "./auth";

const { SELECT, UPDATE, DELETE } = cds.ql;
const ENTITY = `${NS}.Actions`;

export type ActionStatus =
  "needs_decision" | "waiting" | "resolved" | "declined";

/** Working days a `waiting` action gets before it's flagged overdue (kernel/expire.ts), per kind. */
export const COOLDOWN_DAYS: Partial<Record<ActionKind, number>> = {
  reminder: 3,
  pdt_change: 1,
  code_list: 1,
  pr_review: 1,
  price_clarification: 3,
  mdg_case: 3,
  planner_review: 3,
};

/** Kinds with no real-world follow-up: decide() resolves them directly, they never enter `waiting`. */
const INTERNAL_CHECK_KINDS = new Set<ActionKind>(["worklist", "price_check"]);

export function isInternalCheck(kind: ActionKind): boolean {
  return INTERNAL_CHECK_KINDS.has(kind);
}

/** The cooldown length, in working days, of an action's kind (0 for internal-check / unknown kinds). */
export function cooldownDaysFor(kind: ActionKind): number {
  return COOLDOWN_DAYS[kind] ?? 1;
}

interface DecideOpts {
  decidedBy: string;
  note?: string | null;
  asOf: string; // YYYY-MM-DD, the sim "today" the cooldown clock starts from
  expectedModifiedAt?: string | null;
}

async function assertReviewedEvidence(ID: string) {
  const links: Array<{ header_ID: string; sourceFingerprint: string | null }> =
    await SELECT.from(`${NS}.CaseActions`).where({ action_ID: ID });
  for (const link of links) {
    const row = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: link.header_ID });
    if (
      !row ||
      row.status !== "open" ||
      (link.sourceFingerprint &&
        link.sourceFingerprint !== row.sourceFingerprint)
    )
      throw fail(
        409,
        "Case evidence has changed since preparation; reload and prepare against the current evidence",
      );
  }
}

async function readRaw(ID: string) {
  const a = await SELECT.one.from(ENTITY).where({ ID });
  if (!a) throw fail(404, "Action not found");
  return a;
}

async function requireWorkflowDecision(action: Record<string, any>) {
  if (currentWorkflowCommand()) return;
  const links: Array<{ header_ID: string }> = await SELECT.from(
    `${NS}.CaseActions`,
  )
    .columns("header_ID")
    .where({ action_ID: action.ID });
  if (links.length || action.problemKey)
    throw fail(
      410,
      "Case decisions require WorkflowService with commandID and expectedModifiedAt",
    );
}

async function releaseLocks(ID: string) {
  await DELETE.from(`${NS}.OperationLocks`).where({ action_ID: ID });
  await DELETE.from("tide.workflow.SubjectClaims").where({ actionID: ID });
}

async function recordCaseActionEvent(
  ID: string,
  event: string,
  fromStatus: string,
  toStatus: string,
  actor?: string | null,
  note?: string | null,
  source?: string | null,
) {
  await cds.ql.INSERT.into(`${NS}.ActionEvents`).entries({
    ID: cds.utils.uuid(),
    action_ID: ID,
    occurredAt: new Date().toISOString(),
    event,
    fromStatus,
    toStatus,
    actor: actor ?? cds.context?.user?.id ?? null,
    note: note ?? null,
    source: source ?? null,
    command_ID: currentWorkflowCommand() ?? null,
  });
  const links: Array<{ header_ID: string }> = await SELECT.from(
    `${NS}.CaseActions`,
  )
    .columns("header_ID")
    .where({ action_ID: ID });
  for (const link of links) {
    await cds.ql.INSERT.into(`${NS}.CaseEvents`).entries({
      ID: cds.utils.uuid(),
      header_ID: link.header_ID,
      occurredAt: new Date().toISOString(),
      event: `action_${event}`,
      // Action state is recorded for the case timeline, but it is not a case
      // lifecycle transition. Case status changes have their own events.
      fromStatus: null,
      toStatus: null,
      actor: actor ?? cds.context?.user?.id ?? null,
      reason: [event.replace(/_/g, " "), note, source]
        .filter(Boolean)
        .join(" · "),
      command_ID: currentWorkflowCommand() ?? null,
    });
  }
}

function assertStatus(a: Record<string, any>, expected: ActionStatus) {
  if (a.status !== expected) throw fail(409, `Action is already ${a.status}`);
}

async function transition(
  ID: string,
  expected: ActionStatus,
  values: Record<string, unknown>,
  expectedModifiedAt?: string | null,
) {
  const changed = await UPDATE.entity(ENTITY)
    .set(values)
    .where({
      ID,
      status: expected,
      ...(expectedModifiedAt ? { modifiedAt: expectedModifiedAt } : {}),
    });
  if (Number(changed) !== 1) {
    const current = await readRaw(ID);
    throw fail(409, `Action is already ${current.status}`);
  }
}

/** needs_decision -> waiting (outbound/data-change kinds) or resolved (internal-check kinds, decide IS resolving). */
export async function decide(ID: string, opts: DecideOpts) {
  return inTx(async () => {
    const a = await readRaw(ID);
    await requireWorkflowDecision(a);
    assertStatus(a, "needs_decision");
    if (opts.expectedModifiedAt && opts.expectedModifiedAt !== a.modifiedAt)
      throw fail(409, "Action changed; reload before deciding");
    await assertReviewedEvidence(ID);
    if (a.decisionReady === false)
      throw fail(
        409,
        a.decisionBlockReason || "Decision context is incomplete",
      );
    const decidedAt = new Date().toISOString();
    if (isInternalCheck(a.kind)) {
      await transition(
        ID,
        "needs_decision",
        {
          status: "resolved",
          decidedBy: opts.decidedBy,
          decidedAt,
          decisionNote: opts.note ?? null,
          resolvedBy: opts.decidedBy,
          resolvedAt: decidedAt,
        },
        opts.expectedModifiedAt,
      );
      await releaseLocks(ID);
      await recordCaseActionEvent(
        ID,
        "resolved",
        "needs_decision",
        "resolved",
        opts.decidedBy,
        opts.note,
      );
      await UPDATE.entity(`${NS}.CaseActions`)
        .set({ resolution: "confirmed", resolvedAt: decidedAt })
        .where({ action_ID: ID });
      await emit({
        kind: "action",
        status: "resolved",
        title: `Resolved: ${a.title}`,
        objectKey: a.objectKey,
      });
      await touchCasesForAction(ID);
      return readRaw(ID);
    }
    const expectedBy = addWorkingDays(opts.asOf, cooldownDaysFor(a.kind));
    await transition(
      ID,
      "needs_decision",
      {
        status: "waiting",
        decidedBy: opts.decidedBy,
        decidedAt,
        decisionNote: opts.note ?? null,
        waitingSince: decidedAt,
        expectedBy,
        overdue: false,
      },
      opts.expectedModifiedAt,
    );
    await recordCaseActionEvent(
      ID,
      "approved",
      "needs_decision",
      "waiting",
      opts.decidedBy,
      opts.note,
    );
    await emit({
      kind: "action",
      status: "waiting",
      title: `Decided: ${a.title}`,
      objectKey: a.objectKey,
    });
    await notifyActionTransition({ ID, kind: a.kind, status: "waiting" });
    await touchCasesForAction(ID);
    return readRaw(ID);
  });
}

/** needs_decision -> declined: the buyer chose not to act; the finding stays open and may re-surface later. */
export async function decline(
  ID: string,
  decidedBy: string,
  note: string,
  expectedModifiedAt?: string | null,
) {
  if (typeof note !== "string" || !note.trim())
    throw fail(400, "A reason is required to decline an action");
  return inTx(async () => {
    const a = await readRaw(ID);
    await requireWorkflowDecision(a);
    assertStatus(a, "needs_decision");
    if (expectedModifiedAt && expectedModifiedAt !== a.modifiedAt)
      throw fail(409, "Action changed; reload before declining");
    await transition(
      ID,
      "needs_decision",
      {
        status: "declined",
        decidedBy,
        decidedAt: new Date().toISOString(),
        decisionNote: note,
      },
      expectedModifiedAt,
    );
    await releaseLocks(ID);
    await recordCaseActionEvent(
      ID,
      "declined",
      "needs_decision",
      "declined",
      decidedBy,
      note,
    );
    await emit({
      kind: "action",
      status: "declined",
      title: `Declined: ${a.title}`,
      objectKey: a.objectKey,
    });
    await notifyActionTransition({ ID, kind: a.kind, status: "declined" });
    await touchCasesForAction(ID);
    return readRaw(ID);
  });
}

/** Source revisions supersede active approvals; retain the audit trail but free the operation for re-review. */
export async function supersede(ID: string, reason: string) {
  return inTx(async () => {
    const a = await readRaw(ID);
    if (!isActive(a.status)) return a;
    await transition(ID, a.status, {
      status: "declined",
      decisionNote: reason,
      resolvedBy: "source_sync",
      resolvedAt: new Date().toISOString(),
    });
    await releaseLocks(ID);
    await recordCaseActionEvent(
      ID,
      "superseded",
      a.status,
      "declined",
      "source_sync",
      reason,
      "source_sync",
    );
    await emit({
      kind: "action",
      status: "declined",
      title: `Superseded: ${a.title}`,
      objectKey: a.objectKey,
    });
    await notifyActionTransition({ ID, kind: a.kind, status: "declined" });
    await touchCasesForAction(ID);
    return readRaw(ID);
  });
}

export interface LogOutcomeInput {
  resolution: "confirmed" | "posted" | "resolved_elsewhere" | "escalated";
  note?: string | null;
  resolvedBy: string;
  expectedModifiedAt?: string | null;
}

/** waiting -> resolved: the buyer records what actually happened outside the app. */
export async function logOutcome(ID: string, input: LogOutcomeInput) {
  return inTx(async () => {
    const a = await readRaw(ID);
    await requireWorkflowDecision(a);
    assertStatus(a, "waiting");
    if (input.expectedModifiedAt && input.expectedModifiedAt !== a.modifiedAt)
      throw fail(409, "Action changed; reload before recording the outcome");
    const resolvedAt = new Date().toISOString();
    await transition(
      ID,
      "waiting",
      {
        status: "resolved",
        resolution: input.resolution,
        resolutionNote: input.note ?? null,
        resolvedBy: input.resolvedBy,
        resolvedAt,
      },
      input.expectedModifiedAt,
    );
    await releaseLocks(ID);
    await recordCaseActionEvent(
      ID,
      "resolved",
      "waiting",
      "resolved",
      input.resolvedBy,
      input.note,
      input.resolution,
    );
    await UPDATE.entity(`${NS}.CaseActions`)
      .set({ resolution: input.resolution, resolvedAt })
      .where({ action_ID: ID });
    await emit({
      kind: "action",
      status: "resolved",
      title: `Outcome logged: ${a.title}`,
      objectKey: a.objectKey,
    });
    await notifyActionTransition({
      ID,
      kind: a.kind,
      status: "resolved",
      resolution: input.resolution,
    });
    await touchCasesForAction(ID);
    return readRaw(ID);
  });
}

/** Flags (loudly, in the Waiting tab) `waiting` actions whose cooldown elapsed without an outcome; never auto-resolves. */
export async function flagOverdue(
  ID: string,
  asOf: string,
  expectedBy: string,
) {
  if (
    [asOf, expectedBy].some(
      (value) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value,
    )
  )
    throw fail(400, "A valid follow-up observation date is required");
  if (expectedBy > asOf) return;
  const argumentsForDeadline = { actionID: ID, expectedBy };
  const commandID =
    "follow-up-deadline:" +
    createHash("sha256")
      .update(JSON.stringify(argumentsForDeadline))
      .digest("hex");
  return executeWorkflowCommand(
    {
      commandID,
      commandType: "flagFollowUpOverdue",
      arguments: argumentsForDeadline,
      subjects: [{ kind: "action", ID }],
    },
    {
      authorize: async () => {
        const links: Array<{ header_ID: string }> = await SELECT.from(
          `${NS}.CaseActions`,
        )
          .columns("header_ID")
          .where({ action_ID: ID });
        if (!links.length) throw fail(404, "Action has no authorized Cases");
        for (const link of links) {
          const header = await SELECT.one
            .from(`${NS}.Cases`)
            .where({ ID: link.header_ID });
          if (!header || !inCommandScope(cds.context!.user, header))
            throw fail(404, "Case not found");
        }
      },
      execute: async () => {
        const current = await readRaw(ID);
        if (current.expectedBy !== expectedBy)
          throw fail(
            409,
            "Follow-up deadline changed; observe the current deadline",
          );
        if (current.status !== "waiting" || current.overdue) return current;
        const changed = await UPDATE.entity(ENTITY)
          .set({ overdue: true })
          .where({
            ID,
            status: "waiting",
            overdue: false,
            expectedBy,
            modifiedAt: current.modifiedAt,
          });
        if (Number(changed) !== 1)
          throw fail(
            409,
            "Action changed concurrently; reload before retrying",
          );
        await recordCaseActionEvent(
          ID,
          "follow_up_overdue",
          "waiting",
          "waiting",
          cds.context!.user.id,
          null,
          "timer",
        );
        await emit({
          kind: "action",
          status: "waiting",
          title: `Overdue: ${current.title}`,
          objectKey: current.objectKey,
        });
        await touchCasesForAction(ID);
        return readRaw(ID);
      },
    },
  );
}

/** True when an action is still in flight and must prevent duplicate preparation. */
export function isActive(status: string): boolean {
  return status === "needs_decision" || status === "waiting";
}
