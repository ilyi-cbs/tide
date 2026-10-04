import cds from "@sap/cds";
import { before, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  syncWorkItems,
  markEnrichment,
  predictionInputHash,
  predictDraftFieldsV5,
} from "../srv/cockpit/freetext/review";
const app = process.env.CDS_UI_BROWSER
  ? cds.test(path.join(__dirname, ".."))
  : null;

function workspaceController(modules: Record<string, any> = {}) {
  const timers: Array<() => Promise<void>> = [];
  let controller: any;
  runInNewContext(
    readFileSync(
      path.join(
        __dirname,
        "../app/purchasing-desk/webapp/ext/controller/RequisitionWorkspace.controller.js",
      ),
      "utf8",
    ),
    {
      sap: {
        ui: {
          define: (names: string[], factory: (...modules: any[]) => any) => {
            controller = factory(
              ...names.map((name) =>
                modules[name] ?? (name.endsWith("ControllerExtension")
                  ? { extend: (_name: string, definition: any) => definition }
                  : name.endsWith("/WorkspaceFormatters")
                    ? { refreshSelected: () => false }
                    : {}),
              ),
            );
          },
        },
      },
      setTimeout: (callback: () => Promise<void>) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => {},
    },
  );
  const values: Record<string, any> = {};
  controller._workspace = {
    getProperty: (name: string) => values[name],
    setProperty: (name: string, value: any) => {
      values[name] = value;
    },
    checkUpdate: () => {},
  };
  controller._isCurrent = () => true;
  controller._announce = () => {};
  controller._text = (key: string) => key;
  return { controller, values, timers };
}

function reviewWorkflowHarness() {
  const storage = new Map<string, any>();
  let sequence = 0;
  let pending: any;
  runInNewContext(readFileSync(path.join(__dirname,
    "../app/purchasing-desk/webapp/ext/shared/WorkflowPending.js"), "utf8"), {
    sap: { ui: { define: (_names: string[], factory: any) => {
      pending = factory(class {
        static Type = { session: "session" };
        put(key: string, value: any) { storage.set(key, JSON.parse(JSON.stringify(value))); return true; }
        get(key: string) { return storage.get(key); }
        remove(key: string) { storage.delete(key); }
      }, () => `review-ui-${++sequence}`);
    } } },
  });
  const { controller } = workspaceController({
    "sap/base/util/uid": () => `review-ui-${++sequence}`,
    "tide/cockpit/ext/shared/WorkflowPending": pending,
  });
  const calls: Array<{ path: string; parameters: Record<string, unknown> }> = [];
  let destroyed = 0;
  const behavior = { submit: async () => {}, result: null as any };
  const model = { bindContext: (operation: string) => {
    const parameters: Record<string, unknown> = {};
    let completed = false;
    return {
      setParameter: (name: string, value: unknown) => { parameters[name] = value; },
      invoke: async () => {
        calls.push({ path: operation, parameters: { ...parameters } });
        if (operation.includes("submitRequisitionReview")) await behavior.submit();
        completed = true;
      },
      getBoundContext: () => ({ getObject: () => completed && operation.includes("submitRequisitionReview")
        ? { caseID: parameters.caseID } : behavior.result }),
      destroy: () => { destroyed++; },
    };
  } };
  controller.base = { getView: () => ({ getModel: (name: string) => {
    assert.equal(name, "workflow", "Business commands and receipts use Workflow, not Review");
    return model;
  } }) };
  return { controller, pending, model, storage, calls, behavior,
    destroyed: () => destroyed };
}

test("Review UI uncertain retry freezes command identity and the exact reviewed summary", async () => {
  const harness = reviewWorkflowHarness();
  const summary = { expectedModifiedAt: "review-1", expectedReviewToken: "token-1" };
  const caseID = "requisition:1000000001/00010";
  harness.behavior.submit = async () => { throw new Error("Lost response"); };
  await assert.rejects(harness.controller._submitWorkflowReview(caseID, summary), /Lost response/);
  assert.deepEqual(harness.storage.get("review:" + caseID), {
    commandID: "review-ui-1", target: caseID,
    commandType: "submitRequisitionReview",
    parameters: { ...summary, caseID, commandID: "review-ui-1" },
  });
  harness.behavior.submit = async () => {};
  await harness.controller._submitWorkflowReview(caseID, {
    expectedModifiedAt: "newer-review", expectedReviewToken: "newer-token",
  });
  const writes = harness.calls.filter(call => call.path.includes("submitRequisitionReview"));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].parameters, writes[1].parameters);
  assert.deepEqual(writes[0].parameters, { ...summary, caseID, commandID: "review-ui-1" });
  assert.equal(harness.storage.size, 0);
  assert.equal(harness.controller._reviewSubmissionBusy, false);
  assert.equal(harness.destroyed(), 3);
});

test("Review UI recovers a committed lost response without another submission", async () => {
  const harness = reviewWorkflowHarness();
  const caseID = "requisition:1000000001/00010";
  harness.behavior.submit = async () => { throw new Error("Lost response"); };
  harness.behavior.result = { caseID, submissionID: "saved-submission" };
  await harness.controller._submitWorkflowReview(caseID, {
    expectedModifiedAt: "review-1", expectedReviewToken: "token-1",
  });
  assert.deepEqual(harness.calls.map(call => call.path), [
    "/submitRequisitionReview(...)", "/commandResult(...)",
  ]);
  assert.equal(harness.calls[1].parameters.commandID, "review-ui-1");
  assert.equal(harness.storage.size, 0);
  assert.equal(harness.destroyed(), 2);
});

test("Review reload blocks unknown receipts then recovers identity without resubmission", async () => {
  const harness = reviewWorkflowHarness();
  const caseID = "requisition:1000000001/00010";
  harness.pending.remember("review:" + caseID, "prior-command", caseID);
  await assert.rejects(harness.controller._reconcileReviewSubmission(caseID), /still unknown/);
  assert.equal(harness.storage.size, 1);
  harness.behavior.result = { caseID, submissionID: "saved-submission" };
  assert.deepEqual(await harness.controller._reconcileReviewSubmission(caseID), harness.behavior.result);
  assert.equal(harness.storage.size, 0);
  assert.equal(harness.calls.length, 2);
  assert.ok(harness.calls.every(call => call.path === "/commandResult(...)"));
  assert.ok(harness.calls.every(call => call.parameters.commandID === "prior-command"));
  assert.equal(harness.destroyed(), 2);
});

test("Review UI suppresses duplicate concurrent submission", async () => {
  const harness = reviewWorkflowHarness();
  let release!: () => void;
  harness.behavior.submit = () => new Promise<void>(resolve => { release = resolve; });
  const summary = { expectedModifiedAt: "review-1", expectedReviewToken: "token-1" };
  const first = harness.controller._submitWorkflowReview("requisition:1/10", summary);
  await harness.controller._submitWorkflowReview("requisition:1/10", summary);
  assert.equal(harness.calls.length, 1);
  release();
  await first;
  assert.equal(harness.controller._reviewSubmissionBusy, false);
});

test("prediction evidence reload preserves the target stage and eligible selections", () => {
  const { controller, values } = workspaceController();
  controller._workspace.setData = (data: Record<string, any>) => {
    Object.keys(values).forEach((key) => delete values[key]);
    Object.entries(data).forEach(([key, value]) => {
      values["/" + key] = value;
    });
  };
  controller._decorateEvidence = (_property: string, evidence: any) => evidence;
  values["/predictionStage"] = "targets";
  values["/predictionChoices"] = [
    {
      field: "Supplier",
      property: "Supplier",
      selected: true,
      enabled: true,
    },
  ];
  controller._setWorkspaceData({
    evidence: {
      Supplier: { capabilities: { canPredict: true, canApply: false } },
    },
  });
  assert.equal(values["/predictionStage"], "targets");
  assert.equal(values["/predictionChoices"][0].selected, true);
  assert.equal(values["/canStartPrediction"], true);
});

test("prediction command sends only explicitly selected eligible targets", async () => {
  const { controller, values } = workspaceController();
  const context = { getProperty: () => false };
  controller.base = { getView: () => ({ getBindingContext: () => context }) };
  controller._mutate = async (operation: () => Promise<void>) => operation();
  controller._waitForPendingUpdates = async () => {};
  controller._requireEvidence = async () => {};
  controller._identityParameters = () => ({
    expectedInputHash: "current-input",
  });
  controller._predictionChoices = () => [
    { field: "Supplier", property: "Supplier", enabled: true },
    { field: "MaterialGroup", property: "MaterialGroup", enabled: true },
  ];
  values["/predictionStage"] = "targets";
  values["/predictionChoices"] = [
    { field: "Supplier", enabled: true, selected: true },
    { field: "MaterialGroup", enabled: true, selected: false },
  ];
  values["/evidence/Supplier/capabilities/canPredict"] = true;
  let requested: any;
  controller._function = async (
    action: string,
    _context: any,
    parameters: any,
  ) => {
    assert.equal(action, "predictDraftFieldsV5");
    requested = parameters;
    return { generation: 2, deadlineAt: "2026-10-03T12:00:00Z" };
  };
  controller._pollPrediction = () => {};
  await controller.onPredictionCommand();
  assert.deepEqual(Array.from(requested.selectedFields), ["Supplier"]);
  assert.equal(requested.expectedInputHash, "current-input");
});

test("prediction checklist excludes Material while offering purchasing info record without default selection", () => {
  const { controller, values } = workspaceController();
  controller.base = {
    getView: () => ({ getBindingContext: () => ({ getProperty: () => null }) }),
  };
  controller._choiceDescription = () => "";
  for (const property of ["reviewedMaterial", "reviewedPurchasingInfoRecord"])
    values["/evidence/" + property] = { capabilities: { canPredict: true } };
  const choices = controller._predictionChoices();
  assert.equal(choices.filter((choice: any) => choice.property).length, 6);
  assert.equal(
    choices.filter((choice: any) => !choice.enabled && !choice.property).length,
    1,
  );
  assert.equal(
    choices.some((choice: any) => choice.field === "Material"),
    false,
  );
  const choice = choices.find(
    (candidate: any) => candidate.field === "PurchasingInfoRecord",
  );
  assert.equal(choice.enabled, true);
  assert.equal(choice.selected, false);
});

test("failed evidence exposes retry without empty candidates or explanations", () => {
  const { controller } = workspaceController();
  controller.formatProvenance = () => "fromRequest";
  const evidence: any = {
    field: "MaterialGroup",
    status: "failed",
    reason: "model_failed",
    alternatives: [],
  };
  controller._decorateEvidence("MaterialGroup", evidence);
  assert.equal(evidence.statusText, "suggestionFailed");
  assert.equal(evidence.state, "Warning");
  assert.equal(evidence.hasCandidates, false);
  assert.equal(evidence.hasExplanation, false);
  assert.equal(evidence.hasCalculation, true);
  assert.equal(
    controller._choiceDescription(evidence, true),
    "predictionRetryAvailable",
  );
});

test("general prediction checklist does not mislabel allocation predictions as unimplemented", () => {
  const { controller } = workspaceController();
  controller.base = {
    getView: () => ({ getBindingContext: () => ({ getProperty: () => null }) }),
  };
  const choices = controller._predictionChoices();
  assert.equal(
    choices.some((choice: any) => choice.field === "GLAccount"),
    false,
  );
  assert.equal(
    choices.some((choice: any) => choice.field === "CostCenter"),
    false,
  );
});

test("prediction score formatting distinguishes raw zero and decimal scores from missing values", () => {
  const { controller } = workspaceController();
  controller._text = (key: string, parameters?: any[]) =>
    parameters ? `${key}: ${parameters[0]}` : key;
  assert.equal(controller.formatScore(0), "modelScore: 0");
  assert.match(controller.formatScore(0.99), /0[.,]99$/);
  assert.ok(!controller.formatScore(0.99).includes("%"));
  for (const score of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(controller.formatScore(score), "notProvided");
  }
});

test("calculation metadata names recorded providers and versions without inventing them", () => {
  const { controller } = workspaceController();
  controller._text = (key: string, parameters?: any[]) =>
    parameters
      ? `Model: ${parameters[0]}\nBackend: ${parameters[1]}\nCalculated: ${parameters[2]}`
      : key;
  const result = controller.formatCalculation(
    "priorlabs",
    "3.5",
    "2026-10-03T12:50:51.319Z",
  );
  assert.match(
    result,
    /Model: TabPFN3\.5\nBackend: Prior Labs API\nCalculated:/,
  );
  assert.ok(!result.includes("T12:50:51.319Z"));
  assert.match(
    controller.formatCalculation("aicore", "TabPFN3.5", null),
    /SAP AI Core/,
  );
  const unknown = controller.formatCalculation("tabpfn", "tabpfn", null);
  assert.ok(unknown.includes("modelVersionUnrecorded"));
  assert.ok(unknown.includes("backendUnrecorded"));
  assert.ok(!unknown.includes("3.5"));
});

test("bulk prediction selection distinguishes missing, stale and unsupported fields", () => {
  const { controller, values } = workspaceController();
  values["/predictionChoices"] = [
    { property: "reviewedMaterial", enabled: true },
    { property: "reviewedPurchasingGroup", enabled: true },
    { property: "Supplier", enabled: false },
    { property: null, enabled: false },
  ];
  values["/evidence/reviewedMaterial"] = {
    current: { kind: "missing" },
    status: "unavailable",
  };
  values["/evidence/reviewedPurchasingGroup"] = {
    current: { kind: "code" },
    status: "stale",
  };
  values["/evidence/Supplier"] = { current: { kind: "missing" } };
  controller.onSelectMissingPredictions();
  assert.deepEqual(
    values["/predictionChoices"].map((choice: any) => choice.selected),
    [true, false, false, false],
  );
  controller.onSelectStalePredictions();
  assert.deepEqual(
    values["/predictionChoices"].map((choice: any) => choice.selected),
    [false, true, false, false],
  );
  controller.onClearPredictionSelection();
  assert.ok(
    values["/predictionChoices"].every((choice: any) => !choice.selected),
  );
  assert.equal(values["/canStartPrediction"], false);
});

for (const active of [false, true])
  test(`prediction controller waits for every requested field in the receipt generation (${active ? "active" : "draft"})`, async () => {
    const { controller, values, timers } = workspaceController();
    const context = { getProperty: () => active };
    const receipt = {
      generation: 17,
      outcomes: [{ field: "MaterialGroup" }, { field: "PurchasingGroup" }],
    };
    values["/evidence/MaterialGroup"] = { generation: 17, status: "available" };
    values["/evidence/reviewedPurchasingGroup"] = {
      generation: 16,
      status: "available",
    };
    controller._loadEvidence = async () => true;
    let opened = 0;
    controller._showPredictionResults = async () => {
      opened++;
    };
    controller._pollPrediction(context, 17, Date.now() + 60000, receipt);
    await timers.shift()!();
    assert.equal(opened, 0);
    assert.equal(values["/predictionRunning"], true);
    values["/evidence/reviewedPurchasingGroup"] = {
      generation: 17,
      status: "pending",
    };
    await timers.shift()!();
    assert.equal(opened, 0);
    values["/evidence/reviewedPurchasingGroup"].status = "failed";
    await timers.shift()!();
    assert.equal(opened, 1);
    assert.equal(values["/predictionRunning"], false);
  });

test("prediction controller opens unchecked results and accepts only chosen fields", async () => {
  const { controller, values } = workspaceController();
  const context = { getProperty: () => false };
  const identity = {
    expectedDraftUUID: "draft",
    expectedModifiedAt: "timestamp",
    expectedInputHash: "input",
  };
  controller._identityParameters = () => identity;
  controller._predictionChooser = { open: () => {}, close: () => {} };
  const receipt = {
    generation: 17,
    outcomes: [{ field: "MaterialGroup" }, { field: "PurchasingGroup" }],
  };
  for (const property of ["MaterialGroup", "reviewedPurchasingGroup"]) {
    values["/evidence/" + property] = {
      generation: 17,
      id: property,
      selectedText: "Old",
      current: { kind: "code", code: "old" },
      capabilities: { canApply: true },
      alternatives: [{ id: "candidate", displayText: "New" }],
      statusText: "Available",
    };
  }
  await controller._showPredictionResults(context, receipt);
  assert.ok(
    values["/predictionChoices"].every((choice: any) => !choice.selected),
  );
  assert.equal(values["/canAcceptPredictions"], false);
  values["/predictionChoices"][0].selected = true;
  context.getProperty = () => false;
  controller.base = { getView: () => ({ getBindingContext: () => context }) };
  controller._mutate = async (operation: () => Promise<void>) => operation();
  controller._waitForPendingUpdates = async () => {};
  controller._setWorkspaceData = () => {};
  controller._refreshWorkingFields = async () => {};
  let accepted: any;
  controller._function = async (
    action: string,
    _context: any,
    parameters: any,
  ) => {
    assert.equal(action, "applyPredictionSelections");
    accepted = parameters;
    return {};
  };
  await controller.onAcceptPredictions();
  assert.equal(accepted.selections.length, 1);
  assert.equal(accepted.selections[0].field, "MaterialGroup");
  assert.equal(accepted.expectedInputHash, "input");
});
before(async () => {
  if (app) await app;
});
test(
  "buyer edits alternatives, reviews, submits, approves and inspects immutable instructions",
  { skip: !app },
  async () => {
    const fixtureUser = new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de", roles: ["user", "admin"],
      attr: {},
    });
    const item = {
      PurchaseRequisition: "10006643",
      PurchaseRequisitionItem: "00010",
      id: "10006643/00010",
      text: "Gear motor 0.37 kW IE866",
      date: "2026-09-30",
      Plant: "DE21",
      PurchasingOrganization: "DE00",
      CompanyCode: "DE01",
      PurchaseOrderType: "NB",
      DeliveryDate: "2026-10-02",
      RequestedQuantity: 1,
      BaseUnit: "PC",
      RequisitionerName: "Leonie Kruger",
      sourceMaterialGroup: "MG19",
      sourceSupplier: "19000001",
      PurchaseRequisitionPrice: 852.91,
      PurReqnPriceQuantity: 1,
      PurReqnItemCurrency: "EUR",
      isOpen: true,
      accountAssignments: [],
    };
    await cds.run(
      cds.ql.INSERT.into("tide.s4.PurchasingGroup").entries([
        {
          PurchasingGroup: "D01",
          PurchasingGroupName: "Mechanical purchasing",
        },
        { PurchasingGroup: "D02", PurchasingGroupName: "Plant purchasing" },
      ]),
    );
    await cds.run(
      cds.ql.INSERT.into("tide.s4.ProductGroupText").entries({
        ProductGroup: "MG19",
        Language: "EN",
        ProductGroupName: "Motors",
      }),
    );
    await cds.run(
      cds.ql.INSERT.into("tide.s4.Supplier").entries({
        Supplier: "19000001",
        SupplierName: "Motor supplier",
      }),
    );
    await cds.tx({ user: fixtureUser }, () => syncWorkItems([item]));
    const work = await cds.run(
      cds.ql.SELECT.one.from("tide.cockpit.FreetextWorkItem").where({
        PurchaseRequisition: item.PurchaseRequisition,
        PurchaseRequisitionItem: item.PurchaseRequisitionItem,
      }),
    );
    await cds.run(
      cds.ql.INSERT.into("tide.cockpit.FreetextProposal").entries({
        PurchaseRequisition: item.PurchaseRequisition,
        PurchaseRequisitionItem: item.PurchaseRequisitionItem,
        field: "PurchasingGroup",
        value: "D01",
        status: "prefilled",
        confidence: 0.99,
        modelScore: 0.99,
        sourceRevision: work.sourceRevision,
        sourceFingerprint: work.sourceFingerprint,
        alternatives: JSON.stringify([
          { value: "D01", probability: 0.99 },
          { value: "D02", probability: 0.01 },
        ]),
      }),
    );
    await markEnrichment(item, [
      {
        field: "PurchasingGroup",
        value: "D01",
        confidence: 0.99,
        status: "prefilled",
        rightOf100: null,
        source: "tabpfn",
        segment: "global",
        alternatives: [],
      },
    ]);
    await cds.tx({ user: fixtureUser }, () => syncWorkItems([
      {
        ...item,
        PurchaseRequisition: "10006644",
        id: "10006644/00010",
        sourcePurchasingGroup: "D01",
        AccountAssignmentCategory: "K",
        accountAssignments: [
          {
            PurchaseReqnAcctAssgmtNumber: "01",
            GLAccount: "400000",
            CostCenter: "CC01",
            DistributionPercent: 100,
          },
        ],
      },
    ]));
    const cockpit = await cds.connect.to("PurchasingDeskService");
    await cockpit.prepend(() => {
      cockpit.on(
        "predictDraftFieldsV5",
        ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
        async (req: cds.Request) => {
          const evidenceOnlyRequest = Object.create(req);
          evidenceOnlyRequest.on = () => evidenceOnlyRequest;
          return predictDraftFieldsV5(evidenceOnlyRequest);
        },
      );
    });
    cockpit.after(
      "predictDraftFieldsV5",
      ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
      async (result: any, req: cds.Request) => {
        for (const outcome of result.outcomes) {
          await cds.run(
            cds.ql.UPDATE.entity(
              req.params[0]?.IsActiveEntity === false
                ? "PurchasingDeskService.FreetextDraftEvidences.drafts"
                : "tide.cockpit.FreetextDraftEvidence",
            )
              .set(
                outcome.field === "PurchasingGroup"
                  ? {
                      status: "available",
                      value: "D01",
                      candidates: JSON.stringify([
                        { value: "D01", probability: 0.8 },
                        { value: "D02", probability: 0.2 },
                      ]),
                    }
                  : {
                      status: "unavailable",
                      reason: "insufficient_history",
                      candidates: "[]",
                    },
              )
              .where({
                PurchaseRequisition: req.params[0]?.PurchaseRequisition,
                PurchaseRequisitionItem: req.params[0]?.PurchaseRequisitionItem,
                generation: result.generation,
                field: outcome.field,
              }),
          );
        }
      },
    );
    cockpit.after("EDIT", "PurchaseRequisitionReviews", async (row: any) => {
      if (row.PurchaseRequisition !== item.PurchaseRequisition) return;
      const key = {
        PurchaseRequisition: row.PurchaseRequisition,
        PurchaseRequisitionItem: row.PurchaseRequisitionItem,
      };
      const draft = await cds.run(
        cds.ql.SELECT.one
          .from("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
          .where(key),
      );
      await cds.run(
        cds.ql.UPDATE.entity("PurchasingDeskService.PurchaseRequisitionReviews.drafts")
          .set({ predictionGeneration: 1 })
          .where(key),
      );
      await cds.run(
        cds.ql.INSERT.into(
          "PurchasingDeskService.FreetextDraftEvidences.drafts",
        ).entries({
          ...key,
          DraftAdministrativeData_DraftUUID:
            draft.DraftAdministrativeData_DraftUUID,
          generation: 1,
          field: "PurchasingGroup",
          inputHash: predictionInputHash(draft),
          sourceRevision: work.sourceRevision,
          sourceFingerprint: work.sourceFingerprint,
          status: "available",
          value: "D01",
          candidates: JSON.stringify([
            { value: "D01", probability: 0.99 },
            { value: "D02", probability: 0.01 },
          ]),
        }),
      );
      await cds.run(
        cds.ql.INSERT.into(
          "PurchasingDeskService.FreetextDraftEvidences.drafts",
        ).entries({
          ...key,
          DraftAdministrativeData_DraftUUID:
            draft.DraftAdministrativeData_DraftUUID,
          generation: 1,
          field: "AccountAssignmentCategory",
          inputHash: predictionInputHash(draft),
          sourceRevision: work.sourceRevision,
          sourceFingerprint: work.sourceFingerprint,
          status: "unavailable",
          reason: "qualification_required",
          candidates: "[]",
        }),
      );
    });
    const url = (app as any).url;
    const result = await promisify(execFile)(
      "node",
      [path.join(__dirname, "browser", "requisition-workspace.mjs"), url],
      { timeout: 240000, maxBuffer: 1024 * 1024 },
    );
    console.log(result.stdout, result.stderr);
  },
);
