import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import {
  decide as kernelDecide,
  logOutcome as kernelLogOutcome,
} from "../srv/cockpit/kernel/action-state";
import { asWorkflowCommand } from "./fixtures/workflow";
import {
  applyDraftSuggestion,
  applyPredictionSelections,
  applyProvisionalSuggestions,
  confirmDraftValue,
  ensureMissingReviews as ensureMissingReviewsRaw,
  predictionInputHash,
  reviewedAction,
  submitReview,
  syncWorkItems as syncWorkItemsRaw,
  closeMissingWorkItems as closeMissingWorkItemsRaw,
  reconcileReview,
  guardReview,
  markEnrichment,
  confirmSuggestions,
  reviewWorkspace,
  reviewOrder,
  requestWorkflowSummary,
  submitReviewedOrder,
  exportOrderDraft,
} from "../srv/cockpit/freetext/review";
import type { StoredItem } from "../srv/cockpit/freetext/data";
import {
  buildItems,
  readItems,
  seedDemo,
  upsertItems,
  writeItems,
  requestFeatures,
} from "../srv/cockpit/freetext/data";

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
// Workflow commands require a trusted caller; source sync runs as the system.
const asSystem = <T>(fn: () => Promise<T>) =>
  cds.tx({ user: new cds.User.Privileged() } as any, fn);
const syncWorkItems = (items: StoredItem[]) =>
  asSystem(() => syncWorkItemsRaw(items));
const closeMissingWorkItems = (
  ...a: Parameters<typeof closeMissingWorkItemsRaw>
) => asSystem(() => closeMissingWorkItemsRaw(...a));
const ensureMissingReviews = (
  ...a: Parameters<typeof ensureMissingReviewsRaw>
) => asSystem(() => ensureMissingReviewsRaw(...a));
const decide = (...args: Parameters<typeof kernelDecide>) =>
  asWorkflowCommand(() => kernelDecide(...args));
const logOutcome = (...args: Parameters<typeof kernelLogOutcome>) =>
  asWorkflowCommand(() => kernelLogOutcome(...args));
// Source reconciliation records system commands; these counts cover buyer commands.
const buyerCommands = () =>
  SELECT.from("tide.workflow.WorkflowCommands")
    .where`principal != 'privileged'`;
import { allocationInputHash } from "../srv/cockpit/freetext/allocation";

test("allocation identity detects row edits and ignores row order and audit metadata", () => {
  const review = {
    reviewedCompanyCode: "1000",
    reviewedAccountAssignmentCategory: "K",
  };
  const rows = [
    {
      PurchaseReqnAcctAssgmtNumber: "01",
      GLAccount: "400000",
      CostCenter: "C1",
    },
    {
      PurchaseReqnAcctAssgmtNumber: "02",
      GLAccount: "500000",
      CostCenter: "C2",
    },
  ];
  assert.equal(
    allocationInputHash(review, rows),
    allocationInputHash(review, [...rows].reverse()),
  );
  assert.equal(
    allocationInputHash(review, rows),
    allocationInputHash(
      review,
      rows.map((row) => ({ ...row, modifiedAt: "later" })),
    ),
  );
  assert.notEqual(
    allocationInputHash(review, rows),
    allocationInputHash(review, [{ ...rows[0], CostCenter: "C3" }, rows[1]]),
  );
});
const NS = "tide.cockpit";
const app = cds.test(path.join(__dirname, ".."));
const key = {
  PurchaseRequisition: "1000000001",
  PurchaseRequisitionItem: "00010",
};
const source = (over: Partial<StoredItem> = {}): StoredItem => ({
  ...key,
  id: "1000000001/00010",
  text: "Replacement bearing",
  date: "2026-10-01",
  Plant: "AT21",
  PurchasingOrganization: "1000",
  PurchaseOrderType: "FO",
  DeliveryDate: "2026-11-01",
  RequestedQuantity: 5,
  BaseUnit: "EA",
  RequisitionerName: "Morgan Lee",
  sourcePurchasingGroup: null,
  isOpen: true,
  accountAssignments: [],
  ...over,
});

before(async () => {
  await app;
});
beforeEach(async () => {
  await DELETE.from("tide.workflow.ReviewEvents");
  await DELETE.from("tide.workflow.WorkflowCommands");
  await DELETE.from("tide.workflow.OutcomeObservations");
  await DELETE.from("PurchasingDeskService.PurchaseRequisitionReviews.drafts");
  await DELETE.from("PurchasingDeskService.FreetextDraftEvidences.drafts");
  await DELETE.from("PurchasingDeskService.FreetextDraftDecisions.drafts");
  await DELETE.from(`${NS}.FreetextSubmission`);
  await DELETE.from(`${NS}.FreetextReviewAccountAssignment`);
  for (const name of [
    "RequisitionReviews",
    "ActionEvents",
    "OperationLocks",
    "CaseActions",
    "CaseEvents",
    "Cases",
    "FreetextReview",
    "FreetextWorkItem",
    "FreetextProposal",
    "FreetextDraftEvidence",
    "FreetextDraftDecision",
    "ApprovalLock",
    "ApprovalEvent",
    "ProblemEvent",
    "FindingEvidence",
    "ActionItems",
    "Actions",
    "Problem",
    "FreetextItem",
  ])
    await DELETE.from(`${NS}.${name}`);
  for (const name of [
    "PurchasingGroup",
    "ProductGroupText",
    "Supplier",
    "Product",
    "ProductPlant",
    "ProductDescription",
    "PurchasingInfoRecord",
    "PurgInfoRecdOrgPlantData",
    "PurchaseReqnItem",
    "PurchaseOrder",
    "PurchaseOrderItem",
  ])
    await DELETE.from(`tide.s4.${name}`);
});

test("arrival creates durable source and separate review; refresh preserves buyer work", async () => {
  await syncWorkItems([source()]);
  const first = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  assert.equal(first.RequisitionerName, "Morgan Lee");
  assert.equal(first.RequestedQuantity, 5);
  assert.equal(first.sourceRevision, 1);
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ MaterialGroup: "MG01", materialGroupState: "corrected" })
    .where(key);
  await syncWorkItems([source({ text: "Replacement bearing, urgent" })]);
  const next = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(next.sourceRevision, 2);
  assert.equal(review.MaterialGroup, "MG01");
  assert.equal(review.sourceRevision, 1);
  const typedReview = await SELECT.one
    .from(`${NS}.RequisitionReviews`)
    .where({ header_ID: `requisition:${source().id}` });
  assert.equal(typedReview.reviewStatus, "new");
  assert.equal(typedReview.RequisitionerName, "Morgan Lee");
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: `requisition:${source().id}` })
    ).attention,
    "source_changed",
  );
  await assert.rejects(
    reviewedAction(next, review, "ilyesse.hettenbach@cbs-consulting.de"),
    (e: any) => e.status === 409,
  );
});

test("a missing requisition unlists work without confirming source fulfillment", async () => {
  await syncWorkItems([source()]);
  const ID = `requisition:${source().id}`;
  const before = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  await closeMissingWorkItems(new Set());
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID });
  assert.equal(header.status, "open");
  assert.equal(header.listing, "unlisted");
  assert.equal(header.closure, null);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)).isOpen,
    true,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).lifecycleStatus,
    before.lifecycleStatus,
  );
  await syncWorkItems([source()]);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID })).listing,
    "listed",
  );
});

test("new target labels use final PO values before the cutoff without replacing PR source values", async () => {
  await INSERT.into("tide.s4.PurchaseReqnItem").entries({
    ...key,
    PurchaseRequisitionItemText: "Replacement bearing",
    Material: "",
    PurchasingInfoRecord: "ORIGINAL",
    PurReqCreationDate: "2026-09-01",
    PurchasingDocument: "4500000001",
    PurchasingDocumentItem: "00010",
    Plant: "AT21",
    PurchasingOrganization: "1000",
  });
  await INSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder: "4500000001",
    PurchaseOrderDate: "2026-10-01",
    PurchaseOrderType: "NB",
  });
  const material = "M".repeat(40);
  await INSERT.into("tide.s4.PurchaseOrderItem").entries({
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "00010",
    Material: material,
    PurchasingInfoRecord: "FINAL",
  });
  const [historical] = await buildItems("2026-10-02", [key]);
  assert.equal(historical.Material, material);
  assert.equal(historical.PurchasingInfoRecord, "FINAL");
  assert.equal(historical.sourceMaterial, "");
  assert.equal(historical.sourcePurchasingInfoRecord, "ORIGINAL");
  await upsertItems([historical]);
  const [stored] = await readItems();
  assert.equal(stored.Material, material);
  assert.equal(stored.sourcePurchasingInfoRecord, "ORIGINAL");
  await syncWorkItems([historical]);
  const snapshot = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  assert.equal(snapshot.Material, "");
  assert.equal(snapshot.PurchasingInfoRecord, "ORIGINAL");
  const [beforeOutcome] = await buildItems("2026-10-01", [key]);
  assert.equal(beforeOutcome.Material, null);
  assert.equal(beforeOutcome.PurchasingInfoRecord, null);
  const [demo] = seedDemo([historical], 1);
  assert.equal(demo.Material, null);
  assert.equal(demo.PurchasingInfoRecord, null);
  assert.equal(demo.sourcePurchasingInfoRecord, "ORIGINAL");
  const model = cds.model;
  assert.ok(model);
  const feed = model.entities[`${NS}.CockpitFreetextFeed`];
  assert.equal(feed.elements.Material, undefined);
  const target = feed.elements.PurchasingInfoRecord;
  assert.ok("@feed.role" in target);
  assert.deepEqual(target["@feed.role"], { "#": "target" });
  assert.equal("@feed.role" in feed.elements.sourcePurchasingInfoRecord, false);
});

test("expanded request context persists original codes and allocation values, not final PO labels", async () => {
  const historical = source({
    isOpen: false,
    MaterialGroup: "FINAL",
    PurchasingGroup: "POG",
    Supplier: "PO-SUP",
    sourceMaterialGroup: "ORIGINAL",
    sourcePurchasingGroup: "PRG",
    sourceSupplier: "PR-SUP",
    CompanyCode: "DE01",
    PurchaseRequisitionPrice: 529.62,
    PurReqnPriceQuantity: 1,
    PurReqnItemCurrency: "EUR",
    StorageLocation: "0001",
    itemLongText: "Repair compressor",
    accountAssignments: [{ GLAccount: "6150000", CostCenter: "DE1101" }],
  });
  await upsertItems([historical]);
  const [stored] = await readItems();
  const context = requestFeatures(stored);
  assert.equal(context.RequestedQuantity, 5);
  assert.equal(context.BaseUnit, "EA");
  assert.equal(context.RequestedLeadTimeDays, 31);
  assert.equal(context.CompanyCode, "DE01");
  assert.equal(context.PurchaseRequisitionPrice, 529.62);
  assert.equal(context.sourceMaterialGroup, "ORIGINAL");
  assert.equal(context.sourcePurchasingGroup, "PRG");
  assert.equal(context.sourceSupplier, "PR-SUP");
  assert.equal(JSON.parse(context.accountingContext!)[0].GLAccount, "6150000");
  assert.equal(JSON.parse(context.accountingContext!)[0].CostCenter, "DE1101");
  const review = {
    reviewedShortText: "Repair compressor",
    reviewedQuantity: 5,
    reviewedUnit: "EA",
    reviewedValuationPrice: 529.62,
    reviewedDeliveryDate: "2026-10-13",
  };
  for (const change of [
    { reviewedQuantity: 6 },
    { reviewedUnit: "PC" },
    { reviewedValuationPrice: 530 },
    { reviewedDeliveryDate: "2026-10-14" },
    { reviewedLongText: "Changed" },
  ])
    assert.notEqual(
      predictionInputHash(review),
      predictionInputHash({ ...review, ...change }),
    );
});

test("new target evidence validates working plant, organization, supplier and material before explicit Apply", async () => {
  await readySource();
  const material = "M".repeat(40);
  await INSERT.into("tide.s4.Product").entries([
    { Product: material },
    { Product: "OTHER" },
    { Product: "DELETED", IsMarkedForDeletion: true },
  ]);
  await INSERT.into("tide.s4.ProductPlant").entries([
    { Product: material, Plant: "DE21" },
    { Product: "OTHER", Plant: "AT21" },
    { Product: "DELETED", Plant: "DE21" },
  ]);
  await INSERT.into("tide.s4.ProductDescription").entries({
    Product: material,
    Language: "EN",
    ProductDescription: "Working-plant material",
  });
  await INSERT.into("tide.s4.Supplier").entries([
    { Supplier: "S01" },
    { Supplier: "S02" },
  ]);
  const records = [
    "GOOD",
    "PLANT",
    "ORG",
    "SUPPLIER",
    "MATERIAL",
    "DELETED",
    "SCOPEDEL",
  ];
  await INSERT.into("tide.s4.PurchasingInfoRecord").entries(
    records.map((record) => ({
      PurchasingInfoRecord: record,
      Material: record === "MATERIAL" ? "OTHER" : material,
      Supplier: record === "SUPPLIER" ? "S02" : "S01",
      IsDeleted: record === "DELETED",
    })),
  );
  await INSERT.into("tide.s4.PurgInfoRecdOrgPlantData").entries(
    records.map((record) => ({
      PurchasingInfoRecord: record,
      PurchasingInfoRecordCategory: "0",
      PurchasingOrganization: record === "ORG" ? "1000" : "2000",
      Plant: record === "PLANT" ? "AT21" : "",
      IsMarkedForDeletion: record === "SCOPEDEL",
    })),
  );
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  await UPDATE.entity("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .set({
      reviewedPlant: "DE21",
      reviewedPurchasingOrganization: "2000",
      Supplier: "S01",
    })
    .where(key);
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  const snapshot = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  const inputHash = predictionInputHash(pending);
  for (const [field, value, candidates] of [
    ["Material", material, [material, "OTHER", "DELETED", "MISSING"]],
    ["PurchasingInfoRecord", "GOOD", records],
  ] as const) {
    await INSERT.into(
      "PurchasingDeskService.FreetextDraftEvidences.drafts",
    ).entries({
      ...key,
      DraftAdministrativeData_DraftUUID:
        pending.DraftAdministrativeData_DraftUUID,
      generation: 10,
      field,
      inputHash,
      sourceRevision: pending.sourceRevision,
      sourceFingerprint: snapshot.sourceFingerprint,
      status: "available",
      value,
      candidates: JSON.stringify(
        candidates.map((code) => ({ value: code, probability: 0.8 })),
      ),
    });
  }
  const request = (data: Record<string, unknown> = {}) =>
    Object.assign(reviewRequest(data), {
      params: [{ ...key, IsActiveEntity: false }],
    });
  const workspace = JSON.parse(await reviewWorkspace(request()));
  assert.equal(workspace.evidence.reviewedMaterial.selectedName, null);
  assert.deepEqual(
    workspace.evidence.reviewedMaterial.alternatives.map(
      (candidate: any) => candidate.value,
    ),
    [material],
  );
  assert.equal(
    workspace.evidence.reviewedMaterial.name,
    "Working-plant material",
  );
  await assert.rejects(
    applyDraftSuggestion(
      request({
        field: "Material",
        candidate: material,
        evidenceGeneration: 10,
        expectedInputHash: inputHash,
        expectedCurrentValue: null,
      }),
    ),
    /cannot be replaced by AI/,
  );
  await UPDATE.entity("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .set({ reviewedMaterial: material, materialState: "entered" })
    .where(key);
  const afterMaterial = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(afterMaterial.reviewedMaterial, material);
  assert.equal(afterMaterial.materialState, "entered");
  assert.equal(predictionInputHash(afterMaterial), inputHash);
  const current = JSON.parse(await reviewWorkspace(request()));
  assert.deepEqual(
    current.evidence.reviewedPurchasingInfoRecord.alternatives.map(
      (candidate: any) => candidate.value,
    ),
    ["GOOD"],
  );
  await assert.rejects(
    applyDraftSuggestion(
      request({
        field: "PurchasingInfoRecord",
        candidate: "MATERIAL",
        evidenceGeneration: 10,
        expectedInputHash: inputHash,
        expectedCurrentValue: null,
      }),
    ),
    /valid|candidate/i,
  );
  await applyDraftSuggestion(
    request({
      field: "PurchasingInfoRecord",
      candidate: "GOOD",
      evidenceGeneration: 10,
      expectedInputHash: inputHash,
      expectedCurrentValue: null,
    }),
  );
  const afterInfoRecord = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(afterInfoRecord.reviewedPurchasingInfoRecord, "GOOD");
  assert.equal(afterInfoRecord.infoRecordState, "suggested");
  await UPDATE.entity("tide.s4.ProductPlant")
    .set({ IsMarkedForDeletion: true })
    .where({ Product: material, Plant: "DE21" });
  assert.deepEqual(
    JSON.parse(await reviewWorkspace(request())).evidence.reviewedMaterial
      .alternatives,
    [],
  );
});

test("Requests workflow summary counts buyer-scoped items by displayed stage", async () => {
  const rows = [
    ["1000000001", "needs_review", "New"],
    ["1000000002", "needs_review", "In progress"],
    ["1000000003", "awaiting_approval", "Awaiting approval"],
    ["1000000004", "approved", "Approved draft"],
    [
      "1000000005",
      "awaiting_source_confirmation",
      "Awaiting source confirmation",
    ],
    ["1000000006", "completed", "Completed"],
    ["1000000007", "cancelled", "Cancelled"],
  ].map(([PurchaseRequisition, lifecycleStatus, reviewStatusText]) => ({
    PurchaseRequisition,
    PurchaseRequisitionItem: "00010",
    Plant: "AT21",
    PurchasingGroup: "B01",
    routedGroup: "B01",
    routedBuyer: "buyerA",
    lifecycleStatus,
    reviewStatusText,
    sourceChanged: false,
  }));
  await INSERT.into(`${NS}.FreetextReview`).entries([
    ...rows,
    {
      PurchaseRequisition: "1000000008",
      PurchaseRequisitionItem: "00010",
      Plant: "AT22",
      PurchasingGroup: "B02",
      routedGroup: "B02",
      routedBuyer: "buyerB",
      lifecycleStatus: "needs_review",
      reviewStatusText: "New",
      sourceChanged: false,
    },
  ]);

  const summary = await requestWorkflowSummary(
    new cds.User({
      id: "buyerA",
      roles: [],
      attr: { Plant: "AT21", PurchasingGroup: "B01" },
    }),
  );

  assert.deepEqual(summary, {
    newItems: 1,
    inProgress: 1,
    awaitingApproval: 1,
    approvedDraft: 1,
    awaitingSourceConfirmation: 1,
    completed: 1,
    cancelled: 1,
  });
});

test("missing mutable reviews are restored from durable work items", async () => {
  await syncWorkItems([source()]);
  await DELETE.from(`${NS}.FreetextReview`).where(key);

  assert.equal(await ensureMissingReviews(), 1);
  assert.equal(await ensureMissingReviews(), 0);

  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(review.requestText, "Replacement bearing");
  assert.equal(review.reviewedShortText, "Replacement bearing");
  const typed = await SELECT.one
    .from(`${NS}.RequisitionReviews`)
    .where({ header_ID: `requisition:${source().id}` });
  assert.equal(typed.reviewStatus, "new");
});

test("source long text remains immutable while a buyer completes an independent draft", async () => {
  await syncWorkItems([
    source({
      itemLongText:
        "Install bearing assembly.\n\nInclude calibration certificate.",
      headerNote: "Stop line if this is late.",
    }),
  ]);
  const initial = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(
    initial.itemLongText,
    "Install bearing assembly.\n\nInclude calibration certificate.",
  );
  assert.equal(initial.reviewedLongText, initial.itemLongText);
  const response = await app.axios.get(
    `/odata/v4/desk/PurchaseRequisitionReviews(PurchaseRequisition='${key.PurchaseRequisition}',PurchaseRequisitionItem='${key.PurchaseRequisitionItem}',IsActiveEntity=true)?$select=itemLongText,headerNote`,
    {
      auth: {
        username: "ilyesse.hettenbach@cbs-consulting.de",
        password: "alice",
      },
      validateStatus: () => true,
    },
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.itemLongText, initial.itemLongText);
  assert.equal(response.data.headerNote, "Stop line if this is late.");
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      reviewedLongText:
        "Buyer scope: install bearing assembly with certificate.",
    })
    .where(key);
  const completed = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(
    completed.itemLongText,
    "Install bearing assembly.\n\nInclude calibration certificate.",
  );
  assert.equal(
    completed.reviewedLongText,
    "Buyer scope: install bearing assembly with certificate.",
  );
});

test("review exposes a buyer-facing next step instead of technical readiness", async () => {
  await syncWorkItems([source()]);
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(review.reviewStatusText, "New");
  assert.equal(review.nextStep, "Choose material group before submitting.");
  assert.equal(review.isReadyToSubmit, false);
});

test("typed requisition review route exposes the typed lifecycle", async () => {
  await syncWorkItems([source()]);
  const metadata = await app.axios.get("/odata/v4/desk/$metadata", {
    auth: {
      username: "ilyesse.hettenbach@cbs-consulting.de",
      password: "alice",
    },
  });
  assert.match(metadata.data, /EntitySet Name="RequisitionReviews"/);
  assert.match(metadata.data, /Action Name="submitReview" IsBound="true"/);
  const result = await app.axios.get(
    "/odata/v4/desk/RequisitionReviews(header_ID='requisition:1000000001%2F00010')",
    {
      auth: {
        username: "ilyesse.hettenbach@cbs-consulting.de",
        password: "alice",
      },
      validateStatus: () => true,
    },
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.reviewStatus, "new");
});

test("incomplete review and account assignment category block submission", async () => {
  await syncWorkItems([source({ AccountAssignmentCategory: "K" })]);
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  await assert.rejects(
    reviewedAction(work, review, "ilyesse.hettenbach@cbs-consulting.de"),
    (e: any) => e.status === 400 && /Account assignment/.test(e.message),
  );
});

test("typed submission uses workspace validation and writes no partial lifecycle", async () => {
  await syncWorkItems([source()]);
  const srv: any = await cds.connect.to("PurchasingDeskService");
  const user = new cds.User({
    id: "ilyesse.hettenbach@cbs-consulting.de",
    roles: ["user", "admin"],
    attr: {},
  });
  await assert.rejects(
    srv.tx({ user }).send({
      event: "submitReview",
      entity: "RequisitionReviews",
      params: [{ header_ID: `requisition:${source().id}` }],
    }),
    (e: any) => Number(e.status ?? e.statusCode ?? e.code) === 410,
  );
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  const workflow = await cds.connect.to("WorkflowService");
  await assert.rejects(
    workflow.tx({ user }, (tx) =>
      tx.send("submitRequisitionReview", {
        caseID: `requisition:${source().id}`,
        commandID: "incomplete-review-submit",
        expectedModifiedAt: review.modifiedAt,
        expectedReviewToken: "0".repeat(64),
      }),
    ),
    (error: any) =>
      Number(error.status ?? error.statusCode ?? error.code) === 400,
  );
  assert.equal((await buyerCommands()).length, 0);
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.RequisitionReviews`)
        .where({ header_ID: `requisition:${source().id}` })
    ).reviewStatus,
    "new",
  );
  for (const table of [
    "Actions",
    "OperationLocks",
    "CaseActions",
    "ActionEvents",
    "FreetextSubmission",
  ])
    assert.equal((await SELECT.from(`${NS}.${table}`)).length, 0);
});

test("unchanged refresh preserves submitted review after a posted outcome", async () => {
  const item = source({ MaterialGroup: "MG01", PurchasingGroup: "A01" });
  await syncWorkItems([item]);
  await INSERT.into("tide.s4.PurchasingGroup").entries({
    PurchasingGroup: "A01",
  });
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
  });
  await INSERT.into(`${NS}.FreetextItem`).entries({
    id: "OLD/00010",
    PurchaseRequisition: "OLD",
    PurchaseRequisitionItem: "00010",
    text: "prior",
    Plant: "AT21",
    PurchasingOrganization: "1000",
    PurchasingGroup: "A01",
    isOpen: false,
  });
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      MaterialGroup: "MG01",
      reviewedPurchasingGroup: "A01",
      materialGroupState: "confirmed",
      purchasingGroupState: "confirmed",
    })
    .where(key);
  const req = {
    params: [key],
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  const action = await submitReview(req);
  await decide(action.ID, {
    decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
    asOf: "2026-10-05",
  });
  await logOutcome(action.ID, {
    resolution: "posted",
    resolvedBy: "ilyesse.hettenbach@cbs-consulting.de",
  });
  await syncWorkItems([item]);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key))
      .lifecycleStatus,
    "awaiting_source_confirmation",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.RequisitionReviews`)
        .where({ header_ID: `requisition:${item.id}` })
    ).reviewStatus,
    "submitted",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: `requisition:${item.id}` })
    ).attention,
    "awaiting_source",
  );
});

test("reviewed values, not proposal values, become a PR export", async () => {
  await syncWorkItems([source()]);
  await INSERT.into("tide.s4.PurchasingGroup").entries({
    PurchasingGroup: "A01",
    PurchasingGroupName: "Buyer",
  });
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
    ProductGroupName: "Materials",
  });
  await INSERT.into(`${NS}.FreetextItem`).entries({
    id: "OLD/00010",
    PurchaseRequisition: "OLD",
    PurchaseRequisitionItem: "00010",
    text: "prior",
    Plant: "AT21",
    PurchasingOrganization: "1000",
    PurchasingGroup: "A01",
    isOpen: false,
  });
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      MaterialGroup: "MG01",
      materialGroupState: "entered",
      reviewedPurchasingGroup: "A01",
      purchasingGroupState: "confirmed",
    })
    .where(key);
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  await INSERT.into(`${NS}.FreetextProposal`).entries({
    ...key,
    field: "PurchasingGroup",
    value: "A01",
    confidence: 0.92,
    source: "tabpfn",
    status: "prefilled",
    sourceRevision: work.sourceRevision,
    sourceFingerprint: work.sourceFingerprint,
  });
  const req = {
    params: [key],
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  const action = await submitReview(req);
  assert.equal(action.kind, "pr_review");
  const again = await submitReview(req);
  assert.equal(again.ID, action.ID);
});

test("a pre-filled suggestion is not buyer confirmation", async () => {
  await syncWorkItems([source()]);
  await INSERT.into("tide.s4.PurchasingGroup").entries({
    PurchasingGroup: "A01",
    PurchasingGroupName: "Buyer",
  });
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
    ProductGroupName: "Materials",
  });
  await INSERT.into(`${NS}.FreetextItem`).entries({
    id: "OLD/00010",
    PurchaseRequisition: "OLD",
    PurchaseRequisitionItem: "00010",
    text: "prior",
    Plant: "AT21",
    PurchasingOrganization: "1000",
    PurchasingGroup: "A01",
    isOpen: false,
  });
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      MaterialGroup: "MG01",
      materialGroupState: "entered",
      reviewedPurchasingGroup: "A01",
      purchasingGroupState: "suggested",
    })
    .where(key);
  await assert.rejects(
    reviewedAction(
      await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key),
      await SELECT.one.from(`${NS}.FreetextReview`).where(key),
      "ilyesse.hettenbach@cbs-consulting.de",
    ),
    (e: any) => e.status === 400 && /explicit buyer decision/.test(e.message),
  );
  const current = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  await INSERT.into(`${NS}.FreetextProposal`).entries({
    ...key,
    field: "PurchasingGroup",
    value: "A01",
    confidence: 0.92,
    source: "tabpfn",
    status: "prefilled",
    sourceRevision: current.sourceRevision,
    sourceFingerprint: current.sourceFingerprint,
  });
  await confirmSuggestions({
    params: [key],
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .purchasingGroupState,
    "confirmed",
  );
});

test("draft edits survive as separate rows and active review remains unchanged", async () => {
  await syncWorkItems([source()]);
  const root = `/odata/v4/desk/PurchaseRequisitionReviews(PurchaseRequisition='${key.PurchaseRequisition}',PurchaseRequisitionItem='${key.PurchaseRequisitionItem}',IsActiveEntity=true)`;
  const auth = {
    auth: {
      username: "ilyesse.hettenbach@cbs-consulting.de",
      password: "alice",
    },
    headers: { "If-Match": "*" },
    validateStatus: () => true,
  };
  const read = await app.axios.get(root, auth);
  assert.equal(read.status, 200);
  assert.equal(read.data.RequisitionerName, "Morgan Lee");
  const edit = await app.axios.post(
    `${root}/PurchasingDeskService.draftEdit`,
    {},
    auth,
  );
  assert.equal(edit.status, 201);
  const patch = await app.axios.patch(
    root.replace("IsActiveEntity=true", "IsActiveEntity=false"),
    { buyerNote: "Check account details" },
    auth,
  );
  assert.equal(patch.status, 200);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).buyerNote,
    null,
  );
  const draft = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(draft.buyerNote, "Check account details");
});

test("draft activation saves an incomplete review without preparing an approval", async () => {
  await syncWorkItems([source()]);
  const active = `/odata/v4/desk/PurchaseRequisitionReviews(PurchaseRequisition='${key.PurchaseRequisition}',PurchaseRequisitionItem='${key.PurchaseRequisitionItem}',IsActiveEntity=true)`;
  const auth = {
    auth: {
      username: "ilyesse.hettenbach@cbs-consulting.de",
      password: "alice",
    },
    headers: { "If-Match": "*" },
    validateStatus: () => true,
  };
  assert.equal(
    (
      await app.axios.post(
        `${active}/PurchasingDeskService.draftEdit`,
        {},
        auth,
      )
    ).status,
    201,
  );
  const pending = active.replace("IsActiveEntity=true", "IsActiveEntity=false");
  assert.equal(
    (
      await app.axios.patch(
        pending,
        { buyerNote: "Draft, still missing codes" },
        auth,
      )
    ).status,
    200,
  );
  const result = await app.axios.post(
    `${pending}/PurchasingDeskService.draftActivate`,
    {},
    auth,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).buyerNote,
    "Draft, still missing codes",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.RequisitionReviews`)
        .where({ header_ID: `requisition:${source().id}` })
    ).reviewStatus,
    "in_progress",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: `requisition:${source().id}` })
    ).attention,
    "in_progress",
  );
  assert.equal((await SELECT.from(`${NS}.Actions`)).length, 0);
});

test("source refresh during a saved review requires explicit reconciliation", async () => {
  await syncWorkItems([source()]);
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ MaterialGroup: "MG01", materialGroupState: "entered" })
    .where(key);
  await syncWorkItems([source({ RequestedQuantity: 7 })]);
  const req = {
    params: [key],
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  await reconcileReview(req);
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(review.RequestedQuantity, 7);
  assert.equal(review.MaterialGroup, "MG01");
  assert.equal(review.sourceRevision, 2);
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: `requisition:${source().id}` })
    ).attention,
    "needs_review",
  );
});

test("a source revision supersedes its active approval and requires reconciliation", async () => {
  await syncWorkItems([
    source({
      sourceMaterialGroup: "MG01",
      sourcePurchasingGroup: "A01",
      sourceSupplier: "S1",
    }),
  ]);
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
    ProductGroupName: "Materials",
  });
  await INSERT.into("tide.s4.PurchasingGroup").entries({
    PurchasingGroup: "A01",
    PurchasingGroupName: "Buyer",
  });
  await INSERT.into("tide.s4.Supplier").entries({
    Supplier: "S1",
    SupplierName: "Supplier",
  });
  await INSERT.into(`${NS}.FreetextItem`).entries({
    id: "OLD/00010",
    PurchaseRequisition: "OLD",
    PurchaseRequisitionItem: "00010",
    text: "prior",
    Plant: "AT21",
    PurchasingOrganization: "1000",
    PurchasingGroup: "A01",
    Supplier: "S1",
    isOpen: false,
  });
  const req = {
    params: [key],
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  await confirmSuggestions(req);
  const action = await submitReview(req);
  await syncWorkItems([
    source({
      sourceMaterialGroup: "MG01",
      sourcePurchasingGroup: "A01",
      sourceSupplier: "S1",
      RequestedQuantity: 7,
    }),
  ]);
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(
    (await SELECT.one.from(`${NS}.Actions`).where({ ID: action.ID })).status,
    "declined",
  );
  assert.equal(
    (await SELECT.from(`${NS}.OperationLocks`).where({ action_ID: action.ID }))
      .length,
    0,
  );
  assert.equal(review.requiresSourceReconciliation, true);
  assert.match(review.sourceChangeSummary, /request changed after your review/);
});

test("unchanged source sync is idempotent and refreshed review stays current", async () => {
  await syncWorkItems([source()]);
  await syncWorkItems([source()]);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)).sourceRevision,
    1,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).sourceChanged,
    false,
  );
});

test("buyer can explicitly confirm unchanged source values for approval", async () => {
  await syncWorkItems([
    source({
      sourceMaterialGroup: "MG01",
      sourcePurchasingGroup: "A01",
      sourceSupplier: "S1",
    }),
  ]);
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
    ProductGroupName: "Materials",
  });
  await INSERT.into("tide.s4.PurchasingGroup").entries({
    PurchasingGroup: "A01",
    PurchasingGroupName: "Buyer",
  });
  await INSERT.into("tide.s4.Supplier").entries({
    Supplier: "S1",
    SupplierName: "Supplier",
  });
  await INSERT.into(`${NS}.FreetextItem`).entries({
    id: "OLD/00010",
    PurchaseRequisition: "OLD",
    PurchaseRequisitionItem: "00010",
    text: "prior",
    Plant: "AT21",
    PurchasingOrganization: "1000",
    PurchasingGroup: "A01",
    Supplier: "S1",
    isOpen: false,
  });
  const req = {
    params: [key],
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  await confirmSuggestions(req);
  const action = await submitReview(req);
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.RequisitionReviews`)
        .where({ header_ID: `requisition:${source().id}` })
    ).reviewStatus,
    "submitted",
  );
  const lines = await SELECT.from(`${NS}.ActionItems`).where({
    action_ID: action.ID,
  });
  assert.ok(lines.length > 3);
  assert.ok(
    lines.every((line: any) => JSON.parse(line.data).changed === false),
  );
  const submission = await SELECT.one
    .from(`${NS}.FreetextSubmission`)
    .where({ action_ID: action.ID });
  assert.equal(submission.sourceRevision, 1);
  assert.equal(JSON.parse(submission.payload).completed.Quantity, 5);
});

test("invalid scoped codes and buyer scope are enforced on edits and submission", async () => {
  await syncWorkItems([
    source({ sourcePurchasingGroup: "A01", routedBuyer: "buyerA01" }),
  ]);
  const req = {
    params: [key],
    user: new cds.User({
      id: "buyerA02",
      roles: ["user"],
      attr: { PurchasingGroup: "A02", Plant: "AT21" },
    }),
  } as unknown as cds.Request;
  await assert.rejects(submitReview(req), (e: any) => e.status === 403);
  const edit = {
    params: [key],
    event: "PATCH",
    data: { MaterialGroup: "NONEXISTENT" },
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  await assert.rejects(
    guardReview(edit),
    (e: any) => e.status === 400 && /not a valid code/.test(e.message),
  );
});

test("prediction failure leaves the review editable without accepting a suggestion", async () => {
  await syncWorkItems([source()]);
  await markEnrichment(source(), [
    {
      field: "PurchasingGroup",
      value: null,
      confidence: null,
      status: "review",
      rightOf100: null,
      source: "tabpfn",
      segment: "global",
      alternatives: [],
      reason: "model unavailable",
    },
  ]);
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(work.enrichmentStatus, "failed");
  assert.equal(review.reviewedPurchasingGroup, null);
  assert.equal(review.lifecycleStatus, "needs_review");
});

test("requisition conversion completes the work item without replacing buyer decisions", async () => {
  await syncWorkItems([source()]);
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ MaterialGroup: "MG01", materialGroupState: "corrected" })
    .where(key);
  await syncWorkItems([source({ isOpen: false })]);
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: `requisition:${source().id}` })
    ).status,
    "open",
  );
  assert.notEqual(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).lifecycleStatus,
    "completed",
  );
  await INSERT.into("tide.s4.PurchaseOrderItem").entries({
    PurchaseOrder: "4500000991",
    PurchaseOrderItem: "10",
    PurchaseRequisition: key.PurchaseRequisition,
    PurchaseRequisitionItem: key.PurchaseRequisitionItem,
    PurchasingDocumentDeletionCode: "",
  });
  await syncWorkItems([
    source({
      isOpen: false,
      PurchasingDocument: "4500000991",
      PurchasingDocumentItem: "10",
    }),
  ]);
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(work.lifecycleStatus, "completed");
  assert.equal(review.lifecycleStatus, "completed");
  assert.equal(review.MaterialGroup, "MG01");
});

test("requester value help uses persisted nonblank source names", async () => {
  await syncWorkItems([source()]);
  const res = await app.axios.get("/odata/v4/desk/Requisitioners", {
    auth: {
      username: "ilyesse.hettenbach@cbs-consulting.de",
      password: "alice",
    },
    validateStatus: () => true,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.data.value.map((r: any) => r.RequisitionerName),
    ["Morgan Lee"],
  );
});

test("approval outcome and source closure move the queue to completed", async () => {
  await syncWorkItems([source()]);
  await INSERT.into("tide.s4.PurchasingGroup").entries({
    PurchasingGroup: "A01",
    PurchasingGroupName: "Buyer",
  });
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
    ProductGroupName: "Materials",
  });
  await INSERT.into(`${NS}.FreetextItem`).entries({
    id: "OLD/00010",
    PurchaseRequisition: "OLD",
    PurchaseRequisitionItem: "00010",
    text: "prior",
    Plant: "AT21",
    PurchasingOrganization: "1000",
    PurchasingGroup: "A01",
    isOpen: false,
  });
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      MaterialGroup: "MG01",
      materialGroupState: "entered",
      reviewedPurchasingGroup: "A01",
      purchasingGroupState: "entered",
    })
    .where(key);
  const action = await submitReview({
    params: [key],
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request);
  await decide(action.ID, {
    decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
    asOf: "2026-10-05",
  });
  await syncWorkItems([source()]);
  await logOutcome(action.ID, {
    resolution: "posted",
    resolvedBy: "ilyesse.hettenbach@cbs-consulting.de",
  });
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  assert.equal(work.lifecycleStatus, "awaiting_source_confirmation");
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).lifecycleStatus,
    "awaiting_source_confirmation",
  );
});

test("buyer queue hides requisitions routed to other buyers", async () => {
  await syncWorkItems([
    source({
      sourcePurchasingGroup: "A01",
      routedGroup: "A01",
      routedBuyer: "buyerA01",
    }),
  ]);
  const a = await app.axios.get("/odata/v4/desk/PurchaseRequisitionReviews", {
    auth: { username: "buyerA01", password: "buyerA01" },
    validateStatus: () => true,
  });
  const b = await app.axios.get("/odata/v4/desk/PurchaseRequisitionReviews", {
    auth: { username: "buyerA02", password: "buyerA02" },
    validateStatus: () => true,
  });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.data.value.length, 1);
  assert.equal(b.data.value.length, 0);
});

const reviewRequest = (data: Record<string, unknown> = {}) =>
  ({
    params: [key],
    data,
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  }) as unknown as cds.Request;
const activeUrl = `/odata/v4/desk/PurchaseRequisitionReviews(PurchaseRequisition='${key.PurchaseRequisition}',PurchaseRequisitionItem='${key.PurchaseRequisitionItem}',IsActiveEntity=true)`;
const buyerAuth = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
  headers: { "If-Match": "*" },
  validateStatus: () => true,
};

async function readySource() {
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
    ProductGroupName: "Materials",
  });
  await INSERT.into("tide.s4.PurchasingGroup").entries([
    { PurchasingGroup: "A01", PurchasingGroupName: "Buying team" },
    { PurchasingGroup: "A02", PurchasingGroupName: "Alternative team" },
  ]);
  await syncWorkItems([
    source({
      sourceMaterialGroup: "MG01",
      sourcePurchasingGroup: "A01",
      CompanyCode: "DE01",
      PurchaseRequisitionPrice: 852.91,
      PurReqnPriceQuantity: 1,
      PurReqnItemCurrency: "EUR",
    }),
  ]);
}

test("working copy initializes organisation, company and valuation pricing from the request", async () => {
  await readySource();
  const review = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(review.reviewedCompanyCode, "DE01");
  assert.equal(review.reviewedPurchasingOrganization, "1000");
  assert.equal(review.reviewedValuationPrice, 852.91);
  assert.equal(review.reviewedPriceQuantity, 1);
  assert.equal(review.reviewedCurrency, "EUR");
  assert.equal(JSON.parse(review.fieldOrigins).reviewedCompanyCode, "source");
});

test("legacy prefill repairs only untouched rows and preserves ambiguous buyer blanks", async () => {
  await readySource();
  const initial = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      workingCopyVersion: null,
      fieldOrigins: null,
      reviewedCompanyCode: null,
      modifiedAt: initial.createdAt,
    })
    .where(key);
  await syncWorkItems([
    source({
      sourceMaterialGroup: "MG01",
      sourcePurchasingGroup: "A01",
      CompanyCode: "DE01",
      PurchaseRequisitionPrice: 852.91,
      PurReqnPriceQuantity: 1,
      PurReqnItemCurrency: "EUR",
    }),
  ]);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .reviewedCompanyCode,
    "DE01",
  );
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      workingCopyVersion: null,
      fieldOrigins: null,
      reviewedCompanyCode: null,
      modifiedAt: "2026-10-02T01:00:00Z",
    })
    .where(key);
  await syncWorkItems([
    source({
      sourceMaterialGroup: "MG01",
      sourcePurchasingGroup: "A01",
      CompanyCode: "DE01",
      PurchaseRequisitionPrice: 852.91,
      PurReqnPriceQuantity: 1,
      PurReqnItemCurrency: "EUR",
    }),
  ]);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .reviewedCompanyCode,
    null,
  );
});

test("draft field provenance retains buyer clears and non-code edits across source refresh", async () => {
  await readySource();
  assert.equal(
    (
      await app.axios.post(
        `${activeUrl}/PurchasingDeskService.draftEdit`,
        {},
        buyerAuth,
      )
    ).status,
    201,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const patch = await app.axios.patch(
    draftUrl,
    { reviewedCompanyCode: null, reviewedValuationPrice: 900 },
    buyerAuth,
  );
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(
    JSON.parse(pending.fieldOrigins).reviewedCompanyCode,
    "buyer_cleared",
  );
  assert.equal(
    JSON.parse(pending.fieldOrigins).reviewedValuationPrice,
    "buyer_changed",
  );
  const activated = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.draftActivate`,
    {},
    buyerAuth,
  );
  assert.equal(activated.status, 200, JSON.stringify(activated.data));
  await syncWorkItems([
    source({
      sourceMaterialGroup: "MG01",
      sourcePurchasingGroup: "A01",
      CompanyCode: "DE02",
      PurchaseRequisitionPrice: 852.91,
      PurReqnPriceQuantity: 1,
      PurReqnItemCurrency: "EUR",
      RequestedQuantity: 7,
    }),
  ]);
  const saved = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(saved.reviewedCompanyCode, null);
  assert.equal(saved.reviewedValuationPrice, 900);
  assert.equal(saved.requiresSourceReconciliation, true);
  await reconcileReview(reviewRequest());
  const reconciled = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(reconciled.reviewedCompanyCode, null);
  assert.equal(reconciled.reviewedValuationPrice, 900);
  assert.equal(reconciled.reviewedQuantity, 7);
});

test("workspace distinguishes failed legacy predictions from missing evidence", async () => {
  await readySource();
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  await UPDATE.entity(`${NS}.FreetextWorkItem`)
    .set({ enrichmentStatus: "failed" })
    .where(key);
  await INSERT.into(`${NS}.FreetextProposal`).entries({
    ...key,
    field: "PurchasingGroup",
    sourceRevision: work.sourceRevision,
    sourceFingerprint: work.sourceFingerprint,
    reason: "TabPFN prediction required; received fake",
  });
  const workspace = JSON.parse(await reviewWorkspace(reviewRequest()));
  assert.equal(workspace.evidence.reviewedPurchasingGroup.status, "failed");
  assert.equal(workspace.evidence.reviewedMaterial.status, "unavailable");
});

test("workspace exposes named current alternatives and suppresses stale or invalid evidence", async () => {
  await readySource();
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  await INSERT.into(`${NS}.FreetextProposal`).entries({
    ...key,
    field: "PurchasingGroup",
    value: "A01",
    confidence: 0.9,
    modelScore: 0.9,
    source: "tabpfn",
    sourceRevision: work.sourceRevision,
    sourceFingerprint: work.sourceFingerprint,
    alternatives: JSON.stringify([
      { value: "A01", probability: 0.9 },
      { value: "INVALID", probability: 0.8 },
      { value: "A02", probability: 0.1 },
    ]),
  });
  const evidence = JSON.parse(await reviewWorkspace(reviewRequest())).evidence
    .reviewedPurchasingGroup;
  assert.equal(evidence.selectedName, "Buying team");
  assert.deepEqual(
    evidence.alternatives.map((a: any) => a.value),
    ["A01", "A02"],
  );
  assert.equal(evidence.alternatives[1].name, "Alternative team");
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ reviewedPurchasingGroup: "A02", purchasingGroupState: "corrected" })
    .where(key);
  const alternative = JSON.parse(await reviewWorkspace(reviewRequest()))
    .evidence.reviewedPurchasingGroup;
  assert.equal(alternative.origin, "buyer");
  assert.equal(alternative.selectedScore, 0.1);
  assert.equal(alternative.reviewed, true);
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ reviewedPlant: "DE21" })
    .where(key);
  const stale = JSON.parse(await reviewWorkspace(reviewRequest())).evidence
    .reviewedPurchasingGroup;
  assert.equal(stale.status, "stale");
  assert.equal(stale.value, null);
  assert.deepEqual(stale.alternatives, []);
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      reviewedPlant: work.Plant,
      reviewedShortText: "Different buying request",
    })
    .where(key);
  assert.equal(
    JSON.parse(await reviewWorkspace(reviewRequest())).evidence
      .reviewedPurchasingGroup.status,
    "stale",
  );
});

test("draft workspace function is callable through OData and alternative selection becomes a buyer decision", async () => {
  await readySource();
  assert.equal(
    (
      await app.axios.post(
        `${activeUrl}/PurchasingDeskService.draftEdit`,
        {},
        buyerAuth,
      )
    ).status,
    201,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const workspace = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.reviewWorkspace`,
    {},
    buyerAuth,
  );
  assert.equal(workspace.status, 200, JSON.stringify(workspace.data));
  assert.equal(
    JSON.parse(workspace.data.value).evidence.reviewedPurchasingGroup
      .selectedName,
    "Buying team",
  );
  const patch = await app.axios.patch(
    draftUrl,
    { reviewedPurchasingGroup: "A02" },
    buyerAuth,
  );
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(pending.reviewedPurchasingGroup, "A02");
  assert.equal(pending.purchasingGroupState, "entered");
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .reviewedPurchasingGroup,
    "A01",
  );
});

test("provisional suggestions fill only blank draft fields and remain unreviewed", async () => {
  await INSERT.into("tide.s4.ProductGroupText").entries({
    ProductGroup: "MG01",
    Language: "EN",
    ProductGroupName: "Materials",
  });
  await INSERT.into("tide.s4.PurchasingGroup").entries({
    PurchasingGroup: "A01",
    PurchasingGroupName: "Buying team",
  });
  await syncWorkItems([source({ sourceMaterialGroup: "MG01" })]);
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  await INSERT.into(`${NS}.FreetextProposal`).entries({
    ...key,
    field: "PurchasingGroup",
    value: "A01",
    confidence: 0.92,
    status: "prefilled",
    source: "tabpfn",
    sourceRevision: work.sourceRevision,
    sourceFingerprint: work.sourceFingerprint,
  });
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const draftRequest = reviewRequest();
  draftRequest.params = [{ ...key, IsActiveEntity: false }];
  const workspace = JSON.parse(await applyProvisionalSuggestions(draftRequest));
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(pending.reviewedPurchasingGroup, "A01");
  assert.equal(pending.purchasingGroupState, "suggested");
  assert.equal(
    workspace.evidence.reviewedPurchasingGroup.reviewStatus,
    "not_reviewed",
  );
  assert.equal(workspace.evidence.reviewedPurchasingGroup.origin, "ai");
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .reviewedPurchasingGroup,
    null,
  );
});

test("draft evidence applies only the generated candidate and discard removes it", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  const inputHash = predictionInputHash(pending);
  await INSERT.into(
    "PurchasingDeskService.FreetextDraftEvidences.drafts",
  ).entries({
    ...key,
    DraftAdministrativeData_DraftUUID:
      pending.DraftAdministrativeData_DraftUUID,
    generation: 7,
    field: "PurchasingGroup",
    inputHash,
    sourceRevision: pending.sourceRevision,
    sourceFingerprint: (
      await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)
    ).sourceFingerprint,
    status: "available",
    value: "A01",
    candidates: JSON.stringify([{ value: "A01", probability: 0.9 }]),
  });
  const req = {
    params: [{ ...key, IsActiveEntity: false }],
    data: {
      field: "PurchasingGroup",
      candidate: "A01",
      evidenceGeneration: 7,
      expectedInputHash: inputHash,
      expectedCurrentValue: "A01",
    },
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  await applyDraftSuggestion(req);
  assert.equal(
    (
      await SELECT.one
        .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
        .where(key)
    ).reviewedPurchasingGroup,
    "A01",
  );
  await assert.rejects(
    applyDraftSuggestion({
      ...req,
      data: { ...req.data, candidate: "A02" },
    } as cds.Request),
    (e: any) => e.status === 400,
  );
  const discarded = await app.axios.delete(draftUrl, buyerAuth);
  assert.equal(discarded.status, 204, JSON.stringify(discarded.data));
  assert.equal(
    await SELECT.one
      .from("PurchasingDeskService.FreetextDraftEvidences.drafts")
      .where(key),
    undefined,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .reviewedPurchasingGroup,
    "A01",
  );
});

test("prediction returns a pending generation and discarded drafts are not recreated", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  const response = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.predictDraftFields`,
    {
      selectedFields: JSON.stringify(["MaterialGroup"]),
      expectedDraftUUID: pending.DraftAdministrativeData_DraftUUID,
      expectedModifiedAt: pending.modifiedAt,
      expectedInputHash: predictionInputHash(pending),
    },
    buyerAuth,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(JSON.parse(response.data.value).outcomes[0].status, "pending");
  assert.ok(
    ["pending", "unavailable", "failed"].includes(
      (
        await SELECT.one
          .from("PurchasingDeskService.FreetextDraftEvidences.drafts")
          .where(key)
      ).status,
    ),
  );
  assert.equal((await app.axios.delete(draftUrl, buyerAuth)).status, 204);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await SELECT.one
      .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
      .where(key),
    undefined,
  );
  assert.equal(
    await SELECT.one
      .from("PurchasingDeskService.FreetextDraftEvidences.drafts")
      .where(key),
    undefined,
  );
});

test("Save cancels pending evidence without allowing late publication", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  await INSERT.into(
    "PurchasingDeskService.FreetextDraftEvidences.drafts",
  ).entries({
    ...key,
    DraftAdministrativeData_DraftUUID:
      pending.DraftAdministrativeData_DraftUUID,
    generation: 12,
    field: "MaterialGroup",
    inputHash: predictionInputHash(pending),
    sourceRevision: pending.sourceRevision,
    sourceFingerprint: (
      await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)
    ).sourceFingerprint,
    status: "pending",
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
  });
  const saved = await app.axios.post(
    `${activeUrl.replace("IsActiveEntity=true", "IsActiveEntity=false")}/PurchasingDeskService.draftActivate`,
    {},
    buyerAuth,
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextDraftEvidence`).where(key)).status,
    "canceled",
  );
  assert.equal(
    JSON.parse(await reviewWorkspace(reviewRequest())).evidence.MaterialGroup
      .status,
    "canceled",
  );
});

test("feed refresh preserves in-flight query rows", async () => {
  const query = source({ id: `Q/${cds.utils.uuid()}`, isQuery: true });
  await upsertItems([query]);
  await writeItems([source()]);
  assert.ok(
    await SELECT.one.from(`${NS}.FreetextItem`).where({ id: query.id }),
  );
  assert.ok(
    await SELECT.one.from(`${NS}.FreetextItem`).where({ id: source().id }),
  );
});

test("draft evidence and decisions require the actual editing buyer", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const req = Object.assign(
    new cds.Request({
      event: "READ",
      data: {
        field: "PurchasingGroup",
        expectedCurrentValue: "A01",
      },
    }),
    {
      params: [{ ...key, IsActiveEntity: false }],
      user: new cds.User({ id: "other-admin", roles: ["admin"], attr: {} }),
    },
  );
  await assert.rejects(
    () => reviewWorkspace(req),
    /draft belongs to another buyer/,
  );
  await assert.rejects(
    () => confirmDraftValue(req),
    /draft belongs to another buyer/,
  );
});

test("draft confirmation records an unchanged value without a PATCH", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  const req = {
    params: [{ ...key, IsActiveEntity: false }],
    data: { field: "PurchasingGroup", expectedCurrentValue: "A01" },
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  await confirmDraftValue(req);
  const decision = await SELECT.one
    .from("PurchasingDeskService.FreetextDraftDecisions.drafts")
    .where({ ...key, field: "PurchasingGroup" });
  assert.equal(decision.value, "A01");
  assert.ok(decision.confirmedAt);
  assert.equal(
    (
      await SELECT.one
        .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
        .where(key)
    ).reviewedPurchasingGroup,
    pending.reviewedPurchasingGroup,
  );
  assert.equal(
    (
      await SELECT.one
        .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
        .where(key)
    ).purchasingGroupState,
    "confirmed",
  );
});

test("typed prediction workspace enforces identity, opaque candidates and explicit confirmation", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  await INSERT.into(
    "PurchasingDeskService.FreetextDraftEvidences.drafts",
  ).entries({
    ...key,
    DraftAdministrativeData_DraftUUID:
      pending.DraftAdministrativeData_DraftUUID,
    generation: 11,
    field: "PurchasingGroup",
    inputHash: predictionInputHash(pending),
    sourceRevision: pending.sourceRevision,
    sourceFingerprint: (
      await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)
    ).sourceFingerprint,
    status: "available",
    value: "A02",
    candidates: JSON.stringify([{ value: "A02", probability: 0.8 }]),
  });
  let response = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.reviewWorkspaceV5`,
    {},
    buyerAuth,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.schemaVersion, 5);
  let field = response.data.fields.find(
    (field: any) => field.field === "PurchasingGroup",
  );
  assert.deepEqual(field.current, {
    kind: "code",
    code: "A01",
    displayName: "Buying team",
  });
  assert.equal(field.origin, "source");
  assert.equal(field.capabilities.canApply, true);
  const identity = response.data.identity;
  const params = {
    field: field.field,
    evidenceID: field.evidence.id,
    candidateID: field.evidence.candidates[0].id,
    expectedDraftUUID: identity.draftUUID,
    expectedModifiedAt: identity.modifiedAt,
    expectedInputHash: identity.inputHash,
    expectedValue: field.current,
  };
  assert.equal(
    (
      await app.axios.post(
        `${draftUrl}/PurchasingDeskService.applyDraftSuggestionV5`,
        { ...params, candidateID: "invented" },
        buyerAuth,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await app.axios.post(
        `${draftUrl}/PurchasingDeskService.applyDraftSuggestionV5`,
        { ...params, expectedDraftUUID: cds.utils.uuid() },
        buyerAuth,
      )
    ).status,
    409,
  );
  response = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.applyDraftSuggestionV5`,
    params,
    buyerAuth,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  field = response.data.fields.find(
    (field: any) => field.field === "PurchasingGroup",
  );
  assert.equal(field.current.code, "A02");
  assert.equal(field.origin, "ai");
  assert.equal(field.reviewed, false);
  assert.equal(field.capabilities.canConfirm, true);
  const appliedAt = field.decision.appliedAt;
  response = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.confirmDraftValueV5`,
    {
      field: field.field,
      expectedDraftUUID: response.data.identity.draftUUID,
      expectedModifiedAt: response.data.identity.modifiedAt,
      expectedInputHash: response.data.identity.inputHash,
      expectedValue: field.current,
    },
    buyerAuth,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  field = response.data.fields.find(
    (field: any) => field.field === "PurchasingGroup",
  );
  assert.equal(field.reviewed, true);
  assert.equal(field.decision.appliedAt, appliedAt);
  assert.equal(field.decision.evidenceGeneration, 11);
  await app.axios.patch(
    draftUrl,
    { reviewedPurchasingGroup: "A01" },
    buyerAuth,
  );
  response = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.reviewWorkspaceV5`,
    {},
    buyerAuth,
  );
  assert.equal(
    response.data.fields.find((field: any) => field.field === "PurchasingGroup")
      .origin,
    "manual",
  );
});

test("batch acceptance validates all choices before writing and marks accepted values reviewed", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  const work = await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key);
  await INSERT.into(
    "PurchasingDeskService.FreetextDraftEvidences.drafts",
  ).entries(
    [
      { field: "PurchasingGroup", value: "A02" },
      { field: "AccountAssignmentCategory", value: "K" },
    ].map(({ field, value }) => ({
      ...key,
      DraftAdministrativeData_DraftUUID:
        pending.DraftAdministrativeData_DraftUUID,
      generation: 21,
      field,
      value,
      inputHash: predictionInputHash(pending),
      sourceRevision: work.sourceRevision,
      sourceFingerprint: work.sourceFingerprint,
      status: "available",
      candidates: JSON.stringify([{ value, probability: 0.8 }]),
    })),
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const response = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.reviewWorkspaceV5`,
    {},
    buyerAuth,
  );
  const workspace = response.data;
  const selections = workspace.fields
    .filter((field: any) =>
      ["PurchasingGroup", "AccountAssignmentCategory"].includes(field.field),
    )
    .map((field: any) => ({
      field: field.field,
      expectedValue: field.current,
      evidenceID: field.evidence.id,
      candidateID: field.evidence.candidates[0].id,
    }));
  const req = Object.assign(reviewRequest(), {
    params: [{ ...key, IsActiveEntity: false }],
    data: {
      expectedDraftUUID: workspace.identity.draftUUID,
      expectedModifiedAt: workspace.identity.modifiedAt,
      expectedInputHash: workspace.identity.inputHash,
      selections,
    },
  });
  await assert.rejects(
    applyPredictionSelections(
      Object.assign(reviewRequest(), {
        params: req.params,
        data: {
          ...req.data,
          selections: [
            selections[0],
            { ...selections[1], candidateID: "invalid" },
          ],
        },
      }),
    ),
    (error: any) => error.status === 409,
  );
  await assert.rejects(
    applyPredictionSelections(
      Object.assign(reviewRequest(), {
        params: req.params,
        data: { ...req.data, selections: [selections[0], selections[0]] },
      }),
    ),
    (error: any) => error.status === 400,
  );
  assert.equal(
    (
      await SELECT.one
        .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
        .where(key)
    ).reviewedPurchasingGroup,
    "A01",
  );
  assert.equal(
    (
      await SELECT.from(
        "PurchasingDeskService.FreetextDraftDecisions.drafts",
      ).where(key)
    ).length,
    0,
  );
  const acceptedResponse = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.applyPredictionSelections`,
    req.data,
    buyerAuth,
  );
  const accepted = acceptedResponse.data;
  assert.equal(
    accepted.fields.find((field: any) => field.field === "PurchasingGroup")
      ?.current.code,
    "A02",
  );
  assert.equal(
    accepted.fields.find(
      (field: any) => field.field === "AccountAssignmentCategory",
    )?.current.code,
    "K",
  );
  assert.equal(
    accepted.fields.find((field: any) => field.field === "MaterialGroup")
      ?.current.code,
    "MG01",
  );
  for (const field of accepted.fields.filter((field: any) =>
    selections.some((selection: any) => selection.field === field.field),
  )) {
    assert.equal(field.reviewed, true);
    assert.equal(field.decision?.appliedAt, field.decision?.confirmedAt);
  }
});

test("typed prediction receipt accepts only typed, capability-gated target arrays", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const response = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.reviewWorkspaceV5`,
    {},
    buyerAuth,
  );
  const identity = response.data.identity;
  const params = {
    expectedDraftUUID: identity.draftUUID,
    expectedModifiedAt: identity.modifiedAt,
    expectedInputHash: identity.inputHash,
  };
  assert.equal(
    (
      await app.axios.post(
        `${draftUrl}/PurchasingDeskService.predictDraftFieldsV5`,
        { ...params, selectedFields: ["Nonexistent"] },
        buyerAuth,
      )
    ).status,
    400,
  );
  const result = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.predictDraftFieldsV5`,
    { ...params, selectedFields: ["MaterialGroup"] },
    buyerAuth,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.outcomes[0].status, "pending");
  assert.equal(result.data.inputHash, identity.inputHash);
  await app.axios.delete(draftUrl, buyerAuth);
});

test("active prediction publishes evidence without creating a draft or changing buyer decisions", async () => {
  await readySource();
  const beforeReview = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  const workspace = (
    await app.axios.post(
      `${activeUrl}/PurchasingDeskService.reviewWorkspaceV5`,
      {},
      buyerAuth,
    )
  ).data;
  assert.equal(workspace.identity.draftUUID, null);
  const materialGroup = workspace.fields.find(
    (field: any) => field.field === "MaterialGroup",
  );
  assert.equal(materialGroup.capabilities.canPredict, true);
  assert.equal(materialGroup.capabilities.canApply, false);
  const parameters = {
    expectedDraftUUID: null,
    expectedModifiedAt: workspace.identity.modifiedAt,
    expectedInputHash: workspace.identity.inputHash,
    selectedFields: ["MaterialGroup"],
  };
  assert.equal(
    (
      await app.axios.post(
        `${activeUrl}/PurchasingDeskService.predictDraftFieldsV5`,
        { ...parameters, expectedInputHash: "changed" },
        buyerAuth,
      )
    ).status,
    409,
  );
  const result = await app.axios.post(
    `${activeUrl}/PurchasingDeskService.predictDraftFieldsV5`,
    parameters,
    buyerAuth,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.outcomes[0].status, "pending");
  const evidenceKey = {
    ...key,
    generation: result.data.generation,
    field: "MaterialGroup",
  };
  let evidence = await SELECT.one
    .from(`${NS}.FreetextDraftEvidence`)
    .where(evidenceKey);
  const deadline = Date.now() + 5000;
  while (evidence.status === "pending" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    evidence = await SELECT.one
      .from(`${NS}.FreetextDraftEvidence`)
      .where(evidenceKey);
  }
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.reason, "model_failed");
  assert.equal(evidence.inputHash, workspace.identity.inputHash);
  assert.equal(
    (
      await SELECT.from(
        "PurchasingDeskService.PurchaseRequisitionReviews.drafts",
      ).where(key)
    ).length,
    0,
  );
  assert.equal(
    (await SELECT.from(`${NS}.FreetextDraftDecision`).where(key)).length,
    0,
  );
  const afterReview = await SELECT.one.from(`${NS}.FreetextReview`).where(key);
  assert.equal(afterReview.modifiedAt, beforeReview.modifiedAt);
  assert.equal(afterReview.modifiedBy, beforeReview.modifiedBy);
  for (const property of [
    "MaterialGroup",
    "reviewedQuantity",
    "fieldOrigins",
    "materialGroupState",
    "reviewStatusText",
  ])
    assert.equal(afterReview[property], beforeReview[property], property);
  assert.equal(
    (
      await app.axios.post(
        `${activeUrl}/PurchasingDeskService.applyDraftSuggestionV5`,
        {
          expectedDraftUUID: null,
          expectedModifiedAt: workspace.identity.modifiedAt,
          expectedInputHash: workspace.identity.inputHash,
          field: "MaterialGroup",
          evidenceID: materialGroup.evidence.id,
          candidateID: "not-a-candidate",
          expectedValue: materialGroup.current,
        },
        buyerAuth,
      )
    ).status,
    409,
  );
});

test("active prediction leaves an existing working draft and its inputs untouched", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  await app.axios.patch(draftUrl, { reviewedQuantity: 99 }, buyerAuth);
  const beforeDraft = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  const workspace = (
    await app.axios.post(
      `${activeUrl}/PurchasingDeskService.reviewWorkspaceV5`,
      {},
      buyerAuth,
    )
  ).data;
  const result = await app.axios.post(
    `${activeUrl}/PurchasingDeskService.predictDraftFieldsV5`,
    {
      selectedFields: ["MaterialGroup"],
      expectedDraftUUID: null,
      expectedModifiedAt: workspace.identity.modifiedAt,
      expectedInputHash: workspace.identity.inputHash,
    },
    buyerAuth,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const afterDraft = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.deepEqual(afterDraft, beforeDraft);
  assert.equal(
    (
      await SELECT.from(
        "PurchasingDeskService.FreetextDraftEvidences.drafts",
      ).where(key)
    ).length,
    0,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).reviewedQuantity,
    5,
  );
  await app.axios.delete(draftUrl, buyerAuth);
});

test("category evidence applies explicitly, preserves allocations and requires confirmation", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  await INSERT.into(
    "PurchasingDeskService.FreetextReviewAccountAssignments.drafts",
  ).entries({
    ...key,
    DraftAdministrativeData_DraftUUID:
      pending.DraftAdministrativeData_DraftUUID,
    PurchaseReqnAcctAssgmtNumber: "01",
    GLAccount: "400000",
    CostCenter: "C1",
    DistributionPercent: 100,
  });
  const inputHash = predictionInputHash(pending);
  await INSERT.into(
    "PurchasingDeskService.FreetextDraftEvidences.drafts",
  ).entries({
    ...key,
    DraftAdministrativeData_DraftUUID:
      pending.DraftAdministrativeData_DraftUUID,
    generation: 8,
    field: "AccountAssignmentCategory",
    inputHash,
    sourceRevision: pending.sourceRevision,
    sourceFingerprint: (
      await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)
    ).sourceFingerprint,
    status: "available",
    value: "K",
    candidates: JSON.stringify([{ value: "K", probability: 0.95 }]),
  });
  const req = {
    params: [{ ...key, IsActiveEntity: false }],
    data: {
      field: "AccountAssignmentCategory",
      candidate: "K",
      evidenceGeneration: 8,
      expectedInputHash: inputHash,
      expectedCurrentValue: "",
    },
    user: new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["admin"],
      attr: {},
    }),
  } as unknown as cds.Request;
  await applyDraftSuggestion(req);
  let draftRow = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(draftRow.reviewedAccountAssignmentCategory, "K");
  assert.equal(draftRow.accountAssignmentCategoryState, "suggested");
  assert.equal(
    (
      await SELECT.from(
        "PurchasingDeskService.FreetextReviewAccountAssignments.drafts",
      ).where(key)
    ).length,
    1,
  );
  await confirmDraftValue({
    ...req,
    data: { field: "AccountAssignmentCategory", expectedCurrentValue: "K" },
  } as cds.Request);
  draftRow = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  assert.equal(draftRow.accountAssignmentCategoryState, "confirmed");
  const decision = await SELECT.one
    .from("PurchasingDeskService.FreetextDraftDecisions.drafts")
    .where({ ...key, field: "AccountAssignmentCategory" });
  assert.equal(decision.evidenceGeneration, 8);
  assert.ok(decision.appliedAt);
  assert.ok(decision.confirmedAt);
});

test("valid blank suggestions retain lineage after confirmation and Save", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  const inputHash = predictionInputHash(pending);
  await INSERT.into(
    "PurchasingDeskService.FreetextDraftEvidences.drafts",
  ).entries({
    ...key,
    DraftAdministrativeData_DraftUUID:
      pending.DraftAdministrativeData_DraftUUID,
    generation: 9,
    field: "AccountAssignmentCategory",
    inputHash,
    sourceRevision: pending.sourceRevision,
    sourceFingerprint: (
      await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)
    ).sourceFingerprint,
    status: "available",
    value: "-",
    candidates: JSON.stringify([{ value: "-", probability: 0.95 }]),
  });
  const req = Object.assign(reviewRequest(), {
    params: [{ ...key, IsActiveEntity: false }],
    data: {
      field: "AccountAssignmentCategory",
      candidate: "-",
      evidenceGeneration: 9,
      expectedInputHash: inputHash,
      expectedCurrentValue: "",
    },
  });
  await applyDraftSuggestion(req);
  const confirmed = JSON.parse(
    await confirmDraftValue(
      Object.assign(req, {
        data: { field: "AccountAssignmentCategory", expectedCurrentValue: "" },
      }),
    ),
  );
  assert.equal(
    confirmed.evidence.reviewedAccountAssignmentCategory.decision.value,
    "-",
  );
  assert.ok(
    confirmed.evidence.reviewedAccountAssignmentCategory.decision.appliedAt,
  );
  const draftUrl = activeUrl.replace(
    "IsActiveEntity=true",
    "IsActiveEntity=false",
  );
  const saved = await app.axios.post(
    `${draftUrl}/PurchasingDeskService.draftActivate`,
    {},
    buyerAuth,
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const workspace = JSON.parse(await reviewWorkspace(reviewRequest()));
  assert.equal(
    workspace.evidence.reviewedAccountAssignmentCategory.status,
    "available",
  );
  assert.equal(
    workspace.evidence.reviewedAccountAssignmentCategory.origin,
    "ai",
  );
  assert.equal(
    workspace.evidence.reviewedAccountAssignmentCategory.decision
      .evidenceGeneration,
    9,
  );
});

test("fresh draft evidence uses edited inputs rather than the source context", async () => {
  await readySource();
  await app.axios.post(
    `${activeUrl}/PurchasingDeskService.draftEdit`,
    {},
    buyerAuth,
  );
  await UPDATE.entity("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .set({ reviewedShortText: "Changed request", reviewedPlant: "DE21" })
    .where(key);
  const pending = await SELECT.one
    .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .where(key);
  await INSERT.into(
    "PurchasingDeskService.FreetextDraftEvidences.drafts",
  ).entries({
    ...key,
    DraftAdministrativeData_DraftUUID:
      pending.DraftAdministrativeData_DraftUUID,
    generation: 10,
    field: "MaterialGroup",
    inputHash: predictionInputHash(pending),
    sourceRevision: pending.sourceRevision,
    sourceFingerprint: (
      await SELECT.one.from(`${NS}.FreetextWorkItem`).where(key)
    ).sourceFingerprint,
    status: "available",
    value: "MG01",
    candidates: JSON.stringify([{ value: "MG01", probability: 0.8 }]),
  });
  const req = Object.assign(reviewRequest(), {
    params: [{ ...key, IsActiveEntity: false }],
  });
  const workspace = JSON.parse(await reviewWorkspace(req));
  assert.equal(workspace.evidence.MaterialGroup.status, "available");
  assert.equal(workspace.evidence.reviewedPurchasingGroup.status, "stale");
  await UPDATE.entity("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
    .set({ reviewedShortText: "Changed again" })
    .where(key);
  assert.equal(
    JSON.parse(await reviewWorkspace(req)).evidence.MaterialGroup.status,
    "stale",
  );
});

test("canonical Review submission replays one immutable submission and linked owner events", async () => {
  await readySource();
  const summary = JSON.parse(await reviewOrder(reviewRequest()));
  const payload = {
    caseID: `requisition:${source().id}`,
    commandID: "review-submit-1",
    expectedModifiedAt: summary.expectedModifiedAt,
    expectedReviewToken: summary.expectedReviewToken,
  };
  const endpoint = "/odata/v4/workflow";
  const agent = await cds.connect.to("CockpitMcpService");
  const toolUser = new cds.User({
    id: buyerAuth.auth.username,
    roles: ["user", "admin"],
    attr: {},
  });
  const checkedSummary = await agent.tx({ user: toolUser }, (tx) =>
    tx.send("get_review_summary", { caseID: payload.caseID }),
  );
  assert.ok(typeof checkedSummary === "string");
  assert.deepEqual(JSON.parse(checkedSummary), summary);
  assert.equal((await SELECT.from(`${NS}.Actions`)).length, 0);
  assert.equal((await buyerCommands()).length, 0);
  const header = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: payload.caseID });
  const generic = {
    caseID: payload.caseID,
    commandID: "forbidden-generic-review",
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  assert.equal(
    (await app.POST(`${endpoint}/prepareCaseAction`, generic, buyerAuth))
      .status,
    400,
  );
  assert.equal(
    (
      await app.POST(
        `${endpoint}/acceptCaseException`,
        {
          ...generic,
          commandID: "forbidden-review-exception",
          note: "Do not bypass Review readiness",
        },
        buyerAuth,
      )
    ).status,
    400,
  );
  assert.equal((await buyerCommands()).length, 0);
  const first = await app.POST(
    `${endpoint}/submitRequisitionReview`,
    payload,
    buyerAuth,
  );
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const { ["@odata.context"]: metadata, ...committedResult } = first.data;
  assert.equal(metadata, "$metadata#WorkflowService.CommandResult");
  assert.deepEqual(
    await agent.tx({ user: toolUser }, (tx) =>
      tx.send("submit_review", payload),
    ),
    committedResult,
  );
  assert.deepEqual(
    (await app.POST(`${endpoint}/submitRequisitionReview`, payload, buyerAuth))
      .data,
    first.data,
  );
  assert.deepEqual(
    (
      await app.GET(
        `${endpoint}/commandResult(commandID='review-submit-1')`,
        buyerAuth,
      )
    ).data,
    first.data,
  );
  assert.equal((await SELECT.from(`${NS}.FreetextSubmission`)).length, 1);
  assert.equal((await SELECT.from(`${NS}.Actions`)).length, 1);
  const submitted = await SELECT.one
    .from("tide.workflow.ReviewEvents")
    .where({ event: "submitted" });
  assert.ok(submitted.command_ID);
  assert.equal(submitted.submissionID, first.data.submissionID);
  const immutable = await SELECT.one
    .from(`${NS}.FreetextSubmission`)
    .where({ ID: first.data.submissionID });
  const approved = await app.POST(
    `${endpoint}/approveAction`,
    {
      actionID: first.data.actionID,
      commandID: "review-approve-1",
      expectedModifiedAt: first.data.actionModifiedAt,
    },
    buyerAuth,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).lifecycleStatus,
    "approved",
  );
  const posted = await app.POST(
    `${endpoint}/recordActionOutcome`,
    {
      actionID: first.data.actionID,
      commandID: "review-post-1",
      expectedModifiedAt: approved.data.actionModifiedAt,
      resolution: "posted",
      completeness: "complete",
      note: "External document reported",
    },
    buyerAuth,
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key)).lifecycleStatus,
    "awaiting_source_confirmation",
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: payload.caseID })).status,
    "open",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.FreetextSubmission`)
        .where({ ID: immutable.ID })
    ).payload,
    immutable.payload,
  );
  assert.deepEqual(
    (
      await SELECT.from("tide.workflow.ReviewEvents")
        .where`actor != 'privileged'`.orderBy("occurredAt")
    ).map((e: { event: string }) => e.event),
    ["submitted", "action_waiting", "action_resolved"],
  );
});

test("review summary is read-only, final submission records acceptance, approved instructions are immutable", async () => {
  await readySource();
  const summary = JSON.parse(await reviewOrder(reviewRequest()));
  assert.equal(summary.completed.CompanyCode, "DE01");
  assert.equal(summary.completed.ValuationPrice, 852.91);
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .materialGroupState,
    "unreviewed_source",
  );
  assert.equal((await SELECT.from(`${NS}.Actions`)).length, 0);
  await assert.rejects(
    exportOrderDraft(reviewRequest()),
    (e: any) => e.status === 410,
  );
  const action = await submitReviewedOrder(
    reviewRequest({
      expectedModifiedAt: summary.expectedModifiedAt,
      expectedReviewToken: summary.expectedReviewToken,
    }),
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .materialGroupState,
    "confirmed",
  );
  await assert.rejects(
    exportOrderDraft(reviewRequest()),
    (e: any) => e.status === 410,
  );
  await decide(action.ID, {
    decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
    asOf: "2026-10-02",
  });
  const frozenInstructions = async () => {
    const items = await SELECT.from(`${NS}.ActionItems`).where({
      action_ID: action.ID,
    });
    return items
      .map((item: { data: string }) => JSON.parse(item.data))
      .find((data: any) => data.payload)?.payload;
  };
  const prepared = await frozenInstructions();
  assert.ok(prepared);
  assert.equal(action.kind, "pr_review");
  assert.equal(prepared.completed.ValuationPrice, 852.91);
  await assert.rejects(
    exportOrderDraft(reviewRequest()),
    (error: any) => error.status === 410,
  );
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ reviewedValuationPrice: 999 })
    .where(key);
  assert.deepEqual(await frozenInstructions(), prepared);
});

test("final review rejects changed working values and cannot implicitly accept stale suggestions", async () => {
  await readySource();
  const summary = JSON.parse(await reviewOrder(reviewRequest()));
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ reviewedQuantity: 8 })
    .where(key);
  await assert.rejects(
    submitReviewedOrder(
      reviewRequest({ expectedModifiedAt: summary.expectedModifiedAt }),
    ),
    (e: any) => e.status === 409,
  );
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({ reviewedPurchasingGroup: "A02", purchasingGroupState: "suggested" })
    .where(key);
  await INSERT.into(`${NS}.FreetextProposal`).entries({
    ...key,
    field: "PurchasingGroup",
    value: "A02",
    sourceRevision: 0,
    sourceFingerprint: "stale",
  });
  await assert.rejects(
    reviewOrder(reviewRequest()),
    (e: any) => e.status === 400,
  );
});

test("final summary token detects account-assignment changes without mutating review decisions", async () => {
  await readySource();
  await UPDATE.entity(`${NS}.FreetextReview`)
    .set({
      reviewedAccountAssignmentCategory: "K",
      accountAssignmentCategoryState: "entered",
    })
    .where(key);
  await INSERT.into(`${NS}.FreetextReviewAccountAssignment`).entries({
    ...key,
    PurchaseReqnAcctAssgmtNumber: "01",
    GLAccount: "400000",
    CostCenter: "C1",
    DistributionPercent: 100,
  });
  const summary = JSON.parse(await reviewOrder(reviewRequest()));
  await UPDATE.entity(`${NS}.FreetextReviewAccountAssignment`)
    .set({ CostCenter: "C2" })
    .where(key);
  const next = JSON.parse(await reviewOrder(reviewRequest()));
  assert.equal(next.accountAssignments[0].CostCenter, "C2");
  assert.notEqual(next.expectedReviewToken, summary.expectedReviewToken);
  await assert.rejects(
    submitReviewedOrder(
      reviewRequest({
        expectedModifiedAt: summary.expectedModifiedAt,
        expectedReviewToken: summary.expectedReviewToken,
      }),
    ),
    (e: any) => e.status === 409,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.FreetextReview`).where(key))
      .materialGroupState,
    "unreviewed_source",
  );
  assert.equal((await SELECT.from(`${NS}.Actions`)).length, 0);
});

test("final review actions enforce buyer scope and approval draft values cannot be changed", async () => {
  await readySource();
  const outside = {
    params: [key],
    user: new cds.User({
      id: "buyerA02",
      roles: ["user"],
      attr: { PurchasingGroup: "A02", Plant: "DE21" },
    }),
  } as unknown as cds.Request;
  await assert.rejects(reviewWorkspace(outside), (e: any) => e.status === 403);
  await assert.rejects(reviewOrder(outside), (e: any) => e.status === 403);
  await assert.rejects(exportOrderDraft(outside), (e: any) => e.status === 403);
  const summary = JSON.parse(await reviewOrder(reviewRequest()));
  await submitReviewedOrder(
    reviewRequest({
      expectedModifiedAt: summary.expectedModifiedAt,
      expectedReviewToken: summary.expectedReviewToken,
    }),
  );
  await assert.rejects(
    guardReview({
      ...reviewRequest(),
      event: "PATCH",
      data: { reviewedValuationPrice: 900 },
    } as cds.Request),
    (e: any) => e.status === 409,
  );
});
