// Prepared actions (contract §5, P-15): one creator for every kind and origin,
// per-kind CSV export, and prepareFindingAction. Nothing is sent to suppliers
// or written to SAP; an approval only makes the CSV available.
import cds from "@sap/cds";
import { NS, inTx, type Row } from "./model-calls";
import { emit } from "./events";
import { fail } from "./errors";
import { asOfDate } from "./asof";
import {
  decide,
  decline,
  logOutcome,
  type LogOutcomeInput,
} from "./action-state";
import type {
  ActionKind,
  ActionVia,
  ExportFormat,
  FindingList,
  OperationKey,
  RequestType,
} from "./types";
import {
  defaultOperation,
  deliveryProblemKey,
  exportFormatFor,
  findingProblemKey,
  operationForFinding,
} from "./identity";
import { isAdmin, inScope, scopeOf } from "./auth";
import { currentWorkflowCommand } from "./commands";
import { touchCasesForAction } from "./attention";
import { acknowledgeSourceChange, ensureCase } from "./cases";

const { SELECT, INSERT, UPDATE } = cds.ql;
const MAX_REMINDER_ITEMS = 50;

export interface ActionItemInput {
  objectKey: string;
  problemKey?: string | null;
  operationKey?: OperationKey | null;
  findingID?: string | null;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  text?: string | null;
  data?: Record<string, unknown> | null;
}

export interface PrepareActionInput {
  kind: ActionKind;
  objectKey: string;
  problemKey?: string | null;
  operationKey?: OperationKey | null;
  exportFormat?: ExportFormat | null;
  title: string;
  summary?: string | null;
  items: ActionItemInput[];
  via: ActionVia;
  findingID?: string | null;
  requestType?: RequestType | null;
  chain?: string | null;
  responsiblePerson?: string | null;
  responsibleMessage?: string | null;
  /** V4 relationship input. Legacy callers may omit it while their feature migrates. */
  cases?: Array<{
    ID: string;
    operation: OperationKey;
    role?: "primary" | "affected";
  }>;
}

function requestTypeFor(input: PrepareActionInput): RequestType {
  if (input.requestType) return input.requestType;
  const findingList = String(input.findingID ?? "").split(":", 1)[0];
  const byFinding: Partial<Record<string, RequestType>> = {
    at_risk: "Delivery Risk - At Risk",
    overdue: "Delivery Risk - Overdue",
    price: "Price Deviation",
    duplicate: "Duplicate Materials",
    rare: "Unusual Planning Setting",
    pdt: "Supplier Planned Time",
    mm_pdt: "Material Planned Time",
    freetext: "Code Suggestion Review",
  };
  const byOperation: Partial<Record<OperationKey, RequestType>> = {
    delivery_intervention: "Delivery Risk - At Risk",
    delivery_escalation: "Delivery Risk - Overdue",
    price_clarification: "Price Deviation",
    master_data_duplicate_review: "Duplicate Materials",
    planner_review: "Unusual Planning Setting",
    pdt_change: "Supplier Planned Time",
    requisition_review: "Purchase Requisition Review",
    code_list: "Code Suggestion Review",
    prediction_worklist: "Prediction Worklist",
  };
  return (
    byFinding[findingList] ??
    byOperation[input.operationKey ?? defaultOperation(input.kind)] ??
    "Other Prepared Request"
  );
}

function decisionReadiness(
  input: PrepareActionInput,
  requestType: RequestType,
) {
  if (!input.requestType)
    return { decisionReady: true, decisionBlockReason: null };
  if (!requestType.startsWith("Delivery Risk"))
    return { decisionReady: true, decisionBlockReason: null };
  const item = input.items[0];
  const missing: string[] = [];
  if (!input.summary) missing.push("business summary");
  if (!item?.oldValue) missing.push("required delivery date");
  if (!item?.newValue) missing.push("requested supplier follow-up");
  return missing.length
    ? {
        decisionReady: false,
        decisionBlockReason: `Missing: ${missing.join(", ")}. Review the linked Delivery Risk before approving.`,
      }
    : { decisionReady: true, decisionBlockReason: null };
}

/** The active approval for a durable problem and operation, if any. */
export async function activeApproval(
  problemKey: string,
  operationKey: OperationKey,
) {
  const linked = await activeCaseAction(problemKey, operationKey);
  if (linked) return linked;
  // Compatibility callers have not all supplied a CaseActions link yet. Their
  // active action is still identifiable without reviving the legacy lock table.
  return SELECT.one.from(`${NS}.Actions`).where({
    problemKey,
    operationKey,
    status: { in: ["needs_decision", "waiting"] },
  });
}

export async function activeCaseAction(
  caseID: string,
  operation: OperationKey,
) {
  const lock = await SELECT.one
    .from(`${NS}.OperationLocks`)
    .where({ header_ID: caseID, operation });
  return lock?.action_ID
    ? SELECT.one.from(`${NS}.Actions`).where({ ID: lock.action_ID })
    : undefined;
}

/** Compatibility lookup used by older callers while all writers use durable identities. */
export async function pendingAction(kind: ActionKind, objectKey: string) {
  const direct = await SELECT.one
    .from(`${NS}.Actions`)
    .where({ kind, objectKey, status: { in: ["needs_decision", "waiting"] } });
  if (direct) return direct;
  return activeApproval(objectKey, defaultOperation(kind));
}

/** The action as exposed by PurchasingDeskService.Actions. */
export async function readAction(ID: string) {
  return SELECT.one.from("PurchasingDeskService.Actions").where({ ID });
}

/** Every linked business object must be visible, including all lines of a batch. */
export async function approvalVisible(
  ID: string,
  user: cds.User,
): Promise<boolean> {
  const action = await SELECT.one
    .from(`${NS}.Actions`)
    .columns("ID", "createdBy", "findingID")
    .where({ ID });
  if (!action) return false;
  if (isAdmin(user)) return true;
  const scope = scopeOf(user);
  const caseLinks: Array<{ header_ID: string }> = await SELECT.from(
    `${NS}.CaseActions`,
  )
    .columns("header_ID")
    .where({ action_ID: ID });
  if (caseLinks.length) {
    const cases: Row[] = await SELECT.from(`${NS}.Cases`)
      .columns("ID", "PurchasingGroup", "Plant")
      .where({ ID: { in: caseLinks.map((link) => link.header_ID) } });
    return (
      cases.length === new Set(caseLinks.map((link) => link.header_ID)).size &&
      cases.every((row) => inScope(scope, row))
    );
  }
  const items: Row[] = await SELECT.from(`${NS}.ActionItems`)
    .columns("findingID")
    .where({ action_ID: ID });
  const findingIDs = [
    ...new Set(
      [action.findingID, ...items.map((item) => item.findingID)].filter(
        Boolean,
      ),
    ),
  ];
  if (findingIDs.length) {
    const findings: Row[] = await SELECT.from(`${NS}.Finding`)
      .columns("ID", "Plant", "PurchasingGroup")
      .where({ ID: { in: findingIDs } });
    return (
      findings.length === findingIDs.length &&
      findings.every((row) => inScope(scope, row))
    );
  }
  return action.createdBy === user.id;
}

export async function assertApprovalVisible(
  ID: string,
  user: cds.User = cds.context?.user ?? cds.User.privileged,
) {
  if (!(await approvalVisible(ID, user))) throw fail(404, "Action not found");
}

/**
 * Creates a needs_decision action. Refuses (409, `actionID` = the active
 * one) a second active (needs_decision or waiting) action of the same kind
 * and objectKey unless `unique` is false.
 */
export async function prepareAction(input: PrepareActionInput) {
  if (!input.items?.length)
    throw fail(400, "An action needs at least one line");
  const problemKey = input.problemKey ?? input.findingID ?? input.objectKey;
  if (
    !currentWorkflowCommand() &&
    (problemKey?.startsWith("pdt:") ||
      input.cases?.some((link) => link.ID.startsWith("pdt:")))
  )
    throw fail(
      410,
      "Supplier preparation requires WorkflowService.prepareSupplierPlannedTimeAction",
    );
  const operationKey = input.operationKey ?? defaultOperation(input.kind);
  const exportFormat = input.exportFormat ?? exportFormatFor(input.kind);
  const requestType = requestTypeFor(input);
  const readiness = decisionReadiness(input, requestType);
  // Case links are canonical for v4 callers. Do not infer one for a retained
  // compatibility caller: it may use a historical problem identity that has
  // no Case row during the compatibility release.
  const requestedCases = input.cases?.length ? input.cases : [];
  const lockCandidates = requestedCases.length
    ? requestedCases.map((link) => ({
        problemKey: link.ID,
        operationKey: link.operation,
      }))
    : input.items.map((item) => ({
        problemKey: item.problemKey ?? problemKey,
        operationKey: item.operationKey ?? operationKey,
      }));
  const locks = [
    ...new Map(
      lockCandidates.map((lock) => [
        `${lock.problemKey}\u0000${lock.operationKey}`,
        lock,
      ]),
    ).values(),
  ];
  for (const link of requestedCases) {
    const existing = await activeCaseAction(link.ID, link.operation);
    if (existing)
      throw fail(
        409,
        `An active ${link.operation} for ${link.ID} exists already`,
        { actionID: existing.ID },
      );
  }
  if (!requestedCases.length)
    for (const lock of locks) {
      const existing = await activeApproval(lock.problemKey, lock.operationKey);
      if (existing)
        throw fail(
          409,
          `An active ${lock.operationKey} for ${lock.problemKey} exists already`,
          { actionID: existing.ID },
        );
    }
  try {
    return await inTx(async () => {
      const ID = cds.utils.uuid();
      const fingerprints = new Map<string, string | null>();
      for (const link of requestedCases) {
        const caseRow = await SELECT.one
          .from(`${NS}.Cases`)
          .where({ ID: link.ID });
        if (!caseRow && link.ID.startsWith("delivery:")) {
          const [PurchaseOrder, PurchaseOrderItem] = link.ID.slice(
            "delivery:".length,
          ).split("/");
          const item = await SELECT.one
            .from(`${NS}.ItemFactSource`)
            .columns("Plant", "PurchasingGroup")
            .where({ PurchaseOrder, PurchaseOrderItem });
          const legacy = input.findingID
            ? await SELECT.one
                .from(`${NS}.Finding`)
                .columns("Plant", "PurchasingGroup", "itemTitle")
                .where({ ID: input.findingID })
            : null;
          await ensureCase({
            ID: link.ID,
            kind: "delivery",
            Plant: item?.Plant ?? legacy?.Plant ?? null,
            PurchasingGroup:
              item?.PurchasingGroup ?? legacy?.PurchasingGroup ?? null,
            title: legacy?.itemTitle ?? `${PurchaseOrder}/${PurchaseOrderItem}`,
          });
        }
        const currentCase = await SELECT.one
          .from(`${NS}.Cases`)
          .where({ ID: link.ID });
        if (!currentCase) throw fail(404, `Case ${link.ID} not found`);
        if (currentCase.status !== "open")
          throw fail(409, `Case ${link.ID} is closed`);
        fingerprints.set(link.ID, currentCase.sourceFingerprint ?? null);
        const claimed = await UPDATE.entity(`${NS}.Cases`)
          .set({ sourceRevision: currentCase.sourceRevision })
          .where({
            ID: link.ID,
            status: "open",
            sourceRevision: currentCase.sourceRevision,
            sourceFingerprint: currentCase.sourceFingerprint ?? null,
          });
        if (Number(claimed) !== 1)
          throw fail(
            409,
            "Case evidence changed concurrently; reload before preparing an action",
          );
      }
      // Reserve uniqueness before inserting the aggregate: a duplicate cannot
      // leave an orphan Action behind when a compatibility adapter reuses it.
      if (requestedCases.length)
        await INSERT.into(`${NS}.OperationLocks`).entries(
          requestedCases.map((link) => ({
            header_ID: link.ID,
            operation: link.operation,
            action_ID: ID,
          })),
        );
      await INSERT.into(`${NS}.Actions`).entries({
        ID,
        kind: input.kind,
        status: "needs_decision",
        objectKey: input.objectKey,
        problemKey,
        operationKey,
        exportFormat,
        preparedVia: input.via,
        title: String(input.title).slice(0, 200),
        summary:
          input.summary == null ? null : String(input.summary).slice(0, 1000),
        findingID: input.findingID ?? null,
        requestType,
        decisionReady: readiness.decisionReady,
        decisionBlockReason: readiness.decisionBlockReason,
        chain: input.chain == null ? null : String(input.chain).slice(0, 1000),
        responsiblePerson:
          input.responsiblePerson == null
            ? null
            : String(input.responsiblePerson).slice(0, 120),
        responsibleMessage:
          input.responsibleMessage == null
            ? null
            : String(input.responsibleMessage).slice(0, 1000),
        items: input.items.map((i, n) => ({
          ID: cds.utils.uuid(),
          line: n + 1,
          objectKey: i.objectKey,
          problemKey: i.problemKey ?? problemKey,
          operationKey: i.operationKey ?? operationKey,
          findingID: i.findingID ?? input.findingID ?? null,
          field: i.field ?? null,
          oldValue: i.oldValue == null ? null : String(i.oldValue).slice(0, 80),
          newValue: i.newValue == null ? null : String(i.newValue).slice(0, 80),
          text: i.text == null ? null : String(i.text).slice(0, 1000),
          data: i.data ? JSON.stringify(i.data) : null,
        })),
      });
      if (requestedCases.length) {
        await INSERT.into(`${NS}.CaseActions`).entries(
          await Promise.all(
            requestedCases.map(async (link) => ({
              header_ID: link.ID,
              action_ID: ID,
              operation: link.operation,
              role: link.role ?? "primary",
              sourceFingerprint: fingerprints.get(link.ID),
            })),
          ),
        );
        await INSERT.into(`${NS}.CaseEvents`).entries(
          requestedCases.map((link) => ({
            ID: cds.utils.uuid(),
            header_ID: link.ID,
            occurredAt: new Date().toISOString(),
            event: "action_prepared",
            actor: cds.context?.user?.id ?? null,
            reason: `Prepared ${input.kind.replace(/_/g, " ")}`,
            command_ID: currentWorkflowCommand() ?? null,
          })),
        );
      }
      await INSERT.into(`${NS}.ActionEvents`).entries({
        ID: cds.utils.uuid(),
        action_ID: ID,
        occurredAt: new Date().toISOString(),
        event: "prepared",
        toStatus: "needs_decision",
        source: input.via,
        actor: cds.context?.user?.id ?? null,
        command_ID: currentWorkflowCommand() ?? null,
      });
      await emit({
        kind: "action",
        title: `Prepared: ${String(input.title).slice(0, 280)}`,
        objectKey: input.objectKey,
        findingID: input.findingID ?? null,
        status: "needs_decision",
      });
      for (const link of requestedCases)
        await acknowledgeSourceChange(link.ID, fingerprints.get(link.ID));
      await touchCasesForAction(ID);
      return readAction(ID);
    });
  } catch (error: any) {
    if (error?.status === 409) throw error;
    for (const link of requestedCases) {
      const existing = await activeCaseAction(link.ID, link.operation);
      if (existing)
        throw fail(
          409,
          `An active ${link.operation} for ${link.ID} exists already`,
          { actionID: existing.ID },
        );
    }
    if (!requestedCases.length)
      for (const lock of locks) {
        const existing = await activeApproval(
          lock.problemKey,
          lock.operationKey,
        );
        if (existing)
          throw fail(
            409,
            `An active ${lock.operationKey} for ${lock.problemKey} exists already`,
            { actionID: existing.ID },
          );
      }
    throw error;
  }
}

/** CSV of a decided action (404 unknown, 409 still needs_decision/declined). */
export async function exportActionCsv(ID: string, user?: cds.User) {
  await assertApprovalVisible(ID, user);
  const a = await SELECT.one.from(`${NS}.Actions`).where({ ID });
  if (!a) throw fail(404, "Action not found");
  throw fail(
    410,
    "Action export has been removed; inspect the frozen instructions in Approvals",
  );
}

// ---------------------------------------------------- legacy creators

/** Reminder draft for open PO items (legacy worklist / chat): an existing pending one of a single item is returned. */
export async function prepareReminderAction(
  itemKeys: string[],
  via: ActionVia,
) {
  const keys = [
    ...new Set(itemKeys.map((k) => String(k).trim()).filter(Boolean)),
  ];
  if (!keys.length) throw fail(400, "Select at least one open PO item");
  if (keys.length > MAX_REMINDER_ITEMS)
    throw fail(400, `Select at most ${MAX_REMINDER_ITEMS} items`);
  const items: Row[] = [];
  for (const k of keys) {
    const [PurchaseOrder, PurchaseOrderItem] = k.split("/");
    const i = await SELECT.one
      .from(`${NS}.OpenItem`)
      .where({ PurchaseOrder, PurchaseOrderItem });
    if (!i)
      throw fail(
        400,
        `${PurchaseOrder}/${PurchaseOrderItem} is not an open item`,
      );
    items.push(i);
  }
  const single = keys.length === 1;
  const objectKey = single
    ? keys[0]
    : `${items[0].Supplier}:${keys.length} items`;
  const suppliers = [
    ...new Set(items.map((i) => i.SupplierName ?? i.Supplier)),
  ];
  return reuse409(() =>
    prepareAction({
      kind: "reminder",
      objectKey,
      problemKey: single
        ? deliveryProblemKey(items[0].PurchaseOrder, items[0].PurchaseOrderItem)
        : `delivery-batch:${keys.sort().join(",")}`,
      operationKey: "delivery_intervention",
      exportFormat: "reminder",
      cases: items.map((item) => ({
        ID: deliveryProblemKey(item.PurchaseOrder, item.PurchaseOrderItem),
        operation: "delivery_intervention",
        role: "primary",
      })),
      via,
      title: `Reminder to ${suppliers.join(", ")} for ${keys.length} item(s)`,
      summary: items
        .map(
          (i) =>
            `${i.PurchaseOrder}/${i.PurchaseOrderItem} ${i.MaterialText ?? i.Material}: requested ${i.RequestedDate}, expected ${i.expectedP50}–${i.expectedP80}` +
            (i.revenueAtRiskP80
              ? `, EUR ${i.revenueAtRiskP80} customer revenue at risk`
              : ""),
        )
        .join("\n"),
      items: items.map((i) => ({
        objectKey: `${i.PurchaseOrder}/${i.PurchaseOrderItem}`,
        problemKey: deliveryProblemKey(i.PurchaseOrder, i.PurchaseOrderItem),
        operationKey: "delivery_intervention",
        field: "ScheduleLineDeliveryDate",
        oldValue: i.RequestedDate,
        newValue: i.expectedP50,
        text:
          `Dear ${i.SupplierName ?? i.Supplier}, please confirm the delivery date of PO ${i.PurchaseOrder} item ${i.PurchaseOrderItem} ` +
          `(${i.MaterialText ?? i.Material}, ${i.OpenQuantity} ${i.Unit ?? ""}), requested for ${i.RequestedDate}. ` +
          `Our planning expects it around ${i.expectedP50}.`,
        data: {
          PurchaseOrder: i.PurchaseOrder,
          PurchaseOrderItem: i.PurchaseOrderItem,
        },
      })),
    }),
  );
}

/** Change list line for a source finding's planned delivery time (legacy); an existing pending one is returned. */
export async function addToChangeListAction(
  source: { Material: string; Supplier: string; Plant: string },
  days: number | null | undefined,
  via: ActionVia,
  findingID: string | null = null,
) {
  return inTx(async () => {
    const user = cds.context?.user ?? cds.User.privileged;
    const objectKey = `${source.Material}|${source.Supplier}|${source.Plant}`;
    const caseID = `pdt:${objectKey}`;
    let header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (!header) {
      const f = await SELECT.one.from(`${NS}.SourceFinding`).where(source);
      if (!f || !inScope(scopeOf(user), f))
        throw fail(404, "No finding for this source");
      const { upsertTypedCase } = await import("./typed-cases.js");
      await upsertTypedCase({
        list: "pdt",
        objectKey,
        ...source,
        PurchasingGroup: f.PurchasingGroup,
        itemTitle: `${f.MaterialText ?? f.Material} / ${f.SupplierName ?? f.Supplier} / ${f.Plant}`,
        issue: f.reason,
        source: f.proposalSource,
        pdtDetail: {
          proposalDays: f.proposalDays,
          proposalQuantile: f.proposalQuantile,
          proposalRule: "p80",
          currentDays: f.currentDays,
          currentFrom: f.currentFrom,
          masterDays: f.masterDays,
          purchasingInfoRecord: f.PurchasingInfoRecord,
          ownDeliveries: f.ownDeliveries,
          p10: f.p10,
          p50: f.p50,
          p80: f.p80,
          p90: f.p90,
          orders12m: f.orders12m ?? null,
          value12mEUR: f.value12mEUR ?? null,
          rangeSource: null,
          rangeCount: null,
          rangeP10: null,
          rangeP50: null,
          rangeP80: null,
          rangeP90: null,
          rangeSentence: null,
        },
      });
      header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    }
    const { prepareCaseAction } = await import("./case-preparation.js");
    return prepareCaseAction(caseID, via, user, {
      days,
      findingID: findingID ?? undefined,
      expectedFingerprint: header.sourceFingerprint,
    });
  });
}

/** Legacy semantics: a duplicate pending action is returned instead of refused. */
export async function reuse409(create: () => Promise<any>) {
  try {
    return await create();
  } catch (e: any) {
    if (e?.status === 409 && e.actionID) return readAction(e.actionID);
    throw e;
  }
}

// ------------------------------------------------- prepareFindingAction

export type FindingActionBuilder = (
  finding: Row,
  via: ActionVia,
) => Promise<PrepareActionInput>;
const builders = new Map<string, FindingActionBuilder>();

/** A list owner may shape the action of its findings (called from its register()). */
export function registerFindingActionBuilder(
  list: FindingList,
  builder: FindingActionBuilder,
) {
  builders.set(list, builder);
}

/** H-4: the supplier text states the rule reason only (no probability, revenue or customer). */
const REMINDER_REASON: Partial<
  Record<FindingList, [ask: string, reason: string]>
> = {
  overdue: [
    "please confirm the delivery date",
    "The requested date has passed and we have not received the goods.",
  ],
  at_risk: [
    "please confirm the delivery date",
    "Please confirm that the requested date can be met.",
  ],
};

function defaultBuilder(f: Row, via: ActionVia): PrepareActionInput {
  const kind = f.nextActionKind as ActionKind;
  const operationKey = operationForFinding(f.list);
  const caseID =
    ["at_risk", "overdue"].includes(f.list) &&
    f.PurchaseOrder &&
    f.PurchaseOrderItem
      ? `delivery:${f.PurchaseOrder}/${f.PurchaseOrderItem}`
      : ["price", "duplicate", "rare", "pdt", "mm_pdt"].includes(f.list)
        ? `${f.list}:${f.objectKey}`
        : null;
  const cases = caseID
    ? [{ ID: caseID, operation: operationKey, role: "primary" as const }]
    : undefined;
  const base = {
    kind,
    objectKey: f.objectKey,
    problemKey: findingProblemKey(f),
    operationKey,
    exportFormat: exportFormatFor(kind),
    via,
    findingID: f.ID,
    chain: f.chain,
    cases,
  };
  const title = `${f.nextStep || kind}: ${f.itemTitle || f.objectKey}`;
  const summary = [f.issue, f.impactText].filter(Boolean).join(" · ");
  if (kind === "reminder") {
    const [ask, reason] = REMINDER_REASON[f.list as FindingList] ?? [
      "please confirm the delivery date",
      "",
    ];
    return {
      ...base,
      title,
      summary,
      items: [
        {
          objectKey: f.PurchaseOrder
            ? `${f.PurchaseOrder}/${f.PurchaseOrderItem}`
            : f.objectKey,
          field: "ScheduleLineDeliveryDate",
          text: `Dear supplier ${f.Supplier ?? ""}, regarding purchase order ${f.PurchaseOrder ?? ""} item ${f.PurchaseOrderItem ?? ""}: ${ask}. ${reason}`
            .replace(/\s+/g, " ")
            .trim(),
          data: {
            PurchaseOrder: f.PurchaseOrder,
            PurchaseOrderItem: f.PurchaseOrderItem,
            ask,
          },
        },
      ],
    };
  }
  return {
    ...base,
    title,
    summary,
    items: [
      {
        objectKey: f.objectKey,
        text: f.issue,
        data: {
          PurchaseOrder: f.PurchaseOrder,
          PurchaseOrderItem: f.PurchaseOrderItem,
          source: f.source,
          reason: f.issue,
        },
      },
    ],
  };
}

function caseLinkForFinding(f: Row) {
  const ID =
    ["at_risk", "overdue"].includes(f.list) &&
    f.PurchaseOrder &&
    f.PurchaseOrderItem
      ? `delivery:${f.PurchaseOrder}/${f.PurchaseOrderItem}`
      : ["price", "duplicate", "rare", "pdt", "mm_pdt"].includes(f.list)
        ? `${f.list}:${f.objectKey}`
        : null;
  return ID
    ? {
        ID,
        operation: operationForFinding(f.list as FindingList),
        role: "primary" as const,
      }
    : null;
}

/** Prepares the finding's explicitly proposed next step; 404 / 409 as for prepareAction. */
export async function prepareFindingAction(
  findingID: string,
  via: ActionVia = "app",
) {
  const f = await SELECT.one.from(`${NS}.Finding`).where({ ID: findingID });
  if (!f) throw fail(404, "Finding not found");
  if (!inScope(scopeOf(cds.context?.user ?? cds.User.privileged), f))
    throw fail(404, "Finding not found");
  if (f.list === "pdt" && !currentWorkflowCommand())
    throw fail(
      410,
      "Supplier preparation requires WorkflowService.prepareSupplierPlannedTimeAction",
    );
  if (f.list === "pdt") {
    const caseID = `pdt:${f.objectKey}`;
    const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    if (header) {
      const pending = await activeCaseAction(caseID, "pdt_change");
      if (pending)
        throw fail(
          409,
          "An active supplier planned-time change exists already",
          { actionID: pending.ID },
        );
      const { prepareCaseAction } = await import("./case-preparation.js");
      return prepareCaseAction(
        caseID,
        via,
        cds.context?.user ?? cds.User.privileged,
        {
          findingID,
          expectedFingerprint: header.sourceFingerprint,
        },
      );
    }
  }
  if (["at_risk", "overdue"].includes(f.list)) {
    const caseID = deliveryProblemKey(f.PurchaseOrder, f.PurchaseOrderItem);
    if (
      await SELECT.one.from(`${NS}.DeliveryRisks`).where({ header_ID: caseID })
    ) {
      const { prepareDeliveryCase } = await import("./case-preparation.js");
      return prepareDeliveryCase(
        caseID,
        via,
        cds.context?.user ?? cds.User.privileged,
        findingID,
      );
    }
  }
  if (f.list === "at_risk")
    f.atRiskDetail = await SELECT.one
      .from(`${NS}.AtRiskDetail`)
      .where({ finding_ID: findingID });
  if (f.list === "overdue")
    f.overdueDetail = await SELECT.one
      .from(`${NS}.OverdueDetail`)
      .where({ finding_ID: findingID });
  if (f.list === "price")
    f.priceDetail = await SELECT.one
      .from(`${NS}.PriceDetail`)
      .where({ finding_ID: findingID });
  if (f.list === "pdt")
    f.pdtDetail = await SELECT.one
      .from(`${NS}.PdtDetail`)
      .where({ finding_ID: findingID });
  if (f.list === "mm_pdt")
    f.mmPdtDetail = await SELECT.one
      .from(`${NS}.MmPdtDetail`)
      .where({ finding_ID: findingID });
  if (!f.nextActionKind)
    throw fail(409, "This finding has no action to prepare");
  if (
    f.nextActionKind === "pdt_change" &&
    f.Material &&
    f.Supplier &&
    f.Plant &&
    !builders.has(f.list)
  ) {
    const source = {
      Material: f.Material,
      Supplier: f.Supplier,
      Plant: f.Plant,
    };
    if (await SELECT.one.from(`${NS}.SourceFinding`).where(source)) {
      const pending = await activeApproval(findingProblemKey(f), "pdt_change");
      if (pending)
        throw fail(
          409,
          `An active pdt_change for ${pending.objectKey} exists already`,
          { actionID: pending.ID },
        );
      const a = await addToChangeListAction(source, null, via, f.ID);
      await UPDATE.entity(`${NS}.Actions`, a.ID).with({
        chain: f.chain ?? null,
      });
      return readAction(a.ID);
    }
  }
  const build = builders.get(f.list);
  const input = build ? await build(f, via) : defaultBuilder(f, via);
  if (!input.cases?.length) {
    const link = caseLinkForFinding(f);
    // During the additive v3 -> v4 migration, retained legacy findings may not
    // have a case yet. Link dual-written rows without breaking those callers.
    if (
      link &&
      (await SELECT.one
        .from(`${NS}.Cases`)
        .columns("ID")
        .where({ ID: link.ID }))
    )
      input.cases = [link];
  }
  return prepareAction(input);
}

// ---------------------------------------------- decide-in-context (unify)

/**
 * Prepares the finding's next step but leaves it in needs_decision for a
 * later decision in Approvals. If an active request already exists, return it
 * so source screens can direct the buyer to the existing approval instead of
 * creating a duplicate.
 */
export async function queueFindingForLater(
  findingID: string,
  via: ActionVia = "app",
) {
  const f = await SELECT.one.from(`${NS}.Finding`).where({ ID: findingID });
  if (!f) throw fail(404, "Finding not found");
  const active = await activeApproval(
    f.problemKey ?? findingProblemKey(f),
    operationForFinding(f.list),
  );
  if (active) return readAction(active.ID);
  return reuse409(() => prepareFindingAction(findingID, via));
}

// -------------------------------------------------- decide / decline / log outcome (Actions)

/** Approvals object page / MCP-adjacent entry points onto the action-state machine. */
export async function decideActionNow(
  ID: string,
  decidedBy: string,
  note?: string | null,
  expectedModifiedAt?: string | null,
) {
  const asOf = (await asOfDate()) ?? new Date().toISOString().slice(0, 10);
  return decide(ID, { decidedBy, note, asOf, expectedModifiedAt });
}

export async function declineAction(
  ID: string,
  decidedBy: string,
  note: string,
  expectedModifiedAt?: string | null,
) {
  return decline(ID, decidedBy, note, expectedModifiedAt);
}

export async function logActionOutcome(ID: string, input: LogOutcomeInput) {
  return logOutcome(ID, input);
}

// -------------------------------------------------- resolve (close the loop)
//
// Resolution is stored on Action; source reconciliation or an explicit
// exception closes the linked business case.
