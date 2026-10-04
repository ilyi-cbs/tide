import cds from "@sap/cds";
import { createHash } from "node:crypto";
import {
  requireBuyer,
  submitRequisitionReview,
} from "./cockpit/freetext/review";
import { acceptException } from "./cockpit/kernel/cases";
import {
  CASE_ENTITIES,
  prepareCaseAction,
} from "./cockpit/kernel/case-preparation";
import {
  materialSetting,
  supplierSetting,
} from "./cockpit/kernel/typed-cases";
import {
  decideActionNow,
  declineAction,
  prepareReminderAction,
} from "./cockpit/kernel/actions";
import { logOutcome } from "./cockpit/kernel/action-state";
import { enterConfirmation } from "./cockpit/rules/enter-confirmation";
import { inCommandScope } from "./cockpit/kernel/auth";
import {
  currentWorkflowOrigin,
  executeWorkflowCommand,
  readWorkflowCommandResult,
  type CommandSubject,
} from "./cockpit/kernel/commands";
import { fail } from "./cockpit/kernel/errors";
import { NS, type Row } from "./cockpit/kernel/model-calls";

const { SELECT, INSERT, UPDATE } = cds.ql;

async function deliveryReminderContext(items: unknown, user: cds.User) {
  if (!Array.isArray(items) || !items.length || items.length > 100 ||
    items.some(item => typeof item !== "string" || !/^[^/]+\/[^/]+$/.test(item)))
    throw fail(400, "Select valid purchase order items");
  const keys = [...new Set<string>(items)].sort();
  const evidence = [];
  for (const key of keys) {
    const [PurchaseOrder, PurchaseOrderItem] = key.split("/");
    const row = await SELECT.one.from(`${NS}.OpenItem`).where({ PurchaseOrder, PurchaseOrderItem });
    const source = await SELECT.one.from(`${NS}.ItemFactSource`).where({ PurchaseOrder, PurchaseOrderItem });
    const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: `delivery:${key}` });
    if (!row || !source || !inCommandScope(user, source) ||
      (header && (header.kind !== "delivery" || !inCommandScope(user, header))))
      throw fail(404, "Purchase order item not found");
    if (header?.status === "closed") throw fail(409, "Delivery Case is closed");
    evidence.push({ row, source, header: header ?? null });
  }
  const expectedEvidence = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  return {
    items: keys, expectedEvidence,
    instructions: evidence.map(({ row }) =>
      `${row.PurchaseOrder}/${row.PurchaseOrderItem}: confirm delivery of ${row.MaterialText ?? row.Material}; requested ${row.RequestedDate}, planning expects ${row.expectedP50 ?? "unknown"}.`),
  };
}

async function authorizeSubjects(
  user: cds.User,
  subjects: readonly CommandSubject[],
  allKinds = false,
) {
  const allowedKinds = allKinds
    ? [
        "delivery",
        "price",
        "duplicate",
        "unusual_setting",
        "supplier_planned_time",
        "material_planned_time",
        "requisition_review",
      ]
    : ["supplier_planned_time"];
  for (const subject of subjects) {
    let caseIDs: string[];
    if (subject.kind === "case") caseIDs = [subject.ID];
    else if (subject.kind === "action") {
      const action = await SELECT.one
        .from(`${NS}.Actions`)
        .where({ ID: subject.ID });
      if (!action) throw fail(404, "Action not found");
      const links: Row[] = await SELECT.from(`${NS}.CaseActions`).where({
        action_ID: subject.ID,
      });
      caseIDs = [...new Set(links.map((link) => String(link.header_ID)))];
      if (!caseIDs.length) throw fail(404, "Action has no authorized Cases");
    } else throw fail(400, "Unsupported pilot subject");
    for (const caseID of caseIDs) {
      const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
      if (
        !row ||
        !allowedKinds.includes(row.kind) ||
        !inCommandScope(user, row)
      )
        throw fail(404, "Case not found");
      if (row.kind === "requisition_review") {
        const typed = await SELECT.one
          .from(`${NS}.RequisitionReviews`)
          .where({ header_ID: caseID });
        const source =
          typed &&
          (await SELECT.one.from(`${NS}.FreetextWorkItem`).where({
            PurchaseRequisition: typed.PurchaseRequisition,
            PurchaseRequisitionItem: typed.PurchaseRequisitionItem,
          }));
        if (!source) throw fail(404, "Review not found");
        requireBuyer({ user }, source);
      }
    }
  }
}

async function claimSupplierOperation(
  caseID: string,
  action: Row | null,
  receiptID: string,
) {
  const row = await SELECT.one
    .from(`${NS}.SupplierPlannedTimes`)
    .where({ header_ID: caseID });
  const detail = JSON.parse(row.detail ?? "{}");
  const materialMaster = detail.currentFrom === "material master";
  const record = row.purchasingInfoRecord ?? detail.PurchasingInfoRecord;
  if (
    !row.Plant ||
    (!materialMaster && !record) ||
    (materialMaster && !row.Material)
  )
    throw fail(
      409,
      "Maintained source identity is incomplete; reconcile the source before preparing work",
    );
  const identity = {
    tenant: cds.context?.tenant ?? "",
    sourceSystem: "tide.s4",
    kind: materialMaster ? "MaterialPlant" : "PurchasingInfoRecordPlant",
    subjectKey: JSON.stringify([
      materialMaster ? row.Material : record,
      row.Plant,
    ]),
  };
  const claims = [
    { ...identity, claimType: "case", slot: "supplier_planned_time" },
    ...(action
      ? [
          {
            ...identity,
            claimType: "action",
            slot: `${materialMaster ? "PlannedDeliveryDurationInDays" : "MaterialPlannedDeliveryDurn"}:${action.operationKey}`,
          },
        ]
      : []),
  ];
  return retainClaims(claims, caseID, action, receiptID);
}

async function retainClaims(
  claims: Row[],
  caseID: string,
  action: Row | null,
  receiptID: string,
) {
  for (const claim of claims) {
    try {
      await INSERT.into("tide.workflow.SubjectClaims").entries({
        ...claim,
        caseID,
        actionID: claim.claimType === "action" ? action!.ID : null,
        commandID: receiptID,
      });
    } catch (error) {
      const current = await SELECT.one
        .from("tide.workflow.SubjectClaims")
        .where(claim);
      if (!current) throw error;
      if (
        current.caseID !== caseID ||
        (claim.claimType === "action" && current.actionID !== action!.ID)
      )
        throw fail(
          409,
          "An active Case or Action already owns this source operation",
        );
    }
  }
}

async function claimCaseOperation(header: Row, action: Row | null, receiptID: string) {
  const row = await SELECT.one
    .from(`${NS}.${CASE_ENTITIES[header.kind]}`)
    .where({ header_ID: header.ID });
  if (!row) throw fail(409, "Represented source identity is missing");
  let kind: string;
  let subjects: unknown[][];
  let field: string;
  switch (header.kind) {
    case "delivery":
      kind = "PurchaseOrderItem";
      subjects = [[row.PurchaseOrder, row.PurchaseOrderItem]];
      field = "delivery_follow_up";
      break;
    case "price":
      kind = "PurchasingPriceContext";
      subjects = [[row.Material, row.Supplier, row.Plant]];
      field = "price_clarification";
      break;
    case "duplicate":
      kind = "MaterialPlant";
      subjects = [
        ...new Set(
          String(row.materialNumbers ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ]
        .sort()
        .map((material) => [material, row.Plant]);
      field = "duplicate_review";
      break;
    case "unusual_setting":
      kind = "MaterialPlant";
      subjects = [[row.Material, row.Plant]];
      field = "planning_setting_review";
      break;
    case "material_planned_time":
      kind = "MaterialPlant";
      subjects = [[row.material, row.plant]];
      field = "PlannedDeliveryDurationInDays";
      break;
    case "requisition_review":
      kind = "PurchaseRequisitionItem";
      subjects = [[row.PurchaseRequisition, row.PurchaseRequisitionItem]];
      field = "reviewed_order";
      break;
    default:
      throw fail(400, "Unsupported Case claim policy");
  }
  if (
    !subjects.length ||
    subjects.some((subject) =>
      subject.some((value) => typeof value !== "string" || !value.trim()),
    )
  )
    throw fail(
      409,
      "Represented source identity is incomplete; reconcile before preparing work",
    );
  const claims = subjects.flatMap((subject) => {
    const identity = {
      tenant: cds.context?.tenant ?? "",
      sourceSystem: "tide.s4",
      kind,
      subjectKey: JSON.stringify(subject),
    };
    return [
      { ...identity, claimType: "case", slot: header.kind },
      ...(action
        ? [{ ...identity, claimType: "action", slot: `${field}:${action.operationKey}` }]
        : []),
    ];
  });
  return retainClaims(claims, header.ID, action, receiptID);
}

function assertVersion(row: Row, expected: unknown) {
  if (typeof expected !== "string" || !Number.isFinite(Date.parse(expected)))
    throw fail(400, "expectedModifiedAt is required");
  if (
    new Date(expected).toISOString() !== new Date(row.modifiedAt).toISOString()
  )
    throw fail(409, "Version changed; reload before issuing a new command");
}

function assertFingerprint(row: Row, expected: unknown) {
  if (typeof expected !== "string" || !expected.trim())
    throw fail(400, "expectedFingerprint is required");
  if (expected !== row.sourceFingerprint)
    throw fail(
      409,
      "Case evidence changed; reload before issuing a new command",
    );
}

async function resultForCase(caseID: string, actionID?: string) {
  const row = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  const action = actionID
    ? await SELECT.one.from(`${NS}.Actions`).where({ ID: actionID })
    : null;
  return {
    caseID,
    caseModifiedAt: row.modifiedAt,
    ...(action ? { actionID, actionModifiedAt: action.modifiedAt } : {}),
    status: action?.status ?? row.status,
    ...(row.closure ? { closure: row.closure } : {}),
    sourceFingerprint: row.sourceFingerprint,
    listing: row.listing,
  };
}

export default class WorkflowService extends cds.ApplicationService {
  async init() {
    const authorize =
      (req: cds.Request, allKinds = false) =>
      (subjects: readonly CommandSubject[]) =>
        authorizeSubjects(req.user, subjects, allKinds);
    this.on("deliveryPreparationContext", async (req: cds.Request) =>
      JSON.stringify(await deliveryReminderContext(req.data.items, req.user)));
    this.on("prepareDeliveryReminder", (req: cds.Request) => {
      const { items, commandID, expectedEvidence } = req.data;
      const subjects: CommandSubject[] = Array.isArray(items)
        ? [...new Set<string>(items)].map(key => ({ kind: "case", ID: `delivery:${key}` })) : [];
      return executeWorkflowCommand({ commandID, commandType: "prepareDeliveryReminder",
        arguments: { items, expectedEvidence }, subjects }, {
        authorize: async retained => {
          const headers = await SELECT.from(`${NS}.Cases`).where({ ID: { in: retained.map(subject => subject.ID) } });
          if (headers.length === retained.length) await authorizeSubjects(req.user, retained, true);
          else await deliveryReminderContext(items, req.user);
        },
        execute: async receiptID => {
          const reviewed = await deliveryReminderContext(items, req.user);
          if (typeof expectedEvidence !== "string" || reviewed.expectedEvidence !== expectedEvidence)
            throw fail(409, "Delivery evidence changed; review the current instructions before preparing again");
          for (const key of reviewed.items) {
            const lock = await SELECT.one.from(`${NS}.OperationLocks`).where({ header_ID: `delivery:${key}`, operation: "delivery_intervention" });
            if (lock) throw fail(409, "An active delivery intervention already exists");
          }
          const action = await prepareReminderAction(reviewed.items, currentWorkflowOrigin());
          for (const key of reviewed.items) {
            const identity = { tenant: cds.context?.tenant ?? "", sourceSystem: "tide.s4", kind: "PurchaseOrderItem", subjectKey: JSON.stringify(key.split("/")) };
            await retainClaims([
              { ...identity, claimType: "case", slot: "delivery" },
              { ...identity, claimType: "action", slot: "delivery_follow_up:delivery_intervention" },
            ], `delivery:${key}`, action, receiptID);
          }
          return resultForCase(`delivery:${reviewed.items[0]}`, action.ID);
        },
      });
    });
    this.on("enterConfirmation", (req: cds.Request) => {
      const { PurchaseOrder, PurchaseOrderItem, date, quantity, commandID } = req.data;
      const key = `${PurchaseOrder}/${PurchaseOrderItem}`;
      return executeWorkflowCommand({ commandID, commandType: "enterConfirmation",
        arguments: { PurchaseOrder, PurchaseOrderItem, date, quantity },
        subjects: [{ kind: "case", ID: `delivery:${key}` }] }, {
        authorize: async () => {
          const source = await SELECT.one.from(`${NS}.ItemFactSource`).where({ PurchaseOrder, PurchaseOrderItem });
          if (!source || !inCommandScope(req.user, source)) throw fail(404, "Purchase order item not found");
        },
        execute: async () => {
          await enterConfirmation(req);
          const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: `delivery:${key}` });
          return header ? resultForCase(header.ID) : { caseID: `delivery:${key}`, status: "recorded" };
        },
      });
    });
    this.on("submitRequisitionReview", (req: cds.Request) => {
      const { caseID, commandID, expectedModifiedAt, expectedReviewToken } =
        req.data;
      return executeWorkflowCommand(
        {
          commandID,
          commandType: "submitRequisitionReview",
          arguments: { caseID, expectedModifiedAt, expectedReviewToken },
          subjects: [{ kind: "case", ID: caseID }],
        },
        {
          authorize: authorize(req, true),
          execute: async (receiptID) => {
            const row = await SELECT.one
              .from(`${NS}.Cases`)
              .where({ ID: caseID });
            if (row.kind !== "requisition_review")
              throw fail(400, "Requisition Review required");
            const action = await submitRequisitionReview(caseID, req.user, {
              expectedModifiedAt,
              expectedReviewToken,
            });
            await claimCaseOperation(row, action, receiptID);
            const submission = await SELECT.one
              .from(`${NS}.FreetextSubmission`)
              .where({ action_ID: action.ID });
            const review = await SELECT.one.from(`${NS}.FreetextReview`).where({
              PurchaseRequisition: submission.PurchaseRequisition,
              PurchaseRequisitionItem: submission.PurchaseRequisitionItem,
            });
            return {
              ...(await resultForCase(caseID, action.ID)),
              submissionID: submission.ID,
              reviewModifiedAt: review.modifiedAt,
            };
          },
        },
      );
    });
    this.on("prepareCaseAction", (req: cds.Request) => {
      const {
        caseID,
        commandID,
        expectedModifiedAt,
        expectedFingerprint,
        responsiblePerson,
        responsibleMessage,
      } = req.data;
      return executeWorkflowCommand(
        {
          commandID,
          commandType: "prepareCaseAction",
          arguments: {
            caseID,
            expectedModifiedAt,
            expectedFingerprint,
            responsiblePerson: responsiblePerson ?? null,
            responsibleMessage: responsibleMessage ?? null,
          },
          subjects: [{ kind: "case", ID: caseID }],
        },
        {
          authorize: authorize(req, true),
          execute: async (receiptID) => {
            const row = await SELECT.one
              .from(`${NS}.Cases`)
              .where({ ID: caseID });
            if (
              ["supplier_planned_time", "requisition_review"].includes(row.kind)
            )
              throw fail(
                400,
                "Use the operation-specific supplier or Review submission command",
              );
            assertVersion(row, expectedModifiedAt);
            assertFingerprint(row, expectedFingerprint);
            const action = await prepareCaseAction(caseID, currentWorkflowOrigin(), req.user, {
              expectedFingerprint,
              responsiblePerson,
              responsibleMessage,
            });
            await claimCaseOperation(row, action, receiptID);
            return resultForCase(caseID, action.ID);
          },
        },
      );
    });
    this.on("acceptCaseException", (req: cds.Request) => {
      const {
        caseID,
        note,
        commandID,
        expectedModifiedAt,
        expectedFingerprint,
      } = req.data;
      return executeWorkflowCommand(
        {
          commandID,
          commandType: "acceptCaseException",
          arguments: { caseID, note, expectedModifiedAt, expectedFingerprint },
          subjects: [{ kind: "case", ID: caseID }],
        },
        {
          authorize: authorize(req, true),
          execute: async (receiptID) => {
            const row = await SELECT.one
              .from(`${NS}.Cases`)
              .where({ ID: caseID });
            if (
              ![
                "price",
                "duplicate",
                "unusual_setting",
                "material_planned_time",
              ].includes(row.kind)
            )
              throw fail(
                400,
                "This Case requires its operation-specific disposition command",
              );
            assertVersion(row, expectedModifiedAt);
            assertFingerprint(row, expectedFingerprint);
            if (typeof note !== "string" || !note.trim())
              throw fail(400, "A business reason is required");
            if (
              await SELECT.one
                .from(`${NS}.OperationLocks`)
                .where({ header_ID: caseID })
            )
              throw fail(
                409,
                "Review the active Action before accepting an exception",
              );
            let sourceCondition: string | undefined;
            if (row.kind === "material_planned_time") {
              const typed = await SELECT.one
                .from(`${NS}.MaterialPlannedTimes`)
                .where({ header_ID: caseID });
              const detail = JSON.parse(typed?.detail ?? "{}");
              const setting =
                typed &&
                materialSetting(
                  { Material: typed.material, Plant: typed.plant },
                  {
                    masterDays: Object.hasOwn(detail, "masterDays")
                      ? detail.masterDays
                      : typed.currentDays,
                  },
                );
              if (!setting)
                throw fail(
                  409,
                  "Maintained material setting is incomplete; reconcile the source before accepting an exception",
                );
              sourceCondition = setting;
            }
            await claimCaseOperation(row, null, receiptID);
            await acceptException(
              caseID,
              expectedFingerprint,
              note.trim(),
              sourceCondition,
            );
            return resultForCase(caseID);
          },
        },
      );
    });
    this.on("prepareSupplierPlannedTimeAction", (req: cds.Request) => {
      const {
        caseID,
        days,
        commandID,
        expectedModifiedAt,
        expectedFingerprint,
      } = req.data;
      return executeWorkflowCommand(
        {
          commandID,
          commandType: "prepareSupplierPlannedTimeAction",
          arguments: {
            caseID,
            days: days ?? null,
            expectedModifiedAt,
            expectedFingerprint,
          },
          subjects: [{ kind: "case", ID: caseID }],
        },
        {
          authorize: authorize(req),
          execute: async (receiptID) => {
            const row = await SELECT.one
              .from(`${NS}.Cases`)
              .where({ ID: caseID });
            assertVersion(row, expectedModifiedAt);
            assertFingerprint(row, expectedFingerprint);
            const action = await prepareCaseAction(caseID, currentWorkflowOrigin(), req.user, {
              days,
              expectedFingerprint,
            });
            await claimSupplierOperation(caseID, action, receiptID);
            return resultForCase(caseID, action.ID);
          },
        },
      );
    });
    this.on("acceptSupplierPlannedTimeException", (req: cds.Request) => {
      const {
        caseID,
        note,
        commandID,
        expectedModifiedAt,
        expectedFingerprint,
      } = req.data;
      return executeWorkflowCommand(
        {
          commandID,
          commandType: "acceptSupplierPlannedTimeException",
          arguments: { caseID, note, expectedModifiedAt, expectedFingerprint },
          subjects: [{ kind: "case", ID: caseID }],
        },
        {
          authorize: authorize(req),
          execute: async (receiptID) => {
            const row = await SELECT.one
              .from(`${NS}.Cases`)
              .where({ ID: caseID });
            assertVersion(row, expectedModifiedAt);
            assertFingerprint(row, expectedFingerprint);
            if (typeof note !== "string" || !note.trim())
              throw fail(400, "A business reason is required");
            const active = await SELECT.one
              .from(`${NS}.OperationLocks`)
              .where({ header_ID: caseID });
            if (active)
              throw fail(
                409,
                "Review the active Action before accepting an exception",
              );
            const detail = await SELECT.one
              .from(`${NS}.SupplierPlannedTimes`)
              .where({ header_ID: caseID });
            const sourceCondition =
              detail &&
              supplierSetting(
                {
                  Material: detail.Material,
                  Supplier: detail.supplier,
                  Plant: detail.Plant,
                },
                JSON.parse(detail.detail ?? "{}"),
              );
            if (!sourceCondition)
              throw fail(
                409,
                "The maintained setting is incomplete; reconcile before accepting an exception",
              );
            await claimSupplierOperation(caseID, null, receiptID);
            await acceptException(
              caseID,
              expectedFingerprint,
              note,
              sourceCondition,
            );
            return resultForCase(caseID);
          },
        },
      );
    });
    for (const event of ["approveAction", "declineAction"] as const)
      this.on(event, (req: cds.Request) => {
        const { actionID, note, commandID, expectedModifiedAt } = req.data;
        return executeWorkflowCommand(
          {
            commandID,
            commandType: event,
            arguments: { actionID, note: note ?? null, expectedModifiedAt },
            subjects: [{ kind: "action", ID: actionID }],
          },
          {
            authorize: authorize(req, true),
            execute: async () => {
              const action = await SELECT.one
                .from(`${NS}.Actions`)
                .where({ ID: actionID });
              assertVersion(action, expectedModifiedAt);
              if (event === "approveAction")
                await decideActionNow(
                  actionID,
                  req.user.id,
                  note ?? null,
                  expectedModifiedAt,
                );
              else
                await declineAction(
                  actionID,
                  req.user.id,
                  note,
                  expectedModifiedAt,
                );
              const link = await SELECT.one
                .from(`${NS}.CaseActions`)
                .where({ action_ID: actionID });
              return resultForCase(link.header_ID, actionID);
            },
          },
        );
      });
    this.on("commandResult", async (req: cds.Request) => {
      const result = await readWorkflowCommandResult(
        req.data.commandID,
        authorize(req, true),
        { commandType: req.data.commandType, arguments: req.data.arguments },
      );
      if (!result) throw fail(404, "Committed command not found");
      return result;
    });
    this.on("recordActionOutcome", (req: cds.Request) => {
      const {
        actionID,
        resolution,
        completeness,
        note,
        commandID,
        expectedModifiedAt,
      } = req.data;
      return executeWorkflowCommand(
        {
          commandID,
          commandType: "recordActionOutcome",
          arguments: {
            actionID,
            resolution,
            completeness,
            note,
            expectedModifiedAt,
          },
          subjects: [{ kind: "action", ID: actionID }],
        },
        {
          authorize: authorize(req, true),
          execute: async (receiptID) => {
            const action = await SELECT.one
              .from(`${NS}.Actions`)
              .where({ ID: actionID });
            assertVersion(action, expectedModifiedAt);
            const links: Row[] = await SELECT.from(`${NS}.CaseActions`).where({
              action_ID: actionID,
            });
            const supplier = await SELECT.one.from(`${NS}.Cases`).where({
              ID: { in: links.map((link) => link.header_ID) },
              kind: "supplier_planned_time",
            });
            if (supplier)
              throw fail(
                400,
                "Use recordSupplierPosting for exact supplier instructions",
              );
            if (action.status !== "waiting")
              throw fail(409, "Only approved waiting work accepts outcomes");
            const outcomes: Record<string, readonly string[]> = {
              delivery_intervention: ["confirmed", "resolved_elsewhere"],
              delivery_escalation: ["escalated", "resolved_elsewhere"],
              price_clarification: ["confirmed", "resolved_elsewhere"],
              master_data_duplicate_review: ["confirmed", "resolved_elsewhere"],
              planner_review: ["confirmed", "posted", "resolved_elsewhere"],
              pdt_change: ["posted", "resolved_elsewhere"],
              requisition_review: ["posted", "resolved_elsewhere"],
            };
            if (!outcomes[action.operationKey]?.includes(resolution))
              throw fail(400, "Outcome does not qualify for this operation");
            if (!["complete", "partial", "unknown"].includes(completeness))
              throw fail(
                400,
                "completeness must be complete, partial or unknown",
              );
            if (typeof note !== "string" || !note.trim())
              throw fail(
                400,
                "An external reference or business reason is required",
              );
            const observationID = cds.utils.uuid();
            await INSERT.into("tide.workflow.OutcomeObservations").entries({
              ID: observationID,
              actionID,
              command_ID: receiptID,
              kind: "external_follow_up",
              completeness,
              origin: "user_report",
              observedAt: new Date().toISOString(),
              actor: req.user.id,
              target: action.objectKey,
              field: action.operationKey,
              value: resolution,
              note: note.trim(),
            });
            if (completeness === "complete")
              await logOutcome(actionID, {
                resolution,
                note: note.trim(),
                resolvedBy: req.user.id,
                expectedModifiedAt,
              });
            else {
              const changed = await UPDATE.entity(`${NS}.Actions`)
                .set({ modifiedAt: new Date().toISOString() })
                .where({
                  ID: actionID,
                  status: "waiting",
                  modifiedAt: action.modifiedAt,
                });
              if (Number(changed) !== 1)
                throw fail(409, "Action changed concurrently");
              await INSERT.into(`${NS}.ActionEvents`).entries({
                ID: cds.utils.uuid(),
                action_ID: actionID,
                command_ID: receiptID,
                occurredAt: new Date().toISOString(),
                event: "outcome_observed",
                fromStatus: "waiting",
                toStatus: "waiting",
                actor: req.user.id,
                source: "user_report",
                note: note.trim(),
              });
            }
            return {
              ...(await resultForCase(links[0]!.header_ID, actionID)),
              observationID,
            };
          },
        },
      );
    });
    this.on("recordSupplierPosting", (req: cds.Request) => {
      const {
        actionID,
        completeness,
        target,
        field,
        value,
        note,
        commandID,
        expectedModifiedAt,
      } = req.data;
      return executeWorkflowCommand(
        {
          commandID,
          commandType: "recordSupplierPosting",
          arguments: {
            actionID,
            completeness,
            target,
            field,
            value,
            note,
            expectedModifiedAt,
          },
          subjects: [{ kind: "action", ID: actionID }],
        },
        {
          authorize: authorize(req),
          execute: async (receiptID) => {
            const action = await SELECT.one
              .from(`${NS}.Actions`)
              .where({ ID: actionID });
            assertVersion(action, expectedModifiedAt);
            if (action.kind !== "pdt_change" || action.status !== "waiting")
              throw fail(
                409,
                "Only an approved waiting supplier change can receive posting observations",
              );
            if (!["complete", "partial", "unknown"].includes(completeness))
              throw fail(
                400,
                "completeness must be complete, partial or unknown",
              );
            if (typeof note !== "string" || !note.trim())
              throw fail(
                400,
                "A posting reference or business reason is required",
              );
            const items: Row[] = await SELECT.from(`${NS}.ActionItems`).where({
              action_ID: actionID,
            });
            if (
              items.length !== 1 ||
              items[0]!.objectKey !== target ||
              items[0]!.field !== field ||
              items[0]!.newValue !== value
            )
              throw fail(
                409,
                "The posting report must identify the exact approved target, field and value",
              );
            const observationID = cds.utils.uuid();
            await INSERT.into("tide.workflow.OutcomeObservations").entries({
              ID: observationID,
              actionID,
              command_ID: receiptID,
              kind: "external_posting",
              completeness,
              origin: "user_report",
              observedAt: new Date().toISOString(),
              actor: req.user.id,
              target,
              field,
              value,
              note: note.trim(),
            });
            if (completeness === "complete")
              await logOutcome(actionID, {
                resolution: "posted",
                note: note.trim(),
                resolvedBy: req.user.id,
                expectedModifiedAt: action.modifiedAt,
              });
            else {
              const changed = await UPDATE.entity(`${NS}.Actions`)
                .set({ modifiedAt: new Date().toISOString() })
                .where({
                  ID: actionID,
                  status: "waiting",
                  modifiedAt: action.modifiedAt,
                });
              if (Number(changed) !== 1)
                throw fail(
                  409,
                  "Action changed; reload before recording the observation",
                );
              await INSERT.into(`${NS}.ActionEvents`).entries({
                ID: cds.utils.uuid(),
                action_ID: actionID,
                command_ID: receiptID,
                occurredAt: new Date().toISOString(),
                event: "outcome_observed",
                fromStatus: "waiting",
                toStatus: "waiting",
                actor: req.user.id,
                source: "user_report",
                note: note.trim(),
              });
            }
            const link = await SELECT.one
              .from(`${NS}.CaseActions`)
              .where({ action_ID: actionID });
            return {
              ...(await resultForCase(link.header_ID, actionID)),
              observationID,
            };
          },
        },
      );
    });
    return super.init();
  }
}
