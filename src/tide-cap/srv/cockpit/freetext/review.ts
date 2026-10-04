import { createHash } from "node:crypto";
import cds from "@sap/cds";
import { NS, inTx, type Row } from "../kernel/model-calls";
import {
  activeCaseAction,
  prepareAction,
  readAction,
  reuse409,
} from "../kernel/actions";
import type { ActionVia } from "../kernel/types";
import { supersede } from "../kernel/action-state";
import { currentWorkflowCommand, currentWorkflowOrigin, executeWorkflowCommand } from "../kernel/commands";
import { scopeOf, inScope } from "../kernel/auth";
import { fail } from "../kernel/errors";
import {
  acknowledgeSourceChange,
  ensureCase,
  recordSourceChange,
  resolveFromSource,
  setListing,
} from "../kernel/cases";
import { touchCase } from "../kernel/attention";
import {
  BLANK_CATEGORY,
  CATEGORY_FIELDS,
  CONTEXT_ROWS,
  FIELD_POLICIES,
  FIELD_TEXT,
  itemKey,
  FIELDS,
  PREDICTION_FIELDS,
  type Field,
  type Proposal,
} from "./domain/logic";
import {
  deleteItems,
  labelledOf,
  readItems,
  upsertItems,
  type StoredItem,
} from "./data";
import { propose, type StoredThreshold } from "./engine";
import { coreClassify } from "./classify";
import {
  allocationWorkspace,
  cancelSavedAllocationPredictions,
  recordManualAllocationChange,
  validateAllocationDecisions,
} from "./allocation";

const { SELECT, INSERT, UPDATE, UPSERT } = cds.ql;
const WORK = `${NS}.FreetextWorkItem`;
const REVIEW = `${NS}.FreetextReview`;
const PROPOSAL = `${NS}.FreetextProposal`;
const REVIEW_ASSIGNMENT = `${NS}.FreetextReviewAccountAssignment`;
const SUBMISSION = `${NS}.FreetextSubmission`;
type ReviewCommandRequest = Pick<cds.Request, "params" | "user" | "data">;
const DRAFT_EVIDENCE = "PurchasingDeskService.FreetextDraftEvidences.drafts";
const DRAFT_DECISION = "PurchasingDeskService.FreetextDraftDecisions.drafts";
const EVIDENCE = `${NS}.FreetextDraftEvidence`;
const DECISION = `${NS}.FreetextDraftDecision`;
const draft = () => "PurchasingDeskService.PurchaseRequisitionReviews.drafts";
const keyOf = (r: Row) => ({
  PurchaseRequisition: r.PurchaseRequisition,
  PurchaseRequisitionItem: r.PurchaseRequisitionItem,
});
const caseID = (r: Row) =>
  `requisition:${r.PurchaseRequisition}/${r.PurchaseRequisitionItem}`;
const filled = (v: unknown) =>
  v !== null && v !== undefined && String(v).trim() !== "";
const PENDING_DEADLINE_MS = 120_000;
const DRAFT_FIELD_PROPERTIES = Object.fromEntries(
  Object.entries(FIELD_POLICIES).map(([field, policy]) => [
    field,
    policy.property,
  ]),
);
const REVIEW_STATES = Object.fromEntries(
  Object.entries(FIELD_POLICIES).map(([field, policy]) => [
    field,
    policy.state,
  ]),
);
const validationContext = (source: Row, review: Row) => ({
  ...source,
  Plant: review.reviewedPlant,
  PurchasingOrganization: review.reviewedPurchasingOrganization,
  Material: review.reviewedMaterial,
  Supplier: review.Supplier,
});
const lifecycle = (s: string) => ({
  lifecycleStatus: s,
  lifecycleText:
    {
      needs_review: "Needs review",
      awaiting_approval: "Awaiting approval",
      approved: "Approved, awaiting source confirmation",
      exported: "Exported, awaiting source confirmation",
      awaiting_source_confirmation: "Awaiting source confirmation",
      source_changed: "Source changed",
      completed: "Completed",
      cancelled: "Cancelled",
    }[s] ?? s,
  lifecycleCriticality:
    {
      needs_review: 2,
      awaiting_approval: 0,
      approved: 0,
      exported: 0,
      awaiting_source_confirmation: 0,
      source_changed: 2,
      completed: 3,
      cancelled: 0,
    }[s] ?? 0,
});
const reviewStatus = (legacy: string, open = true) =>
  legacy === "completed" || legacy === "cancelled"
    ? "done"
    : !open
      ? "in_progress"
    : legacy === "needs_review" || legacy === "source_changed"
      ? "new"
      : legacy === "awaiting_approval" ||
          legacy === "approved" ||
          legacy === "awaiting_source_confirmation"
        ? "submitted"
        : "in_progress";

function decisionState(
  source: Row,
  review: Row | undefined,
  status: string,
  hasSourceChange = false,
) {
  const sourceChange = hasSourceChange || !!review?.sourceChanged;
  const unresolved = FIELDS.filter((field) => !FIELD_POLICIES[field].optional)
    .map((field) => ({
      field,
      label: FIELD_TEXT[field],
      value: review?.[FIELD_POLICIES[field].property],
      state: review?.[FIELD_POLICIES[field].state],
    }))
    .find(
      ({ field, value, state }) =>
        (!filled(value) && !CATEGORY_FIELDS.has(field)) ||
        (filled(value) &&
          !["confirmed", "corrected", "entered", "not_applicable"].includes(
            String(state),
          )),
    );
  const needsSupplier =
    source.SourceOfSupplyIsAssigned || filled(source.FixedSupplier);
  const requiredDraftFields = [
    ["Short description", review?.reviewedShortText],
    ["Quantity", review?.reviewedQuantity],
    ["Unit", review?.reviewedUnit],
    ["Required date", review?.reviewedDeliveryDate],
    ["Plant", review?.reviewedPlant],
    ["Purchasing organisation", review?.reviewedPurchasingOrganization],
  ].find(([, value]) => !filled(value));
  const requiredUnresolved =
    unresolved &&
    (unresolved.field !== "Supplier" ||
      needsSupplier ||
      filled(unresolved.value));
  const overdue =
    !!source.DeliveryDate &&
    source.DeliveryDate < new Date().toISOString().slice(0, 10) &&
    ["needs_review", "source_changed"].includes(status);
  if (status === "cancelled")
    return {
      reviewStatusText: "Cancelled",
      reviewStatusCriticality: 0,
      nextStep: "This request no longer requires review.",
      isReadyToSubmit: false,
      requiresSourceReconciliation: false,
      isOverdueForReview: false,
    };
  if (status === "completed")
    return {
      reviewStatusText: "Completed",
      reviewStatusCriticality: 3,
      nextStep: "No further review is required.",
      isReadyToSubmit: false,
      requiresSourceReconciliation: false,
      isOverdueForReview: false,
    };
  if (!source.isOpen)
    return {
      reviewStatusText: "Source confirmation required",
      reviewStatusCriticality: 2,
      nextStep: "Reconcile the source before continuing review.",
      isReadyToSubmit: false,
      requiresSourceReconciliation: true,
      isOverdueForReview: false,
    };
  if (sourceChange)
    return {
      reviewStatusText: "In progress",
      reviewStatusCriticality: 2,
      nextStep: "Review source changes before submitting.",
      isReadyToSubmit: false,
      requiresSourceReconciliation: true,
      isOverdueForReview: overdue,
    };
  if (
    status === "awaiting_approval" ||
    status === "approved" ||
    status === "awaiting_source_confirmation"
  )
    return {
      reviewStatusText:
        status === "awaiting_approval"
          ? "Awaiting approval"
          : status === "approved"
            ? "Approved draft"
            : "Awaiting source confirmation",
      reviewStatusCriticality: 0,
      nextStep:
        status === "awaiting_approval"
          ? "Open the approval to follow its progress."
          : status === "approved"
            ? "Download the approved draft for external order creation."
            : "The external outcome is recorded. Awaiting confirmation from the source system.",
      isReadyToSubmit: false,
      requiresSourceReconciliation: false,
      isOverdueForReview: false,
    };
  if (requiredDraftFields)
    return {
      reviewStatusText: status === "needs_review" ? "New" : "In progress",
      reviewStatusCriticality: 2,
      nextStep: `Complete ${String(requiredDraftFields[0]).toLowerCase()} before submitting.`,
      isReadyToSubmit: false,
      requiresSourceReconciliation: false,
      isOverdueForReview: overdue,
    };
  if (requiredUnresolved)
    return {
      reviewStatusText: status === "needs_review" ? "New" : "In progress",
      reviewStatusCriticality: status === "needs_review" ? 2 : 0,
      nextStep: `Choose ${String(unresolved.label).toLowerCase()} before submitting.`,
      isReadyToSubmit: false,
      requiresSourceReconciliation: false,
      isOverdueForReview: overdue,
    };
  return {
    reviewStatusText: status === "needs_review" ? "New" : "In progress",
    reviewStatusCriticality: status === "needs_review" ? 2 : 0,
    nextStep: "Submit the saved review for approval.",
    isReadyToSubmit: true,
    requiresSourceReconciliation: false,
    isOverdueForReview: overdue,
  };
}

const workflowStage = (row: Row): string => {
  if (
    row.lifecycleStatus === "cancelled" ||
    row.reviewStatusText === "Cancelled"
  )
    return "cancelled";
  if (
    row.lifecycleStatus === "completed" ||
    row.reviewStatusText === "Completed"
  )
    return "completed";
  if (row.sourceChanged || row.lifecycleStatus === "source_changed")
    return "inProgress";
  if (row.lifecycleStatus === "awaiting_approval") return "awaitingApproval";
  if (row.lifecycleStatus === "approved") return "approvedDraft";
  if (
    ["exported", "awaiting_source_confirmation"].includes(row.lifecycleStatus)
  )
    return "awaitingSourceConfirmation";
  if (row.lifecycleStatus === "needs_review")
    return row.reviewStatusText === "New" ? "newItems" : "inProgress";
  if (row.reviewStatusText === "New") return "newItems";
  if (row.reviewStatusText === "Awaiting approval") return "awaitingApproval";
  if (row.reviewStatusText === "Approved draft") return "approvedDraft";
  if (row.reviewStatusText === "Awaiting source confirmation")
    return "awaitingSourceConfirmation";
  if (row.reviewStatusText === "Completed") return "completed";
  if (row.reviewStatusText === "Cancelled") return "cancelled";
  return "inProgress";
};

export async function requestWorkflowSummary(user: cds.User) {
  const scope = scopeOf(user);
  const query = SELECT.from(REVIEW)
    .columns(
      "lifecycleStatus",
      "reviewStatusText",
      "sourceChanged",
      "count(1) as count",
    )
    .groupBy("lifecycleStatus", "reviewStatusText", "sourceChanged");
  if (!scope.isAdmin) {
    const escape = (value: string) => value.replace(/'/g, "''");
    const where = [
      `routedBuyer = '${escape(user.id)}'`,
    ];
    where.push(scope.grants?.length
      ? `(${scope.grants.map((grant) => `(Plant = '${escape(grant.Plant)}' and routedGroup = '${escape(grant.PurchasingGroup)}')`).join(" or ")})`
      : "1 = 0");
    query.where(where.join(" and "));
  }
  const rows: Row[] = await inTx(async () => query);
  const summary = {
    newItems: 0,
    inProgress: 0,
    awaitingApproval: 0,
    approvedDraft: 0,
    awaitingSourceConfirmation: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    const stage = workflowStage(row) as keyof typeof summary;
    summary[stage] += Number(row.count ?? 0);
  }
  return summary;
}

function sourceChanges(previous: Row | undefined, current: Row) {
  if (!previous) return null;
  const changes = [
    ["Request text", previous.text, current.text],
    ["Item long text", previous.itemLongText, current.itemLongText],
    ["Header note", previous.headerNote, current.headerNote],
    ["Needed by", previous.DeliveryDate, current.DeliveryDate],
    ["Quantity", previous.RequestedQuantity, current.RequestedQuantity],
    ["Plant", previous.Plant, current.Plant],
    [
      "Purchasing organization",
      previous.PurchasingOrganization,
      current.PurchasingOrganization,
    ],
    ["Material group", previous.MaterialGroup, current.MaterialGroup],
    ["Purchasing group", previous.PurchasingGroup, current.PurchasingGroup],
    ["Supplier", previous.Supplier, current.Supplier],
    [
      "Account assignment",
      previous.accountAssignments,
      current.accountAssignments,
    ],
  ]
    .filter(([, before, after]) => String(before ?? "") !== String(after ?? ""))
    .map(([field, before, after]) => ({
      field,
      before: before ?? null,
      after: after ?? null,
      affectsBuyerDecision: [
        "Material group",
        "Purchasing group",
        "Supplier",
      ].includes(String(field)),
    }));
  return changes.length ? changes : null;
}

function stateText(state: unknown) {
  return (
    (
      {
        unreviewed_source: "Provided in request",
        source: "Provided in request",
        suggested: "Suggested",
        confirmed: "Confirmed by you",
        corrected: "Corrected by you",
        entered: "Entered by you",
        not_applicable: "Not applicable",
      } as Record<string, string>
    )[String(state)] ?? "Needs a decision"
  );
}

async function setTypedReviewStatus(
  row: Row,
  status: "new" | "in_progress" | "submitted" | "done" | "cancelled",
) {
  const ID = caseID(row);
  await UPDATE.entity(`${NS}.RequisitionReviews`)
    .set({ reviewStatus: status })
    .where({ header_ID: ID });
  await touchCase(ID);
}
const reviewContext = (s: Row) => ({
  requestText: s.text,
  itemLongText: s.itemLongText,
  headerNote: s.headerNote,
  RequisitionerName: s.RequisitionerName,
  requestedAt: s.requestedAt,
  DeliveryDate: s.DeliveryDate,
  RequestedQuantity: s.RequestedQuantity,
  BaseUnit: s.BaseUnit,
  PurchasingOrganization: s.PurchasingOrganization,
  PurchaseOrderType: s.PurchaseOrderType,
  CompanyCode: s.CompanyCode,
  PurchasingDocumentItemCategory: s.PurchasingDocumentItemCategory,
  AccountAssignmentCategory: s.AccountAssignmentCategory,
  accountAssignments: s.accountAssignments,
  PurchaseRequisitionPrice: s.PurchaseRequisitionPrice,
  PurReqnPriceQuantity: s.PurReqnPriceQuantity,
  ItemNetAmount: s.ItemNetAmount,
  PurReqnItemCurrency: s.PurReqnItemCurrency,
  StorageLocation: s.StorageLocation,
  Material: s.Material,
  PurchasingInfoRecord: s.PurchasingInfoRecord,
  OutlineAgreement: s.OutlineAgreement,
  OutlineAgreementItem: s.OutlineAgreementItem,
  TaxCode: s.TaxCode,
  GoodsReceiptIsExpected: s.GoodsReceiptIsExpected,
  InvoiceIsGoodsReceiptBased: s.InvoiceIsGoodsReceiptBased,
  IsEvaluatedRcptSettlmtAllowed: s.IsEvaluatedRcptSettlmtAllowed,
  ServicePerformer: s.ServicePerformer,
  PerformancePeriodStartDate: s.PerformancePeriodStartDate,
  PerformancePeriodEndDate: s.PerformancePeriodEndDate,
  ExpectedOverallLimitAmount: s.ExpectedOverallLimitAmount,
  OverallLimitAmount: s.OverallLimitAmount,
  DeliveryAddressName: s.DeliveryAddressName,
  DeliveryAddressStreet: s.DeliveryAddressStreet,
  DeliveryAddressCity: s.DeliveryAddressCity,
  DeliveryAddressPostalCode: s.DeliveryAddressPostalCode,
  DeliveryAddressCountry: s.DeliveryAddressCountry,
  UnloadingPoint: s.UnloadingPoint,
  lifecycleStatus: s.lifecycleStatus,
  lifecycleText: s.lifecycleText,
  lifecycleCriticality: s.lifecycleCriticality,
  readinessSummary: s.readinessSummary,
  enrichmentStatus: s.enrichmentStatus,
  findingID: s.findingID,
  actionID: s.actionID,
});

const draftValues = (s: Row) => ({
  reviewedShortText: s.text,
  reviewedLongText: s.itemLongText,
  reviewedHeaderNote: s.headerNote,
  reviewedPrType: s.PurchaseRequisitionType,
  reviewedItemCategory: s.PurchasingDocumentItemCategory,
  reviewedMaterial: s.Material,
  reviewedQuantity: s.RequestedQuantity,
  reviewedUnit: s.BaseUnit,
  reviewedDeliveryDate: s.DeliveryDate,
  reviewedPlant: s.Plant,
  reviewedStorageLocation: s.StorageLocation,
  reviewedCompanyCode: s.CompanyCode,
  reviewedPurchasingOrganization: s.PurchasingOrganization,
  reviewedAccountAssignmentCategory: s.AccountAssignmentCategory,
  reviewedValuationPrice: s.PurchaseRequisitionPrice,
  reviewedPriceQuantity: s.PurReqnPriceQuantity,
  reviewedCurrency: s.PurReqnItemCurrency,
  reviewedTaxCode: s.TaxCode,
  reviewedPurchasingInfoRecord: s.PurchasingInfoRecord,
  reviewedOutlineAgreement: s.OutlineAgreement,
  reviewedOutlineAgreementItem: s.OutlineAgreementItem,
  reviewedReceiptExpected: s.GoodsReceiptIsExpected,
  reviewedInvoiceBasedOnReceipt: s.InvoiceIsGoodsReceiptBased,
  reviewedServicePerformer: s.ServicePerformer,
  reviewedPerformancePeriodStartDate: s.PerformancePeriodStartDate,
  reviewedPerformancePeriodEndDate: s.PerformancePeriodEndDate,
  reviewedExpectedOverallLimitAmount: s.ExpectedOverallLimitAmount,
  reviewedOverallLimitAmount: s.OverallLimitAmount,
  reviewedDeliveryAddressName: s.DeliveryAddressName,
  reviewedDeliveryAddressStreet: s.DeliveryAddressStreet,
  reviewedDeliveryAddressCity: s.DeliveryAddressCity,
  reviewedDeliveryAddressPostalCode: s.DeliveryAddressPostalCode,
  reviewedDeliveryAddressCountry: s.DeliveryAddressCountry,
  reviewedUnloadingPoint: s.UnloadingPoint,
});

const CODE_FIELDS = [
  ["MaterialGroup", "MaterialGroup", "materialGroupState"],
  ["PurchasingGroup", "reviewedPurchasingGroup", "purchasingGroupState"],
  ["Supplier", "Supplier", "supplierState"],
  ["Material", "reviewedMaterial", "materialState"],
  ["PurchasingInfoRecord", "reviewedPurchasingInfoRecord", "infoRecordState"],
  [
    "AccountAssignmentCategory",
    "reviewedAccountAssignmentCategory",
    "accountAssignmentCategoryState",
  ],
  [
    "PurchasingDocumentItemCategory",
    "reviewedItemCategory",
    "itemCategoryState",
  ],
] as const;
const parseOrigins = (
  value: string | null | undefined,
): Record<string, string> => (value ? JSON.parse(value) : {});
const initializedValues = (source: Row) => ({
  ...draftValues(source),
  workingCopyVersion: 1,
  fieldOrigins: JSON.stringify(
    Object.entries(draftValues(source))
      .filter(([, value]) => filled(value))
      .map(([name]) => [name, "source"])
      .reduce((all, [name, origin]) => ({ ...all, [name]: origin }), {}),
  ),
});

/** Repair only demonstrably untouched legacy reviews; ambiguous buyer blanks stay blank. */
async function repairWorkingCopy(source: Row, review: Row) {
  if (
    review.workingCopyVersion ||
    review.sourceRevision !== source.sourceRevision ||
    !source.isOpen
  )
    return;
  if (await SELECT.one.from(draft()).where(keyOf(source))) return;
  const untouched =
    review.createdAt === review.modifiedAt &&
    !CODE_FIELDS.some(([, , state]) =>
      ["confirmed", "corrected", "entered"].includes(review[state]),
    );
  const origins = parseOrigins(review.fieldOrigins);
  const patch: Row = { workingCopyVersion: 1 };
  for (const [name, value] of Object.entries(draftValues(source))) {
    if (untouched && !filled(review[name]) && filled(value) && !origins[name])
      patch[name] = value;
    if (!origins[name] && filled(review[name]))
      origins[name] = review[name] === value ? "source" : "buyer_changed";
    if (!untouched && !filled(review[name]) && filled(value) && !origins[name])
      origins[name] = "buyer_cleared";
    if (name in patch && name !== "workingCopyVersion")
      origins[name] = "source";
  }
  patch.fieldOrigins = JSON.stringify(origins);
  await UPDATE.entity(REVIEW).set(patch).where(keyOf(source));
}

function sourceRecord(i: StoredItem): Row {
  return {
    PurchaseRequisition: i.PurchaseRequisition,
    PurchaseRequisitionItem: i.PurchaseRequisitionItem,
    text: i.text,
    RequisitionerName: i.RequisitionerName ?? null,
    CreatedByUser: i.CreatedByUser ?? null,
    itemLongText: i.itemLongText ?? null,
    headerNote: i.headerNote ?? null,
    PurchaseRequisitionType: i.PurchaseRequisitionType ?? null,
    PurReqnDescription: i.PurReqnDescription ?? null,
    requestedAt: i.date,
    DeliveryDate: i.DeliveryDate ?? null,
    RequestedQuantity: i.RequestedQuantity ?? null,
    BaseUnit: i.BaseUnit ?? null,
    Plant: i.Plant,
    PurchasingOrganization: i.PurchasingOrganization,
    PurchaseOrderType: i.PurchaseOrderType ?? null,
    PurchasingGroup: i.sourcePurchasingGroup ?? null,
    MaterialGroup: i.sourceMaterialGroup ?? null,
    Supplier: i.sourceSupplier ?? null,
    FixedSupplier: i.FixedSupplier ?? null,
    SourceOfSupplyIsAssigned: !!i.SourceOfSupplyIsAssigned,
    CompanyCode: i.CompanyCode ?? null,
    PurchasingDocumentItemCategory: i.PurchasingDocumentItemCategory ?? null,
    AccountAssignmentCategory: i.AccountAssignmentCategory ?? null,
    PurchaseRequisitionPrice: i.PurchaseRequisitionPrice ?? null,
    PurReqnPriceQuantity: i.PurReqnPriceQuantity ?? null,
    ItemNetAmount: i.ItemNetAmount ?? null,
    PurReqnItemCurrency: i.PurReqnItemCurrency ?? null,
    StorageLocation: i.StorageLocation ?? null,
    Material:
      i.sourceMaterial !== undefined ? i.sourceMaterial : (i.Material ?? null),
    PurchasingInfoRecord:
      i.sourcePurchasingInfoRecord !== undefined
        ? i.sourcePurchasingInfoRecord
        : (i.PurchasingInfoRecord ?? null),
    OutlineAgreement: i.OutlineAgreement ?? null,
    OutlineAgreementItem: i.OutlineAgreementItem ?? null,
    TaxCode: i.TaxCode ?? null,
    GoodsReceiptIsExpected: i.GoodsReceiptIsExpected ?? null,
    InvoiceIsGoodsReceiptBased: i.InvoiceIsGoodsReceiptBased ?? null,
    IsEvaluatedRcptSettlmtAllowed: i.IsEvaluatedRcptSettlmtAllowed ?? null,
    ServicePerformer: i.ServicePerformer ?? null,
    PerformancePeriodStartDate: i.PerformancePeriodStartDate ?? null,
    PerformancePeriodEndDate: i.PerformancePeriodEndDate ?? null,
    ExpectedOverallLimitAmount: i.ExpectedOverallLimitAmount ?? null,
    OverallLimitAmount: i.OverallLimitAmount ?? null,
    DeliveryAddressName: i.deliveryAddress?.Name ?? null,
    DeliveryAddressStreet: i.deliveryAddress?.Street ?? null,
    DeliveryAddressCity: i.deliveryAddress?.City ?? null,
    DeliveryAddressPostalCode: i.deliveryAddress?.PostalCode ?? null,
    DeliveryAddressCountry: i.deliveryAddress?.Country ?? null,
    UnloadingPoint: i.deliveryAddress?.UnloadingPoint ?? null,
    accountAssignments: JSON.stringify(i.accountAssignments ?? []),
    routedBuyer: i.routedBuyer ?? null,
    routedGroup: i.routedGroup ?? null,
    IsDeleted: !!i.IsDeleted,
    IsClosed: !!i.IsClosed,
    ProcessingStatus: i.ProcessingStatus ?? null,
    PurReqnReleaseStatus: i.PurReqnReleaseStatus ?? null,
    PurchasingDocument: i.PurchasingDocument ?? null,
    PurchasingDocumentItem: i.PurchasingDocumentItem ?? null,
    isOpen: i.isOpen,
    demo: !!i.demo,
  };
}

const SOURCE_FIELDS = Object.keys(
  sourceRecord({
    PurchaseRequisition: "",
    PurchaseRequisitionItem: "",
    text: "",
    date: "",
    Plant: null,
    PurchasingOrganization: null,
    PurchaseOrderType: null,
    isOpen: true,
    id: "",
  }),
).filter((key) => !["routedBuyer", "routedGroup", "demo"].includes(key));
const fingerprint = (r: Row) =>
  createHash("sha256")
    .update(JSON.stringify(SOURCE_FIELDS.map((k) => r[k] ?? null)))
    .digest("hex");

/** Refresh source facts independently of the transient model feed and buyer drafts. */
export async function syncWorkItems(items: StoredItem[]) {
  if (!items.length) return;
  if (currentWorkflowCommand()) return syncWorkItemsCommand(items);
  return inTx(async () => {
    const represented = items.filter((item) => !item.isQuery);
    if (!represented.length) return;
    const subjects = new Map<string, { kind: "case" | "action"; ID: string }>();
    const observations: Row[] = [];
    for (const item of represented) {
      const source = sourceRecord(item);
      subjects.set(caseID(source), { kind: "case", ID: caseID(source) });
      const work = await SELECT.one.from(WORK).where(keyOf(source));
      const review = await SELECT.one.from(REVIEW).where(keyOf(source));
      const action = work?.actionID
        ? await SELECT.one.from(`${NS}.Actions`).where({ ID: work.actionID }) : null;
      if (action) {
        subjects.set(action.ID, { kind: "action", ID: action.ID });
        const owners = await SELECT.from(`${NS}.CaseActions`).where({ action_ID: action.ID });
        for (const owner of owners) subjects.set(owner.header_ID, { kind: "case", ID: owner.header_ID });
      }
      const conversion = source.PurchasingDocument && source.PurchasingDocumentItem
        ? await SELECT.one.from("tide.s4.PurchaseOrderItem").where({
            PurchaseOrder: source.PurchasingDocument,
            PurchaseOrderItem: source.PurchasingDocumentItem,
            PurchaseRequisition: source.PurchaseRequisition,
            PurchaseRequisitionItem: source.PurchaseRequisitionItem,
          }) : null;
      observations.push({ source, work: work ?? null, review: review ?? null, action: action ?? null, conversion: conversion ?? null });
    }
    observations.sort((left, right) => caseID(left.source).localeCompare(caseID(right.source)));
    const evidence = { observations };
    await executeWorkflowCommand({
      commandID: `review-source:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`,
      commandType: "reconcileReviewSource",
      arguments: evidence,
      subjects: [...subjects.values()],
    }, {
      authorize: async () => {
        const scope = scopeOf(cds.context!.user);
        for (const observation of observations)
          if (!inScope(scope, observation.source)) throw fail(404, "Case not found");
        for (const subject of subjects.values()) {
          if (subject.kind !== "case") continue;
          const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: subject.ID });
          if (header && !inScope(scope, header)) throw fail(404, "Case not found");
          if (!header && !observations.some(observation => caseID(observation.source) === subject.ID))
            throw fail(404, "Case not found");
        }
      },
      execute: async () => {
        await syncWorkItemsCommand(represented);
        return { synchronized: observations.map(observation => caseID(observation.source)) };
      },
    });
  });
}

async function syncWorkItemsCommand(items: StoredItem[]) {
  await inTx(async () => {
    for (const i of items.filter((x) => !x.isQuery)) {
      const source = sourceRecord(i);
      const key = keyOf(source);
      const current = await SELECT.one.from(WORK).where(key);
      const changed = !current || fingerprint(source) !== fingerprint(current);
      let action =
        current?.actionID &&
        (await SELECT.one
          .from(`${NS}.Actions`)
          .where({ ID: current.actionID }));
      if (
        changed &&
        action &&
        ["needs_decision", "waiting"].includes(action.status)
      ) {
        await supersede(
          action.ID,
          "The purchase requisition changed at the source before the approval completed.",
        );
        action = undefined;
      }
      const completed =
        !i.isOpen &&
        !i.IsDeleted &&
        !!i.PurchasingDocument &&
        !!i.PurchasingDocumentItem &&
        !!(await SELECT.one.from("tide.s4.PurchaseOrderItem").where({
          PurchaseOrder: i.PurchasingDocument,
          PurchaseOrderItem: i.PurchasingDocumentItem,
          PurchaseRequisition: i.PurchaseRequisition,
          PurchaseRequisitionItem: i.PurchaseRequisitionItem,
          PurchasingDocumentDeletionCode: "",
        }));
      const status = i.IsDeleted
        ? "cancelled"
        : completed
          ? "completed"
          : !i.isOpen
            ? "source_changed"
        : changed && current
          ? "source_changed"
          : action?.status === "needs_decision"
            ? "awaiting_approval"
            : action?.status === "waiting"
              ? "approved"
              : action?.status === "resolved"
                ? "awaiting_source_confirmation"
                : (current?.lifecycleStatus ?? "needs_review");
      const summary = ["MaterialGroup", "PurchasingGroup"]
        .filter((field) => !filled(source[field]))
        .map((field) =>
          field === "MaterialGroup" ? "material group" : "purchasing group",
        );
      const changes = changed ? sourceChanges(current, source) : null;
      const record: Row = {
        ...source,
        sourceFingerprint: fingerprint(source),
        ...lifecycle(status),
        readinessSummary: summary.length
          ? `Missing ${summary.join(" and ")}`
          : "Ready to review",
        findingID: `freetext:${itemKey(i)}`,
        sourceRevision: changed
          ? (current?.sourceRevision ?? 0) + 1
          : current!.sourceRevision,
        sourceUpdatedAt: changed
          ? new Date().toISOString()
          : current!.sourceUpdatedAt,
        enrichmentStatus: changed ? "pending" : current!.enrichmentStatus,
        actionID: current?.actionID ?? null,
      };
      if (
        current &&
        (changed ||
          current.lifecycleStatus !== status ||
          current.routedBuyer !== source.routedBuyer ||
          current.routedGroup !== source.routedGroup)
      )
        await UPDATE.entity(WORK).set(record).where(key);
      else if (!current) await INSERT.into(WORK).entries(record);
      const ID = caseID(source);
      await ensureCase({
        ID,
        kind: "requisition_review",
        Plant: source.Plant,
        PurchasingGroup: source.PurchasingGroup,
        title: `Requisition ${itemKey(source as StoredItem)}`,
        sourceRevision: record.sourceRevision,
        sourceFingerprint: record.sourceFingerprint,
      });
      if (source.isOpen) await setListing(ID, "listed");
      if (current && changed)
        await recordSourceChange(
          ID,
          record.sourceRevision,
          record.sourceFingerprint,
        );
      if (completed)
        await resolveFromSource(
          ID,
          "The purchase requisition item was converted to a linked purchase order.",
        );
      const assignments = (i.accountAssignments ?? [])
        .map((a: Row) => ({
          PurchaseRequisition: i.PurchaseRequisition,
          PurchaseRequisitionItem: i.PurchaseRequisitionItem,
          PurchaseReqnAcctAssgmtNumber: a.PurchaseReqnAcctAssgmtNumber,
          GLAccount: a.GLAccount ?? null,
          CostCenter: a.CostCenter ?? null,
          SalesOrder: a.SalesOrder ?? null,
          SalesOrderItem: a.SalesOrderItem ?? null,
          MainAsset: a.MasterFixedAsset ?? null,
          AssetSubnumber: a.FixedAsset ?? null,
          InternalOrder: a.OrderID ?? null,
          WBSElement: a.WBSElement ?? null,
          AssignedQuantity: a.Quantity ?? null,
          BaseUnit: a.BaseUnit ?? i.BaseUnit ?? null,
          Currency: a.PurReqnItemCurrency ?? i.PurReqnItemCurrency ?? null,
          Amount: a.PurReqnNetAmount ?? null,
          DistributionPercent: a.DistributionPercent ?? null,
          IsDeleted: !!a.IsDeleted,
        }))
        .filter((a: Row) => filled(a.PurchaseReqnAcctAssgmtNumber));
      if (changed) {
        await cds.run(
          cds.ql.DELETE.from(`${NS}.FreetextWorkItemAccountAssignment`).where(
            key,
          ),
        );
        if (assignments.length)
          await UPSERT.into(`${NS}.FreetextWorkItemAccountAssignment`).entries(
            assignments,
          );
      }
      const review = await SELECT.one.from(REVIEW).where(key);
      let refreshed = false;
      if (!review) {
        await INSERT.into(REVIEW).entries({
          ...key,
          Plant: source.Plant,
          PurchasingGroup: source.PurchasingGroup,
          routedBuyer: source.routedBuyer,
          routedGroup: source.routedGroup,
          sourceRevision: record.sourceRevision,
          sourceChanged: false,
          sourceChangeSummary: null,
          sourceChanges: null,
          ...reviewContext(record),
          ...initializedValues(record),
          MaterialGroup: source.MaterialGroup,
          reviewedPurchasingGroup: source.PurchasingGroup,
          Supplier: source.Supplier,
          materialGroupState: filled(source.MaterialGroup)
            ? "unreviewed_source"
            : null,
          purchasingGroupState: filled(source.PurchasingGroup)
            ? "unreviewed_source"
            : null,
          supplierState: filled(source.Supplier) ? "unreviewed_source" : null,
          materialState: filled(record.Material)
            ? "unreviewed_source"
            : "not_applicable",
          infoRecordState: filled(record.PurchasingInfoRecord)
            ? "unreviewed_source"
            : "not_applicable",
          accountAssignmentCategoryState: filled(
            source.AccountAssignmentCategory,
          )
            ? "unreviewed_source"
            : "not_applicable",
          itemCategoryState: filled(source.PurchasingDocumentItemCategory)
            ? "unreviewed_source"
            : "not_applicable",
        });
        if (assignments.length)
          await UPSERT.into(REVIEW_ASSIGNMENT).entries(
            assignments.filter((a: Row) => !a.IsDeleted),
          );
      } else if (
        changed &&
        review.sourceRevision === current.sourceRevision &&
        (review.workingCopyVersion || review.createdAt === review.modifiedAt) &&
        !Object.values(parseOrigins(review.fieldOrigins)).some((x) =>
          x.startsWith("buyer_"),
        ) &&
        ![
          review.materialGroupState,
          review.purchasingGroupState,
          review.supplierState,
        ].some((x: string) => ["confirmed", "corrected", "entered"].includes(x))
      ) {
        // Do not update a review whose buyer has started working (including an unfinished draft).
        const pendingDraft = await SELECT.one.from(draft()).where(key);
        if (!pendingDraft) {
          await UPDATE.entity(REVIEW)
            .set({
              Plant: source.Plant,
              PurchasingGroup: source.PurchasingGroup,
              routedBuyer: source.routedBuyer,
              routedGroup: source.routedGroup,
              sourceRevision: record.sourceRevision,
              sourceChanged: false,
              sourceChangeSummary: null,
              sourceChanges: null,
              ...reviewContext(record),
              ...initializedValues(record),
              MaterialGroup: source.MaterialGroup,
              reviewedPurchasingGroup: source.PurchasingGroup,
              Supplier: source.Supplier,
              materialGroupState: filled(source.MaterialGroup)
                ? "unreviewed_source"
                : null,
              purchasingGroupState: filled(source.PurchasingGroup)
                ? "unreviewed_source"
                : null,
              supplierState: filled(source.Supplier)
                ? "unreviewed_source"
                : null,
            })
            .where(key);
          await cds.run(cds.ql.DELETE.from(REVIEW_ASSIGNMENT).where(key));
          if (assignments.length)
            await UPSERT.into(REVIEW_ASSIGNMENT).entries(
              assignments.filter((a: Row) => !a.IsDeleted),
            );
          refreshed = true;
        }
      } else if (
        review &&
        !changed &&
        (review.lifecycleStatus !== status ||
          review.readinessSummary !== record.readinessSummary)
      )
        await UPDATE.entity(REVIEW)
          .set({
            ...lifecycle(status),
            readinessSummary: record.readinessSummary,
          })
          .where(key);
      if (
        review &&
        status === "completed" &&
        review.lifecycleStatus !== "completed"
      )
        await UPDATE.entity(REVIEW).set(lifecycle("completed")).where(key);
      if (
        review &&
        changed &&
        !refreshed &&
        review.sourceRevision !== record.sourceRevision
      ) {
        const comparison = (changes ?? [])
          .map(
            (change: any) =>
              `${change.field}: ${change.before ?? "(empty)"} -> ${change.after ?? "(empty)"}`,
          )
          .join("; ");
        await UPDATE.entity(REVIEW)
          .set({
            sourceChanged: true,
            sourceChangeSummary: `The request changed after your review. Compare the changes before submitting.${comparison ? ` ${comparison}` : ""}`,
            sourceChanges: JSON.stringify(changes ?? []),
          })
          .where(key);
      }
      if (review && !changed) await repairWorkingCopy(record, review);
      const currentReview = await SELECT.one.from(REVIEW).where(key);
      const decisions = decisionState(
        { ...record, isOpen: source.isOpen },
        currentReview,
        status,
        !!currentReview?.sourceChanged,
      );
      await UPDATE.entity(REVIEW).set(decisions).where(key);
      await UPSERT.into(`${NS}.RequisitionReviews`).entries({
        header_ID: ID,
        PurchaseRequisition: source.PurchaseRequisition,
        PurchaseRequisitionItem: source.PurchaseRequisitionItem,
        MaterialGroup:
          currentReview?.MaterialGroup ?? source.MaterialGroup ?? null,
        reviewedPurchasingGroup:
          currentReview?.reviewedPurchasingGroup ??
          source.PurchasingGroup ??
          null,
        Supplier: currentReview?.Supplier ?? source.Supplier ?? null,
        buyerNote: currentReview?.buyerNote ?? null,
        reviewStatus: reviewStatus(status, source.isOpen),
        materialGroupState: currentReview?.materialGroupState ?? null,
        purchasingGroupState: currentReview?.purchasingGroupState ?? null,
        supplierState: currentReview?.supplierState ?? null,
        reviewStateText: currentReview?.reviewStateText ?? null,
        readinessSummary:
          currentReview?.readinessSummary ?? record.readinessSummary ?? null,
        enrichmentStatus:
          currentReview?.enrichmentStatus ?? record.enrichmentStatus ?? null,
        routedBuyer: source.routedBuyer ?? null,
        routedGroup: source.routedGroup ?? null,
        sourceRevision: record.sourceRevision,
        sourceChanged: !!(
          currentReview?.sourceChanged ||
          (changed &&
            !refreshed &&
            currentReview?.sourceRevision !== record.sourceRevision)
        ),
        requestedAt: source.requestedAt ?? source.date ?? null,
        requestText: source.text ?? null,
        RequisitionerName: source.RequisitionerName ?? null,
        Plant: source.Plant ?? null,
        DeliveryDate: source.DeliveryDate ?? null,
        RequestedQuantity: source.RequestedQuantity ?? null,
        BaseUnit: source.BaseUnit ?? null,
        PurchasingOrganization: source.PurchasingOrganization ?? null,
        CompanyCode: source.CompanyCode ?? null,
        AccountAssignmentCategory: source.AccountAssignmentCategory ?? null,
        PurchaseRequisitionPrice: source.PurchaseRequisitionPrice ?? null,
        PurReqnItemCurrency: source.PurReqnItemCurrency ?? null,
        accountAssignments: JSON.stringify(i.accountAssignments ?? []),
        proposals: JSON.stringify(
          await SELECT.from(`${NS}.FreetextProposal`).where(key),
        ),
      });
      await touchCase(ID);
      if (currentWorkflowCommand() && (changed || current?.lifecycleStatus !== status))
        await INSERT.into("tide.workflow.ReviewEvents").entries({
          ID: cds.utils.uuid(),
          PurchaseRequisition: source.PurchaseRequisition,
          PurchaseRequisitionItem: source.PurchaseRequisitionItem,
          command_ID: currentWorkflowCommand(),
          occurredAt: new Date().toISOString(),
          event: "source_reconciled",
          fromStage: current?.lifecycleStatus ?? null,
          toStage: status,
          actor: cds.context!.user.id,
          sourceRevision: record.sourceRevision,
          reason: completed ? "Verified purchase-order conversion" :
            source.IsDeleted ? "Explicit source deletion" : "Source evidence refreshed",
        });
    }
  });
}

/**
 * Prepared demo read models deliberately omit mutable review drafts. Older
 * prepared snapshots can nevertheless contain work items without their
 * corresponding FreetextReview rows. Restore only those missing rows from the
 * durable work-item source so a reusable snapshot still serves Requests.
 */
export async function ensureMissingReviews(): Promise<number> {
  const [workItems, reviews]: [Row[], Row[]] = await Promise.all([
    SELECT.from(WORK),
    SELECT.from(REVIEW).columns(
      "PurchaseRequisition",
      "PurchaseRequisitionItem",
    ),
  ]);
  const existing = new Set(
    reviews.map(
      (row) => `${row.PurchaseRequisition}/${row.PurchaseRequisitionItem}`,
    ),
  );
  const missing: StoredItem[] = workItems
    .filter(
      (row) =>
        !existing.has(
          `${row.PurchaseRequisition}/${row.PurchaseRequisitionItem}`,
        ),
    )
    .map((row) => {
      let accountAssignments: Row[] = [];
      try {
        accountAssignments = JSON.parse(row.accountAssignments ?? "[]");
      } catch {
        // Restore the review even if a legacy account-assignment value is invalid.
      }
      return {
        ...row,
        id: itemKey(row as unknown as StoredItem),
        date: row.requestedAt,
        sourcePurchasingGroup: row.PurchasingGroup,
        sourceMaterialGroup: row.MaterialGroup,
        sourceSupplier: row.Supplier,
        deliveryAddress: {
          Name: row.DeliveryAddressName,
          Street: row.DeliveryAddressStreet,
          City: row.DeliveryAddressCity,
          PostalCode: row.DeliveryAddressPostalCode,
          Country: row.DeliveryAddressCountry,
          UnloadingPoint: row.UnloadingPoint,
        },
        isOpen: !!row.isOpen,
        demo: !!row.demo,
        accountAssignments,
      } as unknown as StoredItem;
    });
  if (missing.length) await syncWorkItems(missing);
  return missing.length;
}

export async function markEnrichment(i: StoredItem, props: Proposal[]) {
  const failed = props.some(
    (p) => !p.value && p.reason && !/insufficient context/.test(p.reason),
  );
  await UPDATE.entity(WORK)
    .set({
      enrichmentStatus: failed ? "failed" : "succeeded",
      readinessSummary: failed
        ? "Suggestion unavailable · complete manually"
        : props.some((p) => p.value)
          ? "Suggested · needs review"
          : "Missing values · complete manually",
    })
    .where(keyOf(i));
  await UPDATE.entity(REVIEW)
    .set({
      readinessSummary: failed
        ? "Suggestion unavailable · complete manually"
        : props.some((p) => p.value)
          ? "Suggested · needs review"
          : "Missing values · complete manually",
    })
    .where(keyOf(i));
  await UPDATE.entity(REVIEW)
    .set({ enrichmentStatus: failed ? "failed" : "succeeded" })
    .where(keyOf(i));
  const existing = await SELECT.one.from(REVIEW).where(keyOf(i));
  if (
    existing &&
    ![
      existing.materialGroupState,
      existing.purchasingGroupState,
      existing.supplierState,
    ].some((x: string) => ["confirmed", "corrected", "entered"].includes(x))
  )
    await UPDATE.entity(REVIEW)
      .set({
        reviewStateText: props
          .map(
            (p) =>
              `${p.field}: ${p.value ? `Suggested${p.confidence === null ? "" : ` · ${Math.round(p.confidence * 100)}% confidence`}` : "No suggestion"}`,
          )
          .join("; ")
          .slice(0, 160),
      })
      .where(keyOf(i));
  // Suggestions are applied only through applyProvisionalSuggestions in an editable draft.
  const source = await SELECT.one.from(WORK).where(keyOf(i));
  const review = await SELECT.one.from(REVIEW).where(keyOf(i));
  if (source && review)
    await UPDATE.entity(REVIEW)
      .set(decisionState(source, review, source.lifecycleStatus))
      .where(keyOf(i));
}

export async function markPending(items: StoredItem[]) {
  for (const i of items) {
    await UPDATE.entity(WORK)
      .set({ enrichmentStatus: "pending" })
      .where(keyOf(i));
    await UPDATE.entity(REVIEW)
      .set({ enrichmentStatus: "pending" })
      .where(keyOf(i));
  }
}

async function reconcileReviewListing(commandType: string, sources: Row[], execute: () => Promise<void>) {
  if (!sources.length) return;
  const subjects = new Map<string, { kind: "case" | "action"; ID: string }>();
  const observations: Row[] = [];
  for (const source of sources) {
    subjects.set(caseID(source), { kind: "case", ID: caseID(source) });
    const action = source.actionID
      ? await SELECT.one.from(`${NS}.Actions`).where({ ID: source.actionID }) : null;
    observations.push({ source, action: action ?? null });
    if (action) {
      subjects.set(action.ID, { kind: "action", ID: action.ID });
      const owners = await SELECT.from(`${NS}.CaseActions`).where({ action_ID: action.ID });
      for (const owner of owners) subjects.set(owner.header_ID, { kind: "case", ID: owner.header_ID });
    }
  }
  observations.sort((left, right) => caseID(left.source).localeCompare(caseID(right.source)));
  const evidence = { observations };
  await executeWorkflowCommand({
    commandID: `review-listing:${createHash("sha256").update(JSON.stringify({ commandType, evidence })).digest("hex")}`,
    commandType,
    arguments: evidence,
    subjects: [...subjects.values()],
  }, {
    authorize: async () => {
      const scope = scopeOf(cds.context!.user);
      for (const source of sources)
        if (!inScope(scope, source)) throw fail(404, "Case not found");
      for (const subject of subjects.values()) {
        if (subject.kind !== "case") continue;
        const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: subject.ID });
        if (!header || !inScope(scope, header)) throw fail(404, "Case not found");
      }
    },
    execute: async () => {
      await execute();
      return { reconciled: sources.map(source => caseID(source)) };
    },
  });
}

export async function closeMissingWorkItems(openKeys: Set<string>) {
  return inTx(async () => {
  const current: Row[] = await SELECT.from(WORK).where({ isOpen: true });
  const missing = current.filter(row => !openKeys.has(itemKey(row as StoredItem)));
  await reconcileReviewListing("unlistMissingReviewSource", missing, async () => {
  for (const row of missing) {
    const update = {
      readinessSummary: "Source item unavailable; fulfillment is not confirmed",
    };
    await UPDATE.entity(WORK).set(update).where(keyOf(row));
    await UPDATE.entity(REVIEW).set(update).where(keyOf(row));
    await setListing(caseID(row), "unlisted");
  }
  });
  });
}

/** A changed PR may no longer pass buildItems' free-text/deletion filter. */
export async function closeRemovedWorkItems(
  keys: Row[],
  surviving: Set<string>,
) {
  return inTx(async () => {
  const removed: Row[] = [];
  for (const key of keys) {
    const work = await SELECT.one.from(WORK).where(keyOf(key));
    if (!work || surviving.has(itemKey(work as StoredItem)) || !work.isOpen)
      continue;
    removed.push(work);
  }
  await reconcileReviewListing("unlistIneligibleReviewSource", removed, async () => {
  for (const work of removed) {
    if (work.actionID) {
      const action = await SELECT.one.from(`${NS}.Actions`).where({ ID: work.actionID });
      if (action && ["needs_decision", "waiting"].includes(action.status))
        await supersede(action.ID, "The source item no longer qualifies for the reviewed operation.");
    }
    await UPDATE.entity(WORK)
      .set({ isOpen: false, ...lifecycle("source_changed") })
      .where(keyOf(work));
    const review = await SELECT.one.from(REVIEW).where(keyOf(work));
    await UPDATE.entity(REVIEW)
      .set({
        ...lifecycle("source_changed"),
        ...decisionState({ ...work, isOpen: false }, review, "source_changed"),
      })
      .where(keyOf(work));
    await setTypedReviewStatus({ ...work, isOpen: false }, "in_progress");
    await setListing(caseID(work), "unlisted");
  }
  });
  });
}

export async function reconcileReview(req: cds.Request) {
  return inTx(() => reconcileReviewCommand(req));
}

async function reconcileReviewCommand(req: cds.Request) {
  const key = keyOf(req.params[0] as Row);
  const source = await SELECT.one.from(WORK).where(key);
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  if (
    !source.isOpen ||
    source.lifecycleStatus === "awaiting_approval" ||
    source.lifecycleStatus === "completed"
  )
    throw fail(409, "Only open reviews can be reconciled");
  const old = await SELECT.one.from(REVIEW).where(key);
  if (old.sourceRevision === source.sourceRevision)
    return SELECT.one
      .from("PurchasingDeskService.PurchaseRequisitionReviews")
      .where(key);
  if (await SELECT.one.from(draft()).where(key))
    throw fail(
      409,
      "Discard or save the editing draft before reconciling this source update",
    );
  const patches: Row = {
    ...reviewContext(source),
    Plant: source.Plant,
    PurchasingGroup: source.PurchasingGroup,
    routedBuyer: source.routedBuyer,
    sourceRevision: source.sourceRevision,
    sourceChanged: false,
    sourceChangeSummary: null,
    sourceChanges: null,
  };
  const origins = parseOrigins(old.fieldOrigins);
  for (const [name, value] of Object.entries(draftValues(source))) {
    if (!origins[name]?.startsWith("buyer_")) {
      patches[name] = value;
      if (filled(value)) origins[name] = "source";
      else delete origins[name];
    }
  }
  patches.fieldOrigins = JSON.stringify(origins);
  for (const [field, property, state] of [
    ["MaterialGroup", "MaterialGroup", "materialGroupState"],
    ["PurchasingGroup", "reviewedPurchasingGroup", "purchasingGroupState"],
    ["Supplier", "Supplier", "supplierState"],
  ]) {
    if (
      filled(source[field]) &&
      filled(old[property]) &&
      source[field] !== old[property]
    )
      throw fail(
        409,
        `${field} changed in the source; resolve the conflict before reconciling`,
      );
    if (filled(source[field])) {
      patches[property] = source[field];
      patches[state] = "source";
    }
  }
  const affected = await UPDATE.entity(REVIEW)
    .set({
      ...patches,
      ...decisionState(source, { ...old, ...patches }, source.lifecycleStatus),
    })
    .where({
      ...key,
      sourceRevision: old.sourceRevision,
      modifiedAt: old.modifiedAt,
    });
  if (Number(affected) !== 1)
    throw fail(
      409,
      "Review changed concurrently; reload before reconciliation",
    );
  await acknowledgeSourceChange(caseID(source), source.sourceFingerprint);
  await setTypedReviewStatus(source, "new");
  return SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews")
    .where(key);
}

/** Explicit buyer gesture; confidence only describes the suggestion. */
export async function confirmCurrentValues(req: cds.Request) {
  const key = keyOf(req.params[0] as Row);
  const source = await SELECT.one.from(WORK).where(key);
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  if (!source.isOpen || source.lifecycleStatus !== "needs_review")
    throw fail(409, "This requisition cannot be reviewed now");
  if (await SELECT.one.from(draft()).where(key))
    throw fail(409, "Save the editing draft before confirming suggestions");
  const review = await SELECT.one.from(REVIEW).where(key);
  if (review.sourceRevision !== source.sourceRevision)
    throw fail(409, "Refresh the source values before confirming suggestions");
  const props = await SELECT.from(PROPOSAL).where({
    ...key,
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceFingerprint,
  });
  const updates: Row = {};
  for (const [field, property, state] of [
    ["MaterialGroup", "MaterialGroup", "materialGroupState"],
    ["PurchasingGroup", "reviewedPurchasingGroup", "purchasingGroupState"],
    ["Supplier", "Supplier", "supplierState"],
  ]) {
    const p = props.find((x: Row) => x.field === field);
    const current = review[property];
    if (!filled(current)) continue;
    if (current === source[field]) updates[state] = "confirmed";
    else if (
      p?.value === current &&
      (await allowed(field, current, validationContext(source, review)))
    )
      updates[state] = "confirmed";
  }
  if (!Object.keys(updates).length)
    throw fail(409, "There are no current suggestions to confirm");
  updates.reviewStateText = ["MaterialGroup", "PurchasingGroup", "Supplier"]
    .map(
      (field) =>
        `${field}: ${stateText(updates[{ MaterialGroup: "materialGroupState", PurchasingGroup: "purchasingGroupState", Supplier: "supplierState" }[field]!] ?? review[{ MaterialGroup: "materialGroupState", PurchasingGroup: "purchasingGroupState", Supplier: "supplierState" }[field]!])}`,
    )
    .join("; ")
    .slice(0, 160);
  await UPDATE.entity(REVIEW)
    .set({
      ...updates,
      ...decisionState(
        source,
        { ...review, ...updates },
        source.lifecycleStatus,
      ),
    })
    .where(key);
  return SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews")
    .where(key);
}

export function requireBuyer(req: Pick<cds.Request, "user">, source: Row) {
  const scope = scopeOf(req.user);
  if (
    !scope.isAdmin &&
    (!scope.PurchasingGroup || !source.routedBuyer || !source.routedGroup)
  )
    throw fail(403, "Purchase requisition is not routed to a buyer scope");
  if (
    !scope.isAdmin &&
    (source.routedBuyer !== req.user.id ||
      source.routedGroup !== scope.PurchasingGroup)
  )
    throw fail(403, "Purchase requisition is outside your buyer queue");
  if (!scope.isAdmin && !inScope(scope, { Plant: source.Plant }))
    throw fail(403, "Purchase requisition is outside your buyer queue");
}

export async function guardReview(req: cds.Request) {
  const patching =
    req.event === "PATCH" ||
    (req.event === "UPDATE" &&
      !["SAVE", "draftActivate", "draftPrepare"].includes(
        (req as any)._.event,
      ));
  const key: Row = { ...(req.params?.[0] ?? {}), ...(req.data ?? {}) };
  if (
    patching &&
    [
      "fieldOrigins",
      "workingCopyVersion",
      "routedGroup",
      "sourceChanges",
      "sourceChangeSummary",
      "reviewStatusText",
      "reviewStatusCriticality",
      "nextStep",
      "isReadyToSubmit",
      "requiresSourceReconciliation",
      "isOverdueForReview",
    ].some((name) => name in req.data)
  )
    throw fail(400, "Review metadata is read-only");
  for (const protectedField of [
    "Plant",
    "PurchasingGroup",
    "routedBuyer",
    "sourceRevision",
    "predictionGeneration",
    "allocationPredictionGeneration",
    "requestText",
    "itemLongText",
    "headerNote",
    "RequisitionerName",
    "requestedAt",
    "DeliveryDate",
    "RequestedQuantity",
    "BaseUnit",
    "PurchasingOrganization",
    "CompanyCode",
    "PurchasingDocumentItemCategory",
    "AccountAssignmentCategory",
    "accountAssignments",
    "PurchaseRequisitionPrice",
    "PurReqnPriceQuantity",
    "ItemNetAmount",
    "PurReqnItemCurrency",
    "StorageLocation",
    "Material",
    "PurchasingInfoRecord",
    "OutlineAgreement",
    "OutlineAgreementItem",
    "TaxCode",
    "GoodsReceiptIsExpected",
    "InvoiceIsGoodsReceiptBased",
    "IsEvaluatedRcptSettlmtAllowed",
    "ServicePerformer",
    "PerformancePeriodStartDate",
    "PerformancePeriodEndDate",
    "ExpectedOverallLimitAmount",
    "OverallLimitAmount",
    "DeliveryAddressName",
    "DeliveryAddressStreet",
    "DeliveryAddressCity",
    "DeliveryAddressPostalCode",
    "DeliveryAddressCountry",
    "UnloadingPoint",
    "lifecycleStatus",
    "lifecycleText",
    "lifecycleCriticality",
    "readinessSummary",
    "sourceChanged",
    "enrichmentStatus",
    "findingID",
    "actionID",
    "reviewStateText",
    "materialGroupState",
    "purchasingGroupState",
    "supplierState",
    "accountAssignmentCategoryState",
    "itemCategoryState",
  ]) {
    if (patching && protectedField in req.data)
      throw fail(400, `${protectedField} is read-only`);
  }
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  if (!source.isOpen || source.lifecycleStatus === "completed")
    throw fail(409, "This source requisition is closed");
  if (source.lifecycleStatus === "awaiting_approval")
    throw fail(409, "This requisition is awaiting approval");
  const original = await SELECT.one.from(REVIEW).where(keyOf(key));
  if (original && original.sourceRevision !== source.sourceRevision)
    throw fail(
      409,
      "The source requisition changed; reconcile the review before editing",
    );
  if (req.event === "SAVE" && original) {
    const candidate = await SELECT.one.from(draft()).where(keyOf(key));
    if (!candidate || candidate.sourceRevision !== source.sourceRevision)
      throw fail(
        409,
        "The source requisition changed while this draft was open",
      );
    for (const [field, policy] of Object.entries(FIELD_POLICIES)) {
      const property = policy.property;
      if (
        filled(candidate?.[property]) &&
        !(await allowed(
          field,
          candidate[property],
          validationContext(source, candidate),
        ))
      )
        throw fail(
          400,
          `${field} ${candidate[property]} is not a valid code in this scope`,
        );
    }
  }
  const choices: [string, string][] = FIELDS.map((field) => [
    FIELD_POLICIES[field].property,
    field,
  ]);
  const pending = patching
    ? await SELECT.one.from(draft()).where(keyOf(key))
    : null;
  if (patching) {
    const origins = parseOrigins(
      pending?.fieldOrigins ?? original?.fieldOrigins,
    );
    for (const name of [
      ...Object.keys(draftValues(source)),
      ...choices.map(([property]) => property),
      "buyerNote",
    ]) {
      if (name in req.data)
        origins[name] = filled(req.data[name])
          ? "buyer_changed"
          : "buyer_cleared";
    }
    req.data.fieldOrigins = JSON.stringify(origins);
    req.data.workingCopyVersion = 1;
  }
  for (const [property, field] of choices) {
    if (!(property in req.data)) continue;
    if (
      filled(req.data[property]) &&
      !(await allowed(
        field,
        req.data[property],
        validationContext(source, { ...original, ...pending, ...req.data }),
      ))
    )
      throw fail(
        400,
        `${field} ${req.data[property]} is not a valid code in this scope`,
      );
    const proposal = await SELECT.one.from(PROPOSAL).where({
      ...keyOf(key),
      field,
      sourceRevision: source.sourceRevision,
      sourceFingerprint: source.sourceFingerprint,
    });
    const state = !filled(req.data[property])
      ? field === "Supplier" ||
        CATEGORY_FIELDS.has(field) ||
        FIELD_POLICIES[field as Field].optional
        ? "not_applicable"
        : null
      : req.data[property] === source[field]
        ? "confirmed"
        : !proposal?.value
          ? "entered"
          : proposal.value === req.data[property]
            ? "confirmed"
            : "corrected";
    if (patching) req.data[FIELD_POLICIES[field as Field].state] = state;
  }
  if (patching && choices.some(([property]) => property in req.data)) {
    const values: Row = { ...original, ...pending, ...req.data };
    req.data.reviewStateText = FIELDS.map(
      (field) =>
        `${FIELD_TEXT[field]}: ${stateText(values[FIELD_POLICIES[field].state])}`,
    )
      .join("; ")
      .slice(0, 160);
  }
}

export async function workspaceContext(
  req: ReviewCommandRequest,
  activeOnly = false,
) {
  const key = req.params[0] as Row;
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  if (
    activeOnly &&
    (key.IsActiveEntity === false ||
      (await SELECT.one.from(draft()).where(keyOf(key))))
  )
    throw fail(409, "Save the editing draft before reviewing the order");
  const review = await SELECT.one
    .from(key.IsActiveEntity === false ? draft() : REVIEW)
    .where(keyOf(key));
  if (!review) throw fail(404, "Review not found");
  if (key.IsActiveEntity === false) await requireDraftOwner(review, req.user);
  return { source, review };
}

async function requireDraftOwner(review: Row, user: cds.User) {
  const admin = await SELECT.one.from("DRAFT.DraftAdministrativeData").where({
    DraftUUID: review.DraftAdministrativeData_DraftUUID,
  });
  if (!admin || admin.InProcessByUser !== user.id)
    throw fail(
      409,
      "The editing draft belongs to another buyer or is no longer available",
    );
}

function predictionInput(review: Row) {
  return {
    text: review.reviewedShortText ?? "",
    Plant: review.reviewedPlant ?? null,
    PurchasingOrganization: review.reviewedPurchasingOrganization ?? null,
    PurchaseOrderType: review.PurchaseOrderType ?? null,
    RequestedQuantity: review.reviewedQuantity ?? null,
    BaseUnit: review.reviewedUnit ?? null,
    CompanyCode: review.reviewedCompanyCode ?? null,
    PurchaseRequisitionPrice: review.reviewedValuationPrice ?? null,
    PurReqnPriceQuantity: review.reviewedPriceQuantity ?? null,
    PurReqnItemCurrency: review.reviewedCurrency ?? null,
    DeliveryDate: review.reviewedDeliveryDate ?? null,
    StorageLocation: review.reviewedStorageLocation ?? null,
    itemLongText: review.reviewedLongText ?? null,
    headerNote: review.reviewedHeaderNote ?? null,
  };
}

export function predictionInputHash(review: Row) {
  return createHash("sha256")
    .update(JSON.stringify(predictionInput(review)))
    .digest("hex");
}

function draftKey(source: Row, review: Row) {
  const uuid = review.DraftAdministrativeData_DraftUUID;
  if (!uuid) throw fail(409, "The editing draft is no longer available");
  return { ...keyOf(source), DraftAdministrativeData_DraftUUID: uuid };
}

function requestedPredictionFields(raw: unknown): string[] {
  let selected: unknown = raw;
  if (typeof raw === "string") {
    try {
      selected = JSON.parse(raw);
    } catch {
      throw fail(400, "selectedFields must be a JSON array");
    }
  }
  if (!Array.isArray(selected) || !selected.length)
    throw fail(400, "Select at least one field to predict");
  const fields = [...new Set(selected.map(String))];
  if (fields.some((field) => !PREDICTION_FIELDS.includes(field as any)))
    throw fail(400, "An unsupported prediction field was selected");
  return fields;
}

function predictionItem(source: Row, review: Row): StoredItem {
  const input = predictionInput(review);
  const id = `Q/${cds.utils.uuid()}`;
  return {
    ...input,
    id,
    PurchaseRequisition: "Q",
    PurchaseRequisitionItem: id.slice(2, 7),
    text: input.text,
    Plant: input.Plant,
    PurchasingOrganization: input.PurchasingOrganization,
    PurchaseOrderType: input.PurchaseOrderType,
    date: source.date ?? new Date().toISOString().slice(0, 10),
    sourceMaterialGroup: source.MaterialGroup ?? null,
    sourcePurchasingGroup: source.PurchasingGroup ?? null,
    sourceSupplier: source.Supplier ?? null,
    sourcePurchasingInfoRecord: source.PurchasingInfoRecord ?? null,
    sourceAccountAssignmentCategory: source.AccountAssignmentCategory ?? null,
    sourceItemCategory: source.PurchasingDocumentItemCategory ?? null,
    isOpen: true,
    isQuery: true,
    routedBuyer: source.routedBuyer,
    routedGroup: source.routedGroup,
  };
}

function sameTimestamp(actual: unknown, expected: unknown) {
  if (!expected) return true;
  return (
    new Date(String(actual)).getTime() === new Date(String(expected)).getTime()
  );
}

function launchPrediction(req: cds.Request, job: Row) {
  const user = req.user;
  const tenant = cds.context?.tenant;
  const launch = () => {
    const ctx = new (cds.EventContext as any)({
      user,
      tenant,
      locale: cds.context?.locale,
    });
    (cds as any)._with(ctx, () =>
      runDraftPrediction(user, job).catch(() => undefined),
    );
  };
  const inbound = req as any;
  if (typeof inbound.on === "function") inbound.on("succeeded", launch);
  else setTimeout(launch, 0).unref?.();
}

async function qualifiedFields(
  labelled: StoredItem[],
  item: StoredItem,
  fields: string[],
) {
  // Stored calibrations drive prefill and reliability; an empty list would hide them.
  const thresholds: StoredThreshold[] = fields.length
    ? await SELECT.from(`${NS}.FreetextThreshold`).where({ field: { in: fields } })
    : [];
  const qualified: string[] = [];
  const unavailable = new Map<string, string>();
  for (const field of fields) {
    if (!(await applicable(field, item))) {
      unavailable.set(field, "fixed_source");
      continue;
    }
    qualified.push(field);
  }
  return { qualified, unavailable, thresholds };
}

async function updateEvidence(job: Row, patch: Row, field?: string) {
  const where = {
    ...job.draftIdentity,
    generation: job.generation,
    inputHash: job.inputHash,
    status: "pending",
    ...(field ? { field } : {}),
  };
  return UPDATE.entity(job.active ? EVIDENCE : DRAFT_EVIDENCE)
    .set(patch)
    .where(where);
}

async function runDraftPrediction(user: cds.User, job: Row) {
  const item = predictionItem(job.source, job.review);
  try {
    const [currentSource, currentDraft] = await cds.tx({ user }, async () =>
      Promise.all([
        SELECT.one.from(WORK).where(keyOf(job.source)),
        SELECT.one.from(job.active ? REVIEW : draft()).where(job.draftIdentity),
      ]),
    );
    if (!currentDraft) return;
    if (
      !currentSource ||
      !currentSource.isOpen ||
      currentSource.sourceRevision !== job.source.sourceRevision ||
      currentSource.sourceFingerprint !== job.source.sourceFingerprint ||
      currentSource.routedBuyer !== job.source.routedBuyer ||
      currentSource.routedGroup !== job.source.routedGroup ||
      predictionInputHash(currentDraft) !== job.inputHash ||
      currentDraft.predictionGeneration !== job.generation
    ) {
      await updateEvidence(job, {
        status: "stale",
        reason: "source_changed",
        completedAt: new Date().toISOString(),
      });
      return;
    }
    requireBuyer({ user } as cds.Request, currentSource);
    if (!job.active) await requireDraftOwner(currentDraft, user);
    item.accountAssignments = await cds.tx({ user }, async () =>
      SELECT.from(`${NS}.FreetextWorkItemAccountAssignment`).where(
        keyOf(job.source),
      ),
    );
    await upsertItems([item]);
    const labelled = labelledOf(await readItems());
    const { qualified, unavailable, thresholds } = await qualifiedFields(
      labelled,
      {
        ...item,
        FixedSupplier: job.source.FixedSupplier,
        SourceOfSupplyIsAssigned: job.source.SourceOfSupplyIsAssigned,
        PurchasingInfoRecord: job.source.PurchasingInfoRecord,
      },
      job.fields,
    );
    for (const [field, reason] of unavailable)
      await updateEvidence(
        job,
        {
          status: "unavailable",
          reason,
          completedAt: new Date().toISOString(),
        },
        field,
      );
    if (!qualified.length) return;
    const meter = {
      user,
      calls: 0,
      cost: 0,
      runs: [],
      planned: [],
      backend: null,
      failed: [],
    };
    const results = await propose(labelled, [item], {
      fields: qualified,
      thresholds,
      classify: coreClassify(meter),
    });
    const proposals = results.get(itemKey(item)) ?? [];
    await cds.tx({ user }, async () => {
      const latestSource = await SELECT.one.from(WORK).where(keyOf(job.source));
      const latestDraft = await SELECT.one
        .from(job.active ? REVIEW : draft())
        .where(job.draftIdentity);
      const stillCurrent =
        latestDraft &&
        latestSource?.isOpen &&
        predictionInputHash(latestDraft) === job.inputHash &&
        latestDraft.predictionGeneration === job.generation &&
        latestSource.sourceRevision === job.source.sourceRevision &&
        latestSource.sourceFingerprint === job.source.sourceFingerprint &&
        latestSource.routedBuyer === job.source.routedBuyer &&
        latestSource.routedGroup === job.source.routedGroup;
      if (!stillCurrent) {
        if (latestDraft)
          await updateEvidence(job, {
            status: "stale",
            reason: "draft_or_source_changed",
            completedAt: new Date().toISOString(),
          });
        return;
      }
      requireBuyer({ user } as cds.Request, latestSource);
      if (!job.active) await requireDraftOwner(latestDraft, user);
      for (const proposal of proposals) {
        const threshold = thresholds.find(
          (row) =>
            row.field === proposal.field && row.segment === proposal.segment,
        );
        const failed =
          !proposal.value &&
          (proposal.failed ||
            /failed|timeout|timed out|run .* (?:canceled|cancelled)/i.test(
              proposal.reason ?? "",
            ));
        await updateEvidence(
          job,
          {
            status: proposal.value
              ? "available"
              : failed
                ? "failed"
                : "unavailable",
            reason: failed ? "model_failed" : (proposal.reason ?? null),
            value: proposal.value,
            candidates: JSON.stringify(proposal.alternatives),
            modelScore: proposal.confidence,
            historicalReliability:
              threshold?.threshold != null &&
              proposal.confidence != null &&
              proposal.confidence >= threshold.threshold
                ? threshold.accuracyAtThreshold
                : null,
            calibrationIdentity: threshold
              ? `${proposal.field}:${proposal.segment}:${(threshold as Row).createdAt ?? ""}`
              : null,
            runIdentity: meter.runs.join(",").slice(0, 120) || null,
            backend: proposal.backend ?? null,
            modelVersion: proposal.modelVersion ?? null,
            computedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
          proposal.field,
        );
      }
    });
  } catch (error: any) {
    const draftStillExists = await SELECT.one
      .from(job.active ? REVIEW : draft())
      .where(job.draftIdentity);
    if (draftStillExists)
      await updateEvidence(job, {
        status: "failed",
        reason: String(error?.code ?? error?.message ?? error).slice(0, 200),
        completedAt: new Date().toISOString(),
      });
  } finally {
    await deleteItems([item.id]);
  }
}

async function draftEvidence(req: cds.Request, field?: string) {
  const { source, review } = await workspaceContext(req);
  const inputHash = predictionInputHash(review);
  const where: Row = {
    ...draftKey(source, review),
    inputHash,
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceFingerprint,
  };
  if (field) where.field = field;
  return SELECT.from(DRAFT_EVIDENCE).where(where);
}

/** Claims active or draft evidence and starts model work only after the request commits. */
export async function predictDraftFields(req: cds.Request) {
  const { source, review } = await workspaceContext(req);
  const active = req.params[0]?.IsActiveEntity !== false;
  if (!source.isOpen || review.sourceRevision !== source.sourceRevision)
    throw fail(409, "Refresh the source before predicting");
  const fields = requestedPredictionFields(req.data.selectedFields);
  const inputHash = predictionInputHash(review);
  if (req.data.expectedInputHash && req.data.expectedInputHash !== inputHash)
    throw fail(409, "The working inputs changed before prediction started");
  if (
    req.data.expectedDraftUUID &&
    req.data.expectedDraftUUID !== review.DraftAdministrativeData_DraftUUID
  )
    throw fail(409, "The editing draft changed before prediction started");
  if (!sameTimestamp(review.modifiedAt, req.data.expectedModifiedAt))
    throw fail(409, "The editing draft changed before prediction started");
  const draftIdentity = active ? keyOf(source) : draftKey(source, review);
  const generation = Number(review.predictionGeneration ?? 0) + 1;
  const claimed = await UPDATE.entity(active ? REVIEW : draft())
    .set({
      predictionGeneration: generation,
      ...(active
        ? { modifiedAt: review.modifiedAt, modifiedBy: review.modifiedBy }
        : {}),
    })
    .where({
      ...draftIdentity,
      predictionGeneration: review.predictionGeneration ?? 0,
      ...(active ? { modifiedAt: review.modifiedAt } : {}),
    });
  if (Number(claimed) !== 1)
    throw fail(409, "Another prediction refresh has already started");
  const now = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + PENDING_DEADLINE_MS).toISOString();
  const pending = fields.map((field) => ({
    ...draftIdentity,
    generation,
    field,
    inputHash,
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceFingerprint,
    status: "pending",
    reason: null,
    requestedAt: now,
    deadlineAt,
  }));
  await UPDATE.entity(active ? EVIDENCE : DRAFT_EVIDENCE)
    .set({
      status: "canceled",
      reason: "superseded_by_refresh",
      completedAt: now,
    })
    .where({ ...draftIdentity, status: "pending" });
  await INSERT.into(active ? EVIDENCE : DRAFT_EVIDENCE).entries(pending);
  launchPrediction(req, {
    active,
    source,
    review,
    draftIdentity,
    generation,
    inputHash,
    fields,
  });
  return JSON.stringify({
    generation,
    inputHash,
    deadlineAt,
    outcomes: pending.map(({ field, status }) => ({ field, status })),
  });
}

export async function applyDraftSuggestion(req: cds.Request) {
  const { source, review } = await workspaceContext(req);
  if (req.params[0]?.IsActiveEntity !== false)
    throw fail(409, "Choose Edit before applying a suggestion");
  const field = String(req.data.field ?? "");
  const property = DRAFT_FIELD_PROPERTIES[field];
  if (!property)
    throw fail(400, "This field is not eligible for AI application");
  const inputHash = predictionInputHash(review);
  if (inputHash !== req.data.expectedInputHash)
    throw fail(409, "The working inputs changed; refresh suggestions");
  if (
    String(review[property] ?? "") !==
    String(req.data.expectedCurrentValue ?? "")
  )
    throw fail(409, "The working value changed; refresh suggestions");
  const rows: Row[] = await draftEvidence(req, field);
  const latestGeneration = Math.max(
    ...rows.map((row) => Number(row.generation)),
  );
  const evidence = rows.find(
    (row: Row) =>
      Number(row.generation) === latestGeneration &&
      Number(row.generation) === Number(req.data.evidenceGeneration) &&
      row.status === "available",
  );
  if (!evidence) throw fail(409, "That suggestion is no longer current");
  let candidates: Row[] = [];
  try {
    candidates = JSON.parse(evidence.candidates ?? "[]");
  } catch {
    throw fail(409, "That suggestion is invalid");
  }
  const candidate = String(req.data.candidate ?? "");
  if (
    candidate !== evidence.value &&
    !candidates.some((row) => row.value === candidate)
  )
    throw fail(400, "The selected candidate was not predicted for this draft");
  if (!(await applicable(field, source)))
    throw fail(
      409,
      "This field is fixed by the source and cannot be replaced by AI",
    );
  if (!(await allowed(field, candidate, validationContext(source, review))))
    throw fail(400, "The selected candidate is not valid in this scope");
  if (field === "AccountAssignmentCategory" && candidate !== BLANK_CATEGORY) {
    const assignments: Row[] = await SELECT.from(
      "PurchasingDeskService.FreetextReviewAccountAssignments.drafts",
    ).where(draftKey(source, review));
    if (!assignments.length)
      throw fail(
        400,
        "Add an account-assignment row before applying this category",
      );
    for (const assignment of assignments) {
      if (!filled(assignment.GLAccount))
        throw fail(400, "Account assignment needs a G/L account");
      if (candidate === "K" && !filled(assignment.CostCenter))
        throw fail(400, "Cost center is required for account assignment K");
      if (
        candidate === "E" &&
        (!filled(assignment.SalesOrder) || !filled(assignment.SalesOrderItem))
      )
        throw fail(
          400,
          "Sales order and item are required for account assignment E",
        );
      if (candidate === "A" && !filled(assignment.MainAsset))
        throw fail(400, "Main asset is required for account assignment A");
      if (candidate === "F" && !filled(assignment.InternalOrder))
        throw fail(400, "Internal order is required for account assignment F");
      if (candidate === "P" && !filled(assignment.WBSElement))
        throw fail(400, "WBS element is required for account assignment P");
    }
  }
  const origins = parseOrigins(review.fieldOrigins);
  origins[property] = "ai_applied";
  await UPDATE.entity(draft())
    .set({
      [property]: decodeValue(field, candidate),
      [REVIEW_STATES[field]]: "suggested",
      fieldOrigins: JSON.stringify(origins),
      workingCopyVersion: 1,
    })
    .where(draftKey(source, review));
  await UPSERT.into(DRAFT_DECISION).entries({
    ...draftKey(source, review),
    field,
    value: candidate,
    evidenceGeneration: evidence.generation,
    inputHash,
    appliedAt: new Date().toISOString(),
    confirmedAt: null,
  });
  return reviewWorkspace(req);
}

export async function confirmDraftValue(req: cds.Request) {
  const { source, review } = await workspaceContext(req);
  if (req.params[0]?.IsActiveEntity !== false)
    throw fail(409, "Choose Edit before confirming a value");
  const field = String(req.data.field ?? "");
  const property = DRAFT_FIELD_PROPERTIES[field];
  const currentValue = property ? decisionValue(field, review) : null;
  if (!property || !filled(currentValue))
    throw fail(409, "There is no value to confirm");
  if (
    String(decodeValue(field, String(currentValue)) ?? "") !==
    String(req.data.expectedCurrentValue ?? "")
  )
    throw fail(409, "The working value changed; refresh the draft");
  const inputHash = predictionInputHash(review);
  const previous = await SELECT.one
    .from(DRAFT_DECISION)
    .where({ ...draftKey(source, review), field });
  const applied =
    previous?.value === currentValue &&
    parseOrigins(review.fieldOrigins)[property] === "ai_applied"
      ? previous
      : null;
  await UPDATE.entity(draft())
    .set({ [REVIEW_STATES[field]]: "confirmed" })
    .where(draftKey(source, review));
  await UPSERT.into(DRAFT_DECISION).entries({
    ...draftKey(source, review),
    field,
    value: currentValue,
    evidenceGeneration: applied?.evidenceGeneration ?? null,
    inputHash: applied?.inputHash ?? inputHash,
    appliedAt: applied?.appliedAt ?? null,
    confirmedAt: new Date().toISOString(),
  });
  return reviewWorkspace(req);
}

async function valueName(field: string, value: string) {
  if (CATEGORY_FIELDS.has(field))
    return value === BLANK_CATEGORY || value === ""
      ? "Standard / no assignment"
      : value;
  if (field === "MaterialGroup")
    return (
      (
        await SELECT.one
          .from("tide.s4.ProductGroupText")
          .where({ ProductGroup: value, Language: "EN" })
      )?.ProductGroupName ?? value
    );
  if (field === "PurchasingGroup")
    return (
      (
        await SELECT.one
          .from("tide.s4.PurchasingGroup")
          .where({ PurchasingGroup: value })
      )?.PurchasingGroupName ?? value
    );
  if (field === "Material")
    return (
      (
        await SELECT.one
          .from("tide.s4.ProductDescription")
          .where({ Product: value, Language: "EN" })
      )?.ProductDescription ?? value
    );
  if (field === "PurchasingInfoRecord") {
    const master = await SELECT.one
      .from("tide.s4.PurchasingInfoRecord")
      .where({ PurchasingInfoRecord: value });
    return master
      ? [master.Material, master.Supplier].filter(filled).join(" / ") || value
      : value;
  }
  return (
    (await SELECT.one.from("tide.s4.Supplier").where({ Supplier: value }))
      ?.SupplierName ?? value
  );
}

const decodeValue = (field: string, value: string) =>
  CATEGORY_FIELDS.has(field) && value === BLANK_CATEGORY ? null : value;
const decisionValue = (field: string, review: Row) => {
  const policy = FIELD_POLICIES[field as Field];
  const value = review[policy.property];
  return CATEGORY_FIELDS.has(field) &&
    !filled(value) &&
    ["suggested", "confirmed", "not_applicable"].includes(review[policy.state])
    ? BLANK_CATEGORY
    : value;
};

async function applicable(field: string, source: Row) {
  if (field === "Material") return false;
  if (field === "Supplier")
    return !(source.SourceOfSupplyIsAssigned || filled(source.FixedSupplier));
  if (field === "PurchasingInfoRecord")
    return !(
      source.SourceOfSupplyIsAssigned && filled(source.PurchasingInfoRecord)
    );
  return true;
}

/** Current, master-data-validated evidence. No model calls are made by opening the form. */
export async function reviewWorkspace(req: cds.Request) {
  const { source, review } = await workspaceContext(req);
  const proposals: Row[] = await SELECT.from(PROPOSAL).where({
    ...keyOf(source),
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceFingerprint,
  });
  const inputHash = predictionInputHash(review);
  const origins = parseOrigins(review.fieldOrigins);
  const editing = req.params[0]?.IsActiveEntity === false;
  const evidenceEntity = editing ? DRAFT_EVIDENCE : EVIDENCE;
  const evidenceKey = editing ? draftKey(source, review) : keyOf(source);
  const draftRows: Row[] = await SELECT.from(evidenceEntity).where(evidenceKey);
  const decisions: Row[] =
    req.params[0]?.IsActiveEntity === false
      ? await SELECT.from(DRAFT_DECISION).where(draftKey(source, review))
      : await SELECT.from(DECISION).where(keyOf(source));
  const expired = draftRows.filter(
    (row) =>
      row.status === "pending" &&
      row.deadlineAt &&
      new Date(row.deadlineAt).getTime() <= Date.now(),
  );
  for (const row of expired) {
    await UPDATE.entity(evidenceEntity)
      .set({
        status: "failed",
        reason: "pending_deadline_exceeded",
        completedAt: new Date().toISOString(),
      })
      .where({ ...evidenceKey, generation: row.generation, field: row.field });
    row.status = "failed";
    row.reason = "pending_deadline_exceeded";
  }
  const draftByField = new Map<string, Row>();
  for (const row of draftRows)
    if (
      !draftByField.has(row.field) ||
      Number(draftByField.get(row.field)!.generation) < Number(row.generation)
    )
      draftByField.set(row.field, row);
  const staleReasons = [
    review.sourceRevision !== source.sourceRevision &&
      "source_revision_changed",
    review.reviewedShortText !== source.text && "short_text_changed",
    review.reviewedPlant !== source.Plant && "plant_changed",
    review.reviewedPurchasingOrganization !== source.PurchasingOrganization &&
      "purchasing_organization_changed",
  ].filter(Boolean) as string[];
  const evidence: Row = {};
  for (const [field, property, state] of CODE_FIELDS) {
    const storedEvidence = draftByField.get(field);
    const fieldStaleReasons = storedEvidence
      ? ([
          storedEvidence.inputHash !== inputHash && "prediction_inputs_changed",
          storedEvidence.sourceRevision !== source.sourceRevision &&
            "source_revision_changed",
          storedEvidence.sourceFingerprint !== source.sourceFingerprint &&
            "source_changed",
        ].filter(Boolean) as string[])
      : staleReasons;
    const currentContext = !fieldStaleReasons.length;
    const draftEvidence = currentContext ? storedEvidence : undefined;
    const p = currentContext
      ? (draftEvidence ?? proposals.find((row) => row.field === field))
      : undefined;
    let raw: Row[] = [];
    try {
      raw = draftEvidence?.candidates
        ? JSON.parse(draftEvidence.candidates)
        : p?.alternatives
          ? JSON.parse(p.alternatives)
          : [];
    } catch {
      /* Malformed evidence is not selectable. */
    }
    const alternatives: Array<{ value: string; name: string; score: number }> =
      [];
    for (const candidate of Array.isArray(raw) ? raw : []) {
      if (
        typeof candidate.value !== "string" ||
        !Number.isFinite(candidate.probability) ||
        candidate.probability < 0 ||
        candidate.probability > 1 ||
        alternatives.some((a) => a.value === candidate.value) ||
        !(await allowed(
          field,
          candidate.value,
          validationContext(source, review),
        ))
      )
        continue;
      alternatives.push({
        value: candidate.value,
        name: await valueName(field, candidate.value),
        score: candidate.probability,
      });
    }
    const valid =
      filled(p?.value) &&
      (await allowed(field, p!.value, validationContext(source, review)));
    const score = valid ? (p!.modelScore ?? p!.confidence ?? null) : null;
    const selectedValue = decisionValue(field, review);
    const selectedAlternative = alternatives.find(
      (candidate) => candidate.value === selectedValue,
    );
    const threshold = p
      ? await SELECT.one
          .from(`${NS}.FreetextThreshold`)
          .where({ field, segment: p.segment })
      : null;
    const recordedOrigin = origins[property];
    const origin =
      recordedOrigin === "buyer_cleared"
        ? "missing"
        : recordedOrigin === "buyer_changed"
          ? "buyer"
          : ["tabpfn", "ai_applied"].includes(recordedOrigin)
            ? "ai"
            : filled(selectedValue)
              ? selectedValue === source[field]
                ? "source"
                : "buyer"
              : "missing";
    const reviewStatus =
      review[state] === "suggested"
        ? "not_reviewed"
        : ["confirmed"].includes(review[state])
          ? "confirmed"
          : ["corrected", "entered"].includes(review[state])
            ? "changed"
            : parseOrigins(review.fieldOrigins)[property] === "buyer_cleared"
              ? "cleared"
              : "not_reviewed";
    evidence[property] = {
      field,
      property,
      value: valid ? p!.value : null,
      name: valid ? await valueName(field, p!.value) : null,
      selectedName: filled(selectedValue)
        ? await valueName(field, selectedValue)
        : null,
      score,
      alternatives,
      generation: draftEvidence?.generation ?? null,
      inputHash: draftEvidence?.inputHash ?? inputHash,
      status: !currentContext
        ? "stale"
        : (draftEvidence?.status ??
          (valid
            ? "available"
            : source.enrichmentStatus === "pending"
              ? "pending"
              : source.enrichmentStatus === "failed" && p?.reason
                ? "failed"
                : "unavailable")),
      origin,
      selectedScore:
        valid && selectedValue === p!.value
          ? score
          : (selectedAlternative?.score ?? null),
      reviewed: ["confirmed", "corrected", "entered"].includes(review[state]),
      reason:
        field === "Material"
          ? "manual_material_selection"
          : (p?.reason ?? null),
      historicalReliability: p?.historicalReliability ?? null,
      modelVersion: p?.modelVersion ?? null,
      backend: p?.backend ?? null,
      computedAt: p?.computedAt ?? null,
      calibrationIdentity: p?.calibrationIdentity ?? null,
      runIdentity: p?.runIdentity ?? null,
      similarSame: p?.similarSame ?? null,
      isDemo: !!p?.isDemo,
      reviewStatus,
      applicable: await applicable(field, source),
      enabled: field !== "Material",
      decision:
        decisions.find(
          (decision) =>
            decision.field === field &&
            String(decision.value ?? "") === String(selectedValue ?? ""),
        ) ?? null,
      invalidation: fieldStaleReasons.length
        ? {
            state: "stale",
            reasons: fieldStaleReasons,
            recomputeAvailable:
              editing && review.sourceRevision === source.sourceRevision,
          }
        : null,
      recommendation: valid
        ? {
            value: p!.value,
            name: await valueName(field, p!.value),
            modelScore: score,
            prefill: {
              eligible: !filled(review[property]),
              applied: review[state] === "suggested",
              blockedReason: filled(review[property])
                ? "field_already_has_a_value"
                : null,
            },
          }
        : null,
      explanation: {
        summary: p?.similarSame
          ? "Suggested from supporting historical requests."
          : (p?.reason ?? null),
        supportingHistory: p?.similarSame
          ? { agreementText: p.similarSame }
          : null,
        reliability:
          p?.historicalReliability === null ||
          p?.historicalReliability === undefined
            ? null
            : {
                value: p.historicalReliability,
                evaluationScope: p.segment ?? null,
                sampleSize: threshold?.holdoutRows ?? null,
                threshold: threshold?.threshold ?? null,
              },
        calculation: p
          ? {
              backend: p.backend ?? null,
              modelVersion: p.modelVersion ?? null,
              computedAt: p.computedAt ?? null,
              sourceRevision: p.sourceRevision ?? null,
            }
          : null,
      },
    };
  }
  const assignments = await SELECT.from(
    req.params[0].IsActiveEntity === false
      ? "PurchasingDeskService.FreetextReviewAccountAssignments.drafts"
      : REVIEW_ASSIGNMENT,
  ).where(keyOf(source));
  return JSON.stringify({
    schemaVersion: 4,
    inputHash,
    draftUUID: review.DraftAdministrativeData_DraftUUID ?? null,
    modifiedAt: review.modifiedAt,
    evidence,
    origins: parseOrigins(review.fieldOrigins),
    demo: !!source.demo,
    source,
    allocationCount: assignments.length,
    accountCategory: review.reviewedAccountAssignmentCategory,
  });
}

const opaqueID = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const predictionValue = (
  field: string,
  value: unknown,
  name: string | null = null,
) =>
  value === BLANK_CATEGORY && CATEGORY_FIELDS.has(field)
    ? {
        kind: "blank",
        code: null,
        displayName:
          field === "AccountAssignmentCategory"
            ? "No account assignment"
            : "Standard item",
      }
    : filled(value)
      ? {
          kind: "code",
          code: String(value),
          displayName: name ?? String(value),
        }
      : { kind: "missing", code: null, displayName: null };

export async function reviewWorkspaceV5(req: cds.Request) {
  const workspace = JSON.parse(await reviewWorkspace(req));
  const { source, review } = await workspaceContext(req);
  const editing = req.params[0]?.IsActiveEntity === false;
  const editable =
    editing &&
    source.isOpen &&
    review.sourceRevision === source.sourceRevision &&
    ["needs_review", "source_changed"].includes(source.lifecycleStatus) &&
    !review.requiresSourceReconciliation;
  const fields = Object.values(workspace.evidence).map((raw) => {
    const evidence = raw as Row;
    const current = predictionValue(
      evidence.field,
      decisionValue(evidence.field, review),
      evidence.selectedName,
    );
    const id = opaqueID([
      keyOf(source),
      workspace.draftUUID,
      evidence.field,
      evidence.generation,
      evidence.inputHash,
      source.sourceRevision,
      source.sourceFingerprint,
    ]);
    const candidates = [...evidence.alternatives];
    if (
      evidence.value &&
      !candidates.some((candidate: Row) => candidate.value === evidence.value)
    )
      candidates.unshift({
        value: evidence.value,
        name: evidence.name,
        score: evidence.score,
      });
    const canPredict =
      source.isOpen &&
      review.sourceRevision === source.sourceRevision &&
      !review.requiresSourceReconciliation &&
      evidence.applicable &&
      evidence.enabled &&
      !(evidence.status === "pending" && evidence.generation !== null);
    const canApply =
      !!editable &&
      evidence.applicable &&
      evidence.enabled &&
      evidence.status === "available" &&
      evidence.generation !== null;
    return {
      field: evidence.field,
      property: evidence.property,
      current,
      origin: evidence.origin === "buyer" ? "manual" : evidence.origin,
      cleared: workspace.origins[evidence.property] === "buyer_cleared",
      reviewed: evidence.reviewed,
      capabilities: {
        canInspect: true,
        canPredict,
        canApply,
        canEditToApply:
          !editing &&
          source.isOpen &&
          review.sourceRevision === source.sourceRevision &&
          ["needs_review", "source_changed"].includes(source.lifecycleStatus) &&
          !review.requiresSourceReconciliation &&
          !review.reviewLocked &&
          evidence.applicable &&
          evidence.enabled &&
          evidence.status === "available" &&
          evidence.generation !== null,
        canConfirm:
          !!editable && current.kind !== "missing" && !evidence.reviewed,
        canRetry:
          canPredict &&
          ["failed", "stale", "canceled"].includes(evidence.status),
        reviewOnly: !canApply,
        reason:
          evidence.field === "Material"
            ? "manual_material_selection"
            : !evidence.applicable
              ? "fixed_source"
              : !canPredict && !editable
                ? "read_only"
                : evidence.reason,
      },
      evidence: {
        id,
        generation: evidence.generation,
        inputHash: evidence.inputHash,
        status: evidence.status,
        reason: evidence.reason,
        candidates: candidates.map((candidate: Row, index: number) => ({
          id: opaqueID([id, candidate.value]),
          rank: index + 1,
          value: predictionValue(
            evidence.field,
            candidate.value,
            candidate.name,
          ),
          modelScore: candidate.score,
        })),
        historicalReliability: evidence.historicalReliability,
        evaluationScope:
          evidence.explanation.reliability?.evaluationScope ?? null,
        sampleSize: evidence.explanation.reliability?.sampleSize ?? null,
        calibrationIdentity: evidence.calibrationIdentity,
        runIdentity: evidence.runIdentity,
        backend: evidence.backend,
        modelVersion: evidence.modelVersion,
        computedAt: evidence.computedAt,
        supportingHistory:
          evidence.explanation.supportingHistory?.agreementText ?? null,
        summary: evidence.explanation.summary,
        staleReasons: evidence.invalidation?.reasons ?? [],
      },
      decision: evidence.decision
        ? {
            evidenceGeneration: evidence.decision.evidenceGeneration,
            inputHash: evidence.decision.inputHash,
            appliedAt: evidence.decision.appliedAt,
            confirmedAt: evidence.decision.confirmedAt,
          }
        : null,
    };
  });
  return {
    schemaVersion: 5,
    ...(await allocationWorkspace(req, source, review)),
    identity: {
      draftUUID: workspace.draftUUID,
      modifiedAt: workspace.modifiedAt,
      inputHash: workspace.inputHash,
      sourceRevision: source.sourceRevision,
      sourceFingerprint: source.sourceFingerprint,
    },
    fields,
    allocationCount: workspace.allocationCount,
    accountCategory: workspace.accountCategory,
    demo: workspace.demo,
  };
}

async function checkedPredictionWorkspace(
  req: cds.Request,
  requireEditing = true,
) {
  const workspace = await reviewWorkspaceV5(req);
  const expected = req.data;
  if (
    (requireEditing && req.params[0]?.IsActiveEntity !== false) ||
    (req.params[0]?.IsActiveEntity === false && !expected.expectedDraftUUID) ||
    !expected.expectedModifiedAt ||
    !expected.expectedInputHash ||
    (expected.expectedDraftUUID ?? null) !==
      (workspace.identity.draftUUID ?? null) ||
    expected.expectedInputHash !== workspace.identity.inputHash ||
    !sameTimestamp(workspace.identity.modifiedAt, expected.expectedModifiedAt)
  )
    throw fail(409, "The editing draft changed; refresh before continuing");
  return workspace;
}

function checkedPredictionField(
  workspace: Awaited<ReturnType<typeof reviewWorkspaceV5>>,
  req: cds.Request,
) {
  const field = workspace.fields.find(
    (field) => field.field === req.data.field,
  );
  if (!field) throw fail(400, "Unsupported prediction field");
  if (
    !req.data.expectedValue ||
    req.data.expectedValue.kind !== field.current.kind ||
    (req.data.expectedValue.code ?? null) !== field.current.code
  )
    throw fail(409, "The working value changed; refresh before continuing");
  return field;
}

export async function predictDraftFieldsV5(req: cds.Request) {
  const workspace = await checkedPredictionWorkspace(req, false);
  if (!Array.isArray(req.data.selectedFields))
    throw fail(400, "selectedFields must be a typed array");
  const fields = requestedPredictionFields(req.data.selectedFields);
  if (
    fields.some(
      (name) =>
        !workspace.fields.find((field) => field.field === name)?.capabilities
          .canPredict,
    )
  )
    throw fail(409, "A selected field cannot be predicted in this draft");
  return JSON.parse(await predictDraftFields(req));
}

export async function applyDraftSuggestionV5(req: cds.Request) {
  const workspace = await checkedPredictionWorkspace(req);
  const field = checkedPredictionField(workspace, req);
  const candidate = field.evidence.candidates.find(
    (candidate: Row) => candidate.id === req.data.candidateID,
  );
  if (
    !field.capabilities.canApply ||
    field.evidence.id !== req.data.evidenceID ||
    !candidate
  )
    throw fail(409, "That suggestion is no longer selectable");
  const legacyData = {
    ...req.data,
    candidate:
      candidate.value.kind === "blank" ? BLANK_CATEGORY : candidate.value.code,
    evidenceGeneration: field.evidence.generation,
    expectedCurrentValue: field.current.code ?? "",
  };
  await applyDraftSuggestion({
    params: req.params,
    user: req.user,
    data: legacyData,
  } as cds.Request);
  return reviewWorkspaceV5(req);
}

export async function applyPredictionSelections(req: cds.Request) {
  return inTx(async () => {
    const workspace = await checkedPredictionWorkspace(req);
    const { source, review } = await workspaceContext(req);
    const selections = req.data.selections;
    if (!Array.isArray(selections) || !selections.length)
      throw fail(400, "Select at least one prediction to accept");
    const origins = parseOrigins(review.fieldOrigins);
    const patch: Row = { workingCopyVersion: 1 };
    const decisions: Row[] = [];
    const seen = new Set<string>();
    const acceptedAt = new Date().toISOString();
    for (const selection of selections) {
      if (!selection || seen.has(selection.field))
        throw fail(400, "Select each prediction field only once");
      seen.add(selection.field);
      const field = checkedPredictionField(workspace, {
        data: selection,
      } as cds.Request);
      const candidate = field.evidence.candidates.find(
        (candidate: Row) => candidate.id === selection.candidateID,
      );
      if (
        !field.capabilities.canApply ||
        field.evidence.id !== selection.evidenceID ||
        !candidate
      )
        throw fail(409, "A selected prediction is no longer current");
      const value =
        candidate.value.kind === "blank"
          ? BLANK_CATEGORY
          : candidate.value.code;
      if (typeof value !== "string")
        throw fail(409, "A selected prediction has no applicable value");
      patch[field.property] = decodeValue(field.field, value);
      patch[REVIEW_STATES[field.field]] = "confirmed";
      origins[field.property] = "ai_applied";
      decisions.push({
        ...draftKey(source, review),
        field: field.field,
        value,
        evidenceGeneration: field.evidence.generation,
        inputHash: field.evidence.inputHash,
        appliedAt: acceptedAt,
        confirmedAt: acceptedAt,
      });
    }
    patch.fieldOrigins = JSON.stringify(origins);
    const changed = await UPDATE.entity(draft())
      .set(patch)
      .where({
        ...draftKey(source, review),
        modifiedAt: review.modifiedAt,
      });
    if (Number(changed) !== 1)
      throw fail(409, "The editing draft changed before acceptance");
    await UPSERT.into(DRAFT_DECISION).entries(decisions);
    return reviewWorkspaceV5(req);
  });
}

export async function confirmDraftValueV5(req: cds.Request) {
  const workspace = await checkedPredictionWorkspace(req);
  const field = checkedPredictionField(workspace, req);
  if (!field.capabilities.canConfirm)
    throw fail(409, "This value cannot be confirmed in this draft");
  await confirmDraftValue({
    params: req.params,
    user: req.user,
    data: {
      field: field.field,
      expectedCurrentValue: field.current.code ?? "",
    },
  } as cds.Request);
  return reviewWorkspaceV5(req);
}

/** Apply current, valid suggestions to blank draft fields without confirming them. */
export async function applyProvisionalSuggestions(req: cds.Request) {
  const key = req.params[0] as Row;
  const { source, review } = await workspaceContext(req);
  if (!(await SELECT.one.from(draft()).where(keyOf(source))))
    throw fail(409, "Choose Edit before applying suggestions");
  if (
    review.sourceRevision !== source.sourceRevision ||
    review.reviewedPlant !== source.Plant ||
    review.reviewedPurchasingOrganization !== source.PurchasingOrganization
  )
    return reviewWorkspace(req);
  const proposals: Row[] = await SELECT.from(PROPOSAL).where({
    ...keyOf(source),
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceFingerprint,
  });
  const origins = parseOrigins(review.fieldOrigins);
  const patch: Row = {};
  for (const [field, property, state] of CODE_FIELDS) {
    const proposal = proposals.find((row) => row.field === field);
    if (
      FIELD_POLICIES[field].reviewOnly ||
      filled(review[property]) ||
      origins[property] ||
      proposal?.status !== "prefilled" ||
      !filled(proposal?.value) ||
      !(await allowed(field, proposal.value, source))
    )
      continue;
    patch[property] = proposal.value;
    patch[state] = "suggested";
    origins[property] = "tabpfn";
  }
  if (Object.keys(patch).length) {
    patch.fieldOrigins = JSON.stringify(origins);
    patch.workingCopyVersion = 1;
    await UPDATE.entity(draft()).set(patch).where(keyOf(source));
  }
  return reviewWorkspace(req);
}

/** A final explicit buyer gesture can accept unchanged current suggestions as a group. */
async function finalDecisions(source: Row, review: Row) {
  if (
    !source.isOpen ||
    !["needs_review", "source_changed"].includes(source.lifecycleStatus) ||
    review.sourceChanged ||
    review.sourceRevision !== source.sourceRevision
  )
    throw fail(409, "Review source changes before submitting this order draft");
  const proposals: Row[] = await SELECT.from(PROPOSAL).where({
    ...keyOf(source),
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceFingerprint,
  });
  const updates: Row = {};
  for (const [field, property, state] of CODE_FIELDS) {
    if (
      !filled(review[property]) ||
      ["confirmed", "corrected", "entered"].includes(review[state])
    )
      continue;
    const p = proposals.find((row) => row.field === field);
    const currentContext =
      review.reviewedPlant === source.Plant &&
      review.reviewedPurchasingOrganization === source.PurchasingOrganization;
    if (
      review[property] === source[field] ||
      (currentContext && review[property] === p?.value)
    ) {
      if (
        await allowed(
          field,
          review[property],
          validationContext(source, review),
        )
      )
        updates[state] = "confirmed";
    }
  }
  return updates;
}

export async function reviewOrder(req: ReviewCommandRequest) {
  const { source, review } = await workspaceContext(req, true);
  const decisions = await finalDecisions(source, review);
  // Build the exact approval payload without changing decisions or preparing an approval.
  const prepared = await reviewedAction(
    source,
    { ...review, ...decisions },
    req.user.id,
  );
  const payload = prepared.items[0].data!.payload as Row;
  delete payload.submittedAt;
  const changesFromRequest = completedFields(source, review).map(
    ([field, original, selected]) => ({
      field,
      source: original ?? null,
      selected: selected ?? null,
    }),
  );
  const sourceAssignments: Row[] = await SELECT.from(
    `${NS}.FreetextWorkItemAccountAssignment`,
  ).where(keyOf(source));
  for (const allocation of payload.accountAssignments) {
    const original = sourceAssignments.find(
      (row) =>
        row.PurchaseReqnAcctAssgmtNumber ===
        allocation.PurchaseReqnAcctAssgmtNumber,
    );
    for (const field of [
      "GLAccount",
      "CostCenter",
      "InternalOrder",
      "WBSElement",
      "MainAsset",
      "DistributionPercent",
    ])
      changesFromRequest.push({
        field,
        source: original?.[field] ?? null,
        selected: allocation[field] ?? null,
      });
  }
  return JSON.stringify({
    ...payload,
    changesFromRequest: changesFromRequest.filter(
      (change) => String(change.source ?? "") !== String(change.selected ?? ""),
    ),
    expectedModifiedAt: review.modifiedAt,
    expectedReviewToken: reviewToken(payload),
    accepts: Object.keys(decisions),
    pricingBasis: "requisition_valuation",
    outcome: "approved_draft_export",
  });
}

const reviewToken = (payload: Row) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        source: payload.source,
        completed: payload.completed,
        assignments: payload.accountAssignments,
        decisions: payload.decisions,
        origins: payload.fieldOrigins,
      }),
    )
    .digest("hex");

export async function submitReviewedOrder(req: ReviewCommandRequest) {
  const { source, review } = await workspaceContext(req, true);
  if (
    !req.data.expectedModifiedAt ||
    new Date(req.data.expectedModifiedAt).getTime() !==
      new Date(review.modifiedAt).getTime()
  )
    throw fail(
      409,
      "The working values changed after the order summary opened. Review them again.",
    );
  const decisions = await finalDecisions(source, review);
  const prepared = await reviewedAction(
    source,
    { ...review, ...decisions },
    req.user.id,
  );
  if (
    req.data.expectedReviewToken !==
    reviewToken(prepared.items[0].data!.payload)
  )
    throw fail(
      409,
      "Order details or account assignments changed. Review the summary again.",
    );
  await UPDATE.entity(REVIEW).set(decisions).where(keyOf(source));
  return submitReview(req);
}

/** Immutable, approval-gated handoff; this is preparation data, not an S/4 create request. */
export async function exportOrderDraft(req: cds.Request) {
  await workspaceContext(req, true);
  throw fail(
    410,
    "Order-draft export has been removed; inspect the approved instructions in TIDE",
  );
}

export async function guardReviewAssignment(req: cds.Request) {
  const key: Row = { ...(req.params?.[0] ?? {}), ...(req.data ?? {}) };
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  if (!source.isOpen || source.lifecycleStatus === "awaiting_approval")
    throw fail(409, "This requisition cannot be edited now");
  if (
    source.sourceRevision !==
    (await SELECT.one.from(REVIEW).where(keyOf(key)))?.sourceRevision
  )
    throw fail(
      409,
      "The source requisition changed; reconcile the review before editing",
    );
  const target = req.target?.name.endsWith(".drafts") ? draft() : REVIEW;
  const parent = await SELECT.one.from(target).where(keyOf(source));
  if (parent && target === draft()) await requireDraftOwner(parent, req.user);
  if (parent) await recordManualAllocationChange(req, source, parent);
  if (parent)
    await UPDATE.entity(target)
      .set({
        fieldOrigins: JSON.stringify({
          ...parseOrigins(parent.fieldOrigins),
          accountAssignments: "buyer_changed",
        }),
      })
      .where(keyOf(source));
}

export async function markReviewInProgress(req: cds.Request) {
  const key: Row = { ...(req.params?.[0] ?? {}), ...(req.data ?? {}) };
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (source?.isOpen) {
    await cancelSavedAllocationPredictions(source);
    await UPDATE.entity(EVIDENCE)
      .set({
        status: "canceled",
        reason: "draft_saved",
        completedAt: new Date().toISOString(),
      })
      .where({ ...keyOf(key), status: "pending" });
    const review = await SELECT.one.from(REVIEW).where(keyOf(source));
    if (review)
      await UPDATE.entity(REVIEW)
        .set(decisionState(source, review, "in_progress"))
        .where(keyOf(source));
    await setTypedReviewStatus(source, "in_progress");
  }
}

export async function guardReviewRead(req: cds.Request) {
  const key = req.params?.[0] as Row | undefined;
  if (!key?.PurchaseRequisition || !key?.PurchaseRequisitionItem) return;
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  const review = await SELECT.one.from(REVIEW).where(keyOf(source));
  if (review) await repairWorkingCopy(source, review);
}

export async function guardWorkRead(req: cds.Request) {
  const key = req.params?.[0] as Row | undefined;
  if (!key?.PurchaseRequisition || !key?.PurchaseRequisitionItem) return;
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
}

export async function guardProposalRead(req: cds.Request) {
  const key = req.params?.[0] as Row | undefined;
  if (!key?.PurchaseRequisition || !key?.PurchaseRequisitionItem) {
    if (!scopeOf(req.user).isAdmin)
      throw fail(
        403,
        "Proposal evidence must be read through a routed requisition review",
      );
    return;
  }
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
}

export async function guardDraftAssistanceRead(req: cds.Request) {
  const key = req.params?.[0] as Row | undefined;
  if (!key?.PurchaseRequisition || !key?.PurchaseRequisitionItem) {
    if (!scopeOf(req.user).isAdmin)
      throw fail(
        403,
        "Draft assistance is available only through its routed requisition review",
      );
    return;
  }
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
}

/** Kept as an internal compatibility export while the OData action uses the clearer name. */
export const confirmSuggestions = confirmCurrentValues;

async function allowed(field: string, value: string, source: Row) {
  if (field === "MaterialGroup") {
    const found = await SELECT.one
      .from("tide.s4.ProductGroupText")
      .where({ ProductGroup: value });
    const historical = await SELECT.one
      .from(`${NS}.FreetextItem`)
      .where({ MaterialGroup: value });
    return !!(found || historical);
  }
  if (field === "PurchasingGroup") {
    const master = await SELECT.one
      .from("tide.s4.PurchasingGroup")
      .where({ PurchasingGroup: value });
    return !!master;
  }
  if (field === "AccountAssignmentCategory")
    return value === BLANK_CATEGORY || /^[AEFKNPQ]$/.test(value);
  if (field === "PurchasingDocumentItemCategory")
    return value === BLANK_CATEGORY || /^[0-9A-Z]$/.test(value);
  if (field === "Material") {
    const product = await SELECT.one
      .from("tide.s4.Product")
      .where({ Product: value });
    if (!product || product.IsMarkedForDeletion || !filled(source.Plant))
      return false;
    const plant = await SELECT.one
      .from("tide.s4.ProductPlant")
      .where({ Product: value, Plant: source.Plant });
    return !!plant && !plant.IsMarkedForDeletion;
  }
  if (field === "PurchasingInfoRecord") {
    const master = await SELECT.one
      .from("tide.s4.PurchasingInfoRecord")
      .where({ PurchasingInfoRecord: value });
    if (!master || master.IsDeleted || !filled(source.PurchasingOrganization))
      return false;
    if (filled(source.Material) && master.Material !== source.Material)
      return false;
    if (filled(source.Supplier) && master.Supplier !== source.Supplier)
      return false;
    if (
      filled(master.Supplier) &&
      !(await allowed("Supplier", master.Supplier, source))
    )
      return false;
    const scopes: Row[] = await SELECT.from(
      "tide.s4.PurgInfoRecdOrgPlantData",
    ).where({
      PurchasingInfoRecord: value,
      PurchasingOrganization: source.PurchasingOrganization,
    });
    return scopes.some(
      (scope) =>
        !scope.IsMarkedForDeletion &&
        (scope.Plant === "" || scope.Plant === source.Plant) &&
        (!filled(source.Material) ||
          !filled(scope.Material) ||
          scope.Material === source.Material) &&
        (!filled(source.Supplier) ||
          !filled(scope.Supplier) ||
          scope.Supplier === source.Supplier),
    );
  }
  if (field !== "Supplier") return false;
  const master = await SELECT.one
    .from("tide.s4.Supplier")
    .where({ Supplier: value });
  return !!master && !master.PurchasingIsBlocked && !master.DeletionIndicator;
}

function fields(source: Row, review: Row) {
  return FIELDS.map((name) => ({
    name,
    value: review[FIELD_POLICIES[name].property],
    original: source[name],
    state: review[FIELD_POLICIES[name].state],
  }));
}

function completedFields(source: Row, review: Row) {
  return [
    ["ShortDescription", source.text, review.reviewedShortText],
    ["LongText", source.itemLongText, review.reviewedLongText],
    ["HeaderNote", source.headerNote, review.reviewedHeaderNote],
    ["PRType", source.PurchaseRequisitionType, review.reviewedPrType],
    [
      "ItemCategory",
      source.PurchasingDocumentItemCategory,
      review.reviewedItemCategory,
    ],
    ["Material", source.Material, review.reviewedMaterial],
    ["Quantity", source.RequestedQuantity, review.reviewedQuantity],
    ["Unit", source.BaseUnit, review.reviewedUnit],
    ["RequiredDate", source.DeliveryDate, review.reviewedDeliveryDate],
    ["Plant", source.Plant, review.reviewedPlant],
    ["StorageLocation", source.StorageLocation, review.reviewedStorageLocation],
    ["CompanyCode", source.CompanyCode, review.reviewedCompanyCode],
    [
      "PurchasingOrganization",
      source.PurchasingOrganization,
      review.reviewedPurchasingOrganization,
    ],
    [
      "AccountAssignmentCategory",
      source.AccountAssignmentCategory,
      review.reviewedAccountAssignmentCategory,
    ],
    ["MaterialGroup", source.MaterialGroup, review.MaterialGroup],
    ["PurchasingGroup", source.PurchasingGroup, review.reviewedPurchasingGroup],
    ["Supplier", source.Supplier, review.Supplier],
    [
      "PurchasingInfoRecord",
      source.PurchasingInfoRecord,
      review.reviewedPurchasingInfoRecord,
    ],
    [
      "OutlineAgreement",
      source.OutlineAgreement,
      review.reviewedOutlineAgreement,
    ],
    [
      "OutlineAgreementItem",
      source.OutlineAgreementItem,
      review.reviewedOutlineAgreementItem,
    ],
    [
      "ValuationPrice",
      source.PurchaseRequisitionPrice,
      review.reviewedValuationPrice,
    ],
    [
      "PriceQuantity",
      source.PurReqnPriceQuantity,
      review.reviewedPriceQuantity,
    ],
    ["Currency", source.PurReqnItemCurrency, review.reviewedCurrency],
    ["TaxCode", source.TaxCode, review.reviewedTaxCode],
    [
      "ReceiptExpected",
      source.GoodsReceiptIsExpected,
      review.reviewedReceiptExpected,
    ],
    [
      "InvoiceBasedOnReceipt",
      source.InvoiceIsGoodsReceiptBased,
      review.reviewedInvoiceBasedOnReceipt,
    ],
    [
      "ServicePerformer",
      source.ServicePerformer,
      review.reviewedServicePerformer,
    ],
    [
      "PerformancePeriodStart",
      source.PerformancePeriodStartDate,
      review.reviewedPerformancePeriodStartDate,
    ],
    [
      "PerformancePeriodEnd",
      source.PerformancePeriodEndDate,
      review.reviewedPerformancePeriodEndDate,
    ],
    [
      "ExpectedOverallLimit",
      source.ExpectedOverallLimitAmount,
      review.reviewedExpectedOverallLimitAmount,
    ],
    [
      "OverallLimit",
      source.OverallLimitAmount,
      review.reviewedOverallLimitAmount,
    ],
    [
      "DeliveryAddressName",
      source.DeliveryAddressName,
      review.reviewedDeliveryAddressName,
    ],
    [
      "DeliveryAddressStreet",
      source.DeliveryAddressStreet,
      review.reviewedDeliveryAddressStreet,
    ],
    [
      "DeliveryAddressCity",
      source.DeliveryAddressCity,
      review.reviewedDeliveryAddressCity,
    ],
    [
      "DeliveryAddressPostalCode",
      source.DeliveryAddressPostalCode,
      review.reviewedDeliveryAddressPostalCode,
    ],
    [
      "DeliveryAddressCountry",
      source.DeliveryAddressCountry,
      review.reviewedDeliveryAddressCountry,
    ],
    ["UnloadingPoint", source.UnloadingPoint, review.reviewedUnloadingPoint],
  ] as [string, unknown, unknown][];
}

async function validateCompletedReview(source: Row, review: Row) {
  await validateAllocationDecisions(source, review);
  for (const [name, property] of [
    ["Short description", "reviewedShortText"],
    ["Quantity", "reviewedQuantity"],
    ["Unit", "reviewedUnit"],
    ["Required date", "reviewedDeliveryDate"],
    ["Plant", "reviewedPlant"],
    ["Purchasing organisation", "reviewedPurchasingOrganization"],
  ])
    if (!filled(review[property]))
      throw fail(400, `${name} is required`, { target: property });
  if (!(Number(review.reviewedQuantity) > 0))
    throw fail(400, "Quantity must be greater than zero", {
      target: "reviewedQuantity",
    });
  if (
    filled(review.reviewedPriceQuantity) &&
    !(Number(review.reviewedPriceQuantity) > 0)
  )
    throw fail(400, "Price unit must be greater than zero", {
      target: "reviewedPriceQuantity",
    });
  if (
    filled(review.reviewedValuationPrice) &&
    !(Number(review.reviewedValuationPrice) >= 0)
  )
    throw fail(400, "Valuation price must not be negative", {
      target: "reviewedValuationPrice",
    });
  if (
    review.reviewedPerformancePeriodStartDate &&
    review.reviewedPerformancePeriodEndDate &&
    review.reviewedPerformancePeriodStartDate >
      review.reviewedPerformancePeriodEndDate
  )
    throw fail(
      400,
      "Performance period end date must not precede its start date",
    );
  if (filled(review.reviewedAccountAssignmentCategory)) {
    const assignments: Row[] = await SELECT.from(REVIEW_ASSIGNMENT).where(
      keyOf(source),
    );
    if (!assignments.length)
      throw fail(400, "Account assignment is required for this item category");
    const allocated = assignments.reduce(
      (sum: number, a: Row) => sum + Number(a.DistributionPercent ?? 0),
      0,
    );
    if (
      assignments.some(
        (a: Row) =>
          a.DistributionPercent !== null && a.DistributionPercent !== undefined,
      ) &&
      Math.abs(allocated - 100) > 0.01
    )
      throw fail(400, "Account assignment percentages must total 100");
    for (const a of assignments) {
      if (!filled(a.GLAccount))
        throw fail(400, "Account assignment needs a G/L account");
      if (
        review.reviewedAccountAssignmentCategory === "K" &&
        !filled(a.CostCenter)
      )
        throw fail(400, "Cost center is required for account assignment K");
      if (
        review.reviewedAccountAssignmentCategory === "E" &&
        (!filled(a.SalesOrder) || !filled(a.SalesOrderItem))
      )
        throw fail(
          400,
          "Sales order and item are required for account assignment E",
        );
      if (
        review.reviewedAccountAssignmentCategory === "A" &&
        !filled(a.MainAsset)
      )
        throw fail(400, "Main asset is required for account assignment A");
      if (
        review.reviewedAccountAssignmentCategory === "F" &&
        !filled(a.InternalOrder)
      )
        throw fail(400, "Internal order is required for account assignment F");
      if (
        review.reviewedAccountAssignmentCategory === "P" &&
        !filled(a.WBSElement)
      )
        throw fail(400, "WBS element is required for account assignment P");
    }
  }
}

export async function validateReview(req: cds.Request) {
  const key = keyOf(req.params[0] as Row);
  const source = await SELECT.one.from(WORK).where(key);
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  if (await SELECT.one.from(draft()).where(key))
    throw fail(409, "Save or discard the editing draft before validating");
  const review = await SELECT.one.from(REVIEW).where(key);
  if (!review) throw fail(404, "Review not found");
  await validateCompletedReview(source, review);
  for (const f of fields(source, review)) {
    const required =
      CATEGORY_FIELDS.has(f.name) || FIELD_POLICIES[f.name].optional
        ? filled(f.value)
        : f.name !== "Supplier" ||
          source.SourceOfSupplyIsAssigned ||
          filled(source.FixedSupplier);
    if (
      required &&
      (!filled(f.value) ||
        !["confirmed", "corrected", "entered"].includes(f.state))
    )
      throw fail(
        400,
        `${f.name} requires an explicit buyer decision before submission`,
      );
  }
  return SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews")
    .where(key);
}

/** Shared by OData and finding action builder; never treats a prediction as a decision. */
export async function reviewedAction(source: Row, review: Row, buyer: string) {
  if (!source.isOpen || source.lifecycleStatus === "completed")
    throw fail(409, "This requisition is already closed at the source");
  if (review.sourceRevision !== source.sourceRevision)
    throw fail(
      409,
      "The source requisition changed while this review was being edited. Reload and reconcile before submitting.",
    );
  await validateCompletedReview(source, review);
  const changes: Array<{
    name: string;
    value: unknown;
    original: unknown;
    state: string;
  }> = [];
  for (const f of fields(source, review)) {
    const required =
      CATEGORY_FIELDS.has(f.name) || FIELD_POLICIES[f.name].optional
        ? filled(f.value)
        : f.name !== "Supplier" ||
          source.SourceOfSupplyIsAssigned ||
          filled(source.FixedSupplier);
    if (
      required &&
      (!filled(f.value) ||
        !["confirmed", "corrected", "entered"].includes(f.state))
    )
      throw fail(
        400,
        `${f.name} requires an explicit buyer decision before submission`,
      );
    if (
      !required &&
      !filled(f.value) &&
      f.state !== "not_applicable" &&
      filled(f.original)
    )
      throw fail(
        400,
        `${f.name} requires an explicit buyer decision before submission`,
      );
    if (
      filled(f.value) &&
      !["confirmed", "corrected", "entered"].includes(f.state)
    )
      throw fail(
        400,
        `${f.name} is only suggested; confirm or correct it before submitting`,
      );
    if (
      filled(f.value) &&
      !(await allowed(f.name, f.value, validationContext(source, review)))
    )
      throw fail(400, `${f.name} ${f.value} is not a valid code in this scope`);
    changes.push(f);
  }
  const proposals = await SELECT.from(PROPOSAL).where({
    ...keyOf(source),
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceFingerprint,
  });
  const assistanceDecisions = await SELECT.from(DECISION).where(keyOf(source));
  const problemKey = `requisition:${itemKey(source as StoredItem)}`;
  const assignments = await SELECT.from(REVIEW_ASSIGNMENT).where(keyOf(source));
  const payload = {
    source: {
      PurchaseRequisition: source.PurchaseRequisition,
      PurchaseRequisitionItem: source.PurchaseRequisitionItem,
      revision: source.sourceRevision,
    },
    completed: Object.fromEntries(
      completedFields(source, review).map(([name, , value]) => [
        name,
        value ?? null,
      ]),
    ),
    fieldOrigins: parseOrigins(review.fieldOrigins),
    accountAssignments: assignments,
    decisions: changes.map((f) => ({
      field: f.name,
      source: f.original ?? null,
      selected: f.value ?? null,
      state: f.state,
      assistance:
        assistanceDecisions.find(
          (decision: Row) => decision.field === f.name,
        ) ?? null,
    })),
    buyer,
    submittedAt: new Date().toISOString(),
  };
  return {
    kind: "pr_review" as const,
    objectKey: itemKey(source as StoredItem),
    problemKey,
    operationKey: "requisition_review" as const,
    exportFormat: "csv" as const,
    via: currentWorkflowOrigin(),
    findingID: source.findingID,
    cases: [
      {
        ID: caseID(source),
        operation: "requisition_review" as const,
        role: "primary" as const,
      },
    ],
    title: `Reviewed requisition ${itemKey(source as StoredItem)}`,
    summary: review.buyerNote ?? source.text,
    items: [
      ...completedFields(source, review),
      ...changes.map(
        (f) => [f.name, f.original, f.value] as [string, unknown, unknown],
      ),
    ].map(([field, oldValue, newValue]) => {
      const f = changes.find((change) => change.name === field);
      const p = f && proposals.find((x: Row) => x.field === f.name);
      let candidateScore: number | null =
        f?.value === p?.value ? (p?.modelScore ?? p?.confidence ?? null) : null;
      if (p && candidateScore === null) {
        try {
          candidateScore =
            JSON.parse(p.alternatives ?? "[]").find(
              (candidate: Row) => candidate.value === newValue,
            )?.probability ?? null;
        } catch {
          /* Ignore malformed legacy evidence. */
        }
      }
      return {
        objectKey: itemKey(source as StoredItem),
        problemKey,
        operationKey: "requisition_review" as const,
        findingID: source.findingID,
        field,
        oldValue:
          oldValue === null || oldValue === undefined ? null : String(oldValue),
        newValue:
          newValue === null || newValue === undefined ? null : String(newValue),
        text: `${field}: ${oldValue || "(missing)"} → ${newValue ?? "(empty)"}${f ? ` (${f.state} by ${buyer})` : ""}`,
        data: {
          PurchaseRequisition: source.PurchaseRequisition,
          PurchaseRequisitionItem: source.PurchaseRequisitionItem,
          reviewState: f?.state ?? "completed",
          changed: String(newValue ?? "") !== String(oldValue ?? ""),
          sourceRevision: source.sourceRevision,
          sourceFingerprint: source.sourceFingerprint,
          proposalValue: p?.value ?? null,
          proposalRevision: p?.sourceRevision ?? null,
          confidence: candidateScore,
          proposalSource: candidateScore !== null ? p?.source : null,
          buyer,
          reviewedAt: payload.submittedAt,
          payload,
        },
      };
    }),
  };
}

export async function submitReview(req: ReviewCommandRequest) {
  return inTx(() => submitReviewCommand(req));
}

async function submitReviewCommand(
  req: ReviewCommandRequest,
  via: ActionVia = "app",
) {
  const key = req.params[0] as Row;
  if (key.IsActiveEntity === false)
    throw fail(409, "Save the draft before submitting for approval");
  const source = await SELECT.one.from(WORK).where(keyOf(key));
  if (!source) throw fail(404, "Purchase requisition not found");
  requireBuyer(req, source);
  const existing = await activeCaseAction(caseID(source), "requisition_review");
  if (existing) return readAction(existing.ID);
  if (await SELECT.one.from(draft()).where(keyOf(source)))
    throw fail(
      409,
      "Save or discard the editing draft before submitting for approval",
    );
  const review = await SELECT.one.from(REVIEW).where(keyOf(source));
  if (!review) throw fail(404, "Review not found");
  const input = await reviewedAction(source, review, req.user.id);
  const changed = await UPDATE.entity(REVIEW)
    .set({ buyerNote: review.buyerNote })
    .where({
      ...keyOf(source),
      modifiedAt: review.modifiedAt,
      sourceRevision: review.sourceRevision,
    });
  if (Number(changed) !== 1)
    throw fail(409, "Review changed concurrently; reload before submitting");
  const action = await reuse409(() => prepareAction({ ...input, via }));
  if (await SELECT.one.from(SUBMISSION).where({ action_ID: action.ID }))
    return action;
  const actionItems = await SELECT.from(`${NS}.ActionItems`)
    .where({ action_ID: action.ID })
    .orderBy("line");
  const submissionID = cds.utils.uuid();
  await INSERT.into(SUBMISSION).entries({
    ID: submissionID,
    ...keyOf(source),
    sourceRevision: source.sourceRevision,
    submittedBy: req.user.id,
    submittedAt: new Date().toISOString(),
    action_ID: action.ID,
    payload: actionItems[0]?.data
      ? JSON.stringify(JSON.parse(actionItems[0].data).payload)
      : "{}",
  });
  const updated = await UPDATE.entity(WORK)
    .set({ ...lifecycle("awaiting_approval"), actionID: action.ID })
    .where({
      ...keyOf(source),
      sourceRevision: source.sourceRevision,
      sourceFingerprint: source.sourceFingerprint,
    });
  if (Number(updated) !== 1)
    throw fail(409, "Source changed concurrently; reload before submitting");
  await UPDATE.entity(REVIEW)
    .set({
      ...lifecycle("awaiting_approval"),
      actionID: action.ID,
      ...decisionState(source, review, "awaiting_approval"),
    })
    .where(keyOf(source));
  await setTypedReviewStatus(source, "submitted");
  await INSERT.into("tide.workflow.ReviewEvents").entries({
    ID: cds.utils.uuid(),
    ...keyOf(source),
    submissionID,
    command_ID: currentWorkflowCommand() ?? null,
    occurredAt: new Date().toISOString(),
    event: "submitted",
    fromStage: review.lifecycleStatus,
    toStage: "awaiting_approval",
    actor: req.user.id,
    sourceRevision: source.sourceRevision,
  });
  return action;
}

async function requisitionReviewContext(
  caseID: string,
  user: cds.User,
  data: Row,
): Promise<ReviewCommandRequest> {
  const typed = await SELECT.one
    .from(`${NS}.RequisitionReviews`)
    .where({ header_ID: caseID });
  if (!typed) throw fail(404, "Review not found");
  return {
    params: [{ ...keyOf(typed), IsActiveEntity: true }],
    user,
    data,
  };
}

export async function reviewRequisitionOrder(caseID: string, user: cds.User) {
  return reviewOrder(await requisitionReviewContext(caseID, user, {}));
}

export async function submitRequisitionReview(
  caseID: string,
  user: cds.User,
  data: Row,
) {
  return submitReviewedOrder(
    await requisitionReviewContext(caseID, user, data),
  );
}

/** Typed roots adapt identity only; validation, drafts and immutable submissions have one owner. */
export async function requisitionCaseRequest(
  caseID: string,
  user: cds.User,
  data: Row = {},
) {
  const typed = await SELECT.one
    .from(`${NS}.RequisitionReviews`)
    .where({ header_ID: caseID });
  if (!typed) throw fail(404, "Review not found");
  return {
    params: [{ ...keyOf(typed), IsActiveEntity: true }],
    user,
    data,
  } as unknown as cds.Request;
}

export async function prepareRequisitionCase(
  caseID: string,
  via: ActionVia,
  user: cds.User,
) {
  return inTx(async () =>
    submitReviewCommand(await requisitionCaseRequest(caseID, user), via),
  );
}

export async function typedReviewCommand(
  req: cds.Request,
  command: "submit" | "reconcile",
) {
  return inTx(async () => {
    const key = req.params[0] as Row;
    const ID = String(
      typeof key === "object" ? (key.header_ID ?? key.ID) : key,
    );
    const adapted = await requisitionCaseRequest(ID, req.user, req.data);
    if (command === "submit") await submitReview(adapted);
    else await reconcileReview(adapted);
    return SELECT.one
      .from("PurchasingDeskService.RequisitionReviews")
      .where({ header_ID: ID });
  });
}

export async function reconcileAction(
  ID: string,
  status: string,
  resolution?: string,
) {
  const source = await SELECT.one.from(WORK).where({ actionID: ID });
  if (!source) return;
  const next = !source.isOpen
    ? "completed"
    : status === "declined"
      ? "needs_review"
      : status === "waiting"
        ? "approved"
        : "awaiting_source_confirmation";
  await UPDATE.entity(WORK).set(lifecycle(next)).where(keyOf(source));
  const review = await SELECT.one.from(REVIEW).where(keyOf(source));
  await UPDATE.entity(REVIEW)
    .set({ ...lifecycle(next), ...decisionState(source, review, next) })
    .where(keyOf(source));
  await setTypedReviewStatus(
    source,
    status === "declined" ? "new" : next === "completed" ? "done" : "submitted",
  );
  const submission = await SELECT.one.from(SUBMISSION).where({ action_ID: ID });
  if (review?.lifecycleStatus !== next)
    await INSERT.into("tide.workflow.ReviewEvents").entries({
      ID: cds.utils.uuid(),
      ...keyOf(source),
      submissionID: submission?.ID ?? null,
      command_ID: currentWorkflowCommand() ?? null,
      occurredAt: new Date().toISOString(),
      event: `action_${status}`,
      fromStage: review?.lifecycleStatus ?? null,
      toStage: next,
      actor: cds.context?.user?.id ?? "source_sync",
      sourceRevision: source.sourceRevision,
      reason: resolution ?? null,
    });
  if (next === "completed")
    await resolveFromSource(
      caseID(source),
      "The requisition review completed from its linked action.",
    );
}
