// Bound OData actions expose prepareFindingAction and acceptException on all five Prevention entities.
// Kernel tests cover the 404/409 cases; this suite verifies the HTTP layer.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, beforeEach, test } from "node:test";
import { upsertFinding, writeFindings } from "../srv/cockpit/kernel/findings";
import { finding, seedFixtures } from "./fixtures/cockpit";
import {
  backfillTypedCases,
  relinkPreparedAssessments,
  upsertTypedCase,
} from "../srv/cockpit/kernel/typed-cases";
import {
  latestAssessment,
  planningSupport,
  verifyAssessmentRevision,
} from "../srv/cockpit/kernel/prevention-assessment";
import { prepareCaseAction } from "../srv/cockpit/kernel/case-preparation";
import { reconcileSupplierPlannedTimes } from "../srv/cockpit/leadtimes/actions";
import { registerCallGuard } from "../srv/cockpit/kernel/model-calls";
import { upsertRows } from "../srv/cockpit/feed/store";

const { SELECT, DELETE } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { axios: any; url: string };
const NS = "tide.cockpit";
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
  validateStatus: () => true,
};
let fake: Server;
const modelRequests: any[] = [];
let beforeModelResponse: (() => Promise<void>) | undefined;

before(async () => {
  registerCallGuard(async () => {
    if (!beforeModelResponse) return;
    const callback = beforeModelResponse;
    beforeModelResponse = undefined;
    await callback();
  });
  fake = createServer(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health")
      return res.end(JSON.stringify({ status: "ok", backend: "fake" }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    modelRequests.push(request);
    if (beforeModelResponse) {
      const callback = beforeModelResponse;
      beforeModelResponse = undefined;
      await callback();
    }
    const classes = [...new Set(request.y_train)].sort();
    res.end(
      JSON.stringify({
        task: request.task,
        output_type: request.output.type,
        classes: request.task === "classification" ? classes : null,
        levels: request.output.levels ?? null,
        predictions: request.keys.map((key: string) => ({
          row_key: key,
          value: request.task === "classification" ? classes[0] : 30,
          probabilities:
            request.task === "classification"
              ? classes.map((_, index) =>
                  index === 0 ? 0.75 : 0.25 / (classes.length - 1),
                )
              : null,
          quantiles:
            request.output.levels?.map((level: number) => 10 + 40 * level) ??
            null,
        })),
        fallback: null,
        placeholder: false,
        dropped_columns: [],
        train_rows: request.x_train.length,
        elapsed_ms: 1,
        usage: {
          backend: "fake",
          calls: 1,
          context_cells: 30,
          predicted_cells: 1,
          cost_units: 0.5,
          effective_feature_count: request.columns.length,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  (cds.env.requires as any).tabular.credentials = {
    url: `http://127.0.0.1:${(fake.address() as any).port}`,
  };
  await app;
});

after(() => new Promise<void>((resolve) => fake.close(() => resolve())));

beforeEach(async () => {
  modelRequests.length = 0;
  beforeModelResponse = undefined;
  await DELETE.from("tide.workflow.OutcomeObservations");
  await DELETE.from("tide.workflow.SubjectClaims");
  await DELETE.from("tide.workflow.WorkflowCommands");
  for (const e of [
    "ActionEvents",
    "OperationLocks",
    "CaseActions",
    "CaseEvents",
    "AssessmentApplicability",
    "PreventionAssessment",
    "Cases",
    "MaterialPlannedTimes",
    "SupplierPlannedTimes",
    "UnusualSettings",
    "DuplicateMaterials",
    "PriceDeviations",
    "ApprovalLock",
    "ApprovalEvent",
    "ProblemEvent",
    "FindingEvidence",
    "Finding",
    "Event",
    "ActionItems",
    "Actions",
    "Problem",
    "PreventionDisposition",
    "Snapshot",
  ])
    await DELETE.from(`${NS}.${e}`);
  await DELETE.from("tide.s4.PurgInfoRecdOrgPlantData").where({
    Material: "PILOT",
  });
  await DELETE.from(`${NS}.ItemFact`).where({ Material: "PILOT" });
  await DELETE.from("tide.s4.PurchaseOrderItem").where({ Material: "PILOT" });
  await DELETE.from("tide.s4.PurchaseOrder").where({
    PurchaseOrder: "EVIPILOT",
  });
  await DELETE.from("tide.s4.ProductPlantSupplyPlanning").where({
    Product: "PILOT",
  });
  await DELETE.from("tide.s4.Product").where({ Product: "PILOT" });
  await seedFixtures(cds.db);
  await cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
    .set({ source: null, loadId: null, loadedAt: null })
    .where({ ID: "current" });
});

test("planning peer support diagnoses weak context without removing rare classes", () => {
  assert.equal(
    planningSupport(
      Array.from({ length: 30 }, () => ({ field: "A" })),
      "field",
      "A",
    ).supported,
    false,
  );
  const peers = Array.from({ length: 30 }, (_, index) => ({
    field: index < 15 ? "001" : "002",
  }));
  assert.equal(planningSupport(peers, "field", "001").supported, true);
  assert.equal(planningSupport(peers, "field", "003").supported, false);
  assert.deepEqual(planningSupport(peers, "field", "001").retained, [
    "001",
    "002",
  ]);
  const rare = planningSupport([...peers, { field: "003" }], "field", null);
  assert.equal(rare.supported, false);
  assert.deepEqual(rare.retained, ["001", "002", "003"]);
});

test("planning assessment retains full categorical probabilities, excludes the evaluated material and never claims optimal settings", async () => {
  const products = Array.from({ length: 31 }, (_, index) => ({
    Product: index === 0 ? "ASSESS" : `PEER${index}`,
    ProductType: "ROH",
    ProductGroup: "G1",
    BaseUnit: "EA",
  }));
  await cds.ql.INSERT.into("tide.s4.Product").entries(products);
  await cds.ql.INSERT.into("tide.s4.ProductPlantSupplyPlanning").entries(
    products.map((product, index) => ({
      Product: product.Product,
      Plant: "P1",
      ProcurementType: index < 16 ? "E" : "F",
      ProcurementSubType: index === 0 ? null : index < 16 ? "10" : "20",
      MRPType: index === 0 ? "UNSEEN" : index < 16 ? "PD" : "ND",
      LotSizingProcedure: index < 16 ? "EX" : "HB",
      MRPResponsible: index < 16 ? "001" : "002",
    })),
  );
  await cds.ql.INSERT.into("tide.s4.ProductPlantProcurement").entries(
    products.map((product) => ({
      Product: product.Product,
      Plant: "P1",
      PurchasingGroup: "001",
    })),
  );
  const source = await upsertFinding(
    finding({
      list: "rare",
      objectKey: "ASSESS|P1",
      Material: "ASSESS",
      rareDetail: {
        groupSize: 30,
        materialType: "ROH",
        unusualPairCount: 1,
        firstPair: "MRPType",
      },
    } as any),
  );
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const response = await app.axios.post(
    `/odata/v4/desk/UnusualSettings('${encodeURIComponent(source.ID)}')/PurchasingDeskService.assessPrevention`,
    { metric: "planning", expectedFingerprint: header.sourceFingerprint },
    AUTH,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(
    response.data.status,
    "available",
    JSON.stringify(response.data),
  );
  const metrics = JSON.parse(response.data.metrics);
  assert.equal(metrics.length, 5);
  for (const field of ["ProcurementSubType", "MRPType"]) {
    const prediction = metrics.find((entry: any) =>
      entry.label.endsWith(field),
    );
    assert.equal(prediction.source, "fake");
    assert.notEqual(prediction.value, null);
    assert.equal(prediction.detail.lowSupport, true);
    assert.match(prediction.detail.warning, /Limited peer support/);
  }
  assert.deepEqual(
    metrics.find((entry: any) => entry.label.endsWith("MRPResponsible")).detail
      .probabilities,
    { "001": 0.75, "002": 0.25 },
  );
  for (const request of modelRequests) {
    assert.equal(request.x_train.length, 30);
    assert.ok(!request.columns.includes("Material"));
    assert.ok(!request.columns.includes("MRPType"));
    assert.ok(!request.columns.includes("MRPResponsible"));
  }
  assert.notEqual(response.data.expectedFingerprint, header.sourceFingerprint);
  assert.match(response.data.summary, /peer consistency.*not automatic/i);
  const revision = await SELECT.one
    .from(`${NS}.PreventionAssessment`)
    .where({ assessmentID: response.data.assessmentID });
  assert.equal(revision.schemaVersion, 1);
  assert.equal(revision.sourceAsOf, "2026-10-05");
  assert.equal(revision.sourceFingerprint, header.sourceFingerprint);
  assert.equal(
    revision.policyVersion,
    "prevention:unusual_setting:planning:v1",
  );
  assert.match(revision.payloadHash, /^[a-f0-9]{64}$/);
  assert.ok(JSON.parse(revision.runs).length > 0);
  verifyAssessmentRevision(revision);
  assert.throws(
    () =>
      verifyAssessmentRevision({ ...revision, summary: "Altered evidence" }),
    /integrity verification/,
  );
});

test("prepared assessment relinking changes applicability without rewriting retained evidence", async () => {
  const { source, header } = await supplierPilot();
  await cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
    .set({ source: "synthetic" })
    .where({ ID: "current" });
  const assessmentID = cds.utils.uuid();
  await cds.ql.INSERT.into(`${NS}.PreventionAssessment`).entries({
    assessmentID,
    caseID: source.ID,
    metric: "overview",
    status: "available",
    source: "empirical",
    generatedAt: new Date().toISOString(),
    summary: "Restored supplier delivery evidence",
    metrics: "[]",
    expectedFingerprint: "restored-reviewed-fingerprint",
    baseFingerprint: "restored-source-fingerprint",
  });
  const before = await SELECT.one
    .from(`${NS}.PreventionAssessment`)
    .where({ assessmentID });
  assert.equal(await relinkPreparedAssessments(), 1);
  assert.deepEqual(
    await SELECT.one.from(`${NS}.PreventionAssessment`).where({ assessmentID }),
    before,
  );
  assert.equal(await relinkPreparedAssessments(), 0);
  const selected = await latestAssessment(source.ID, header.sourceFingerprint);
  assert.equal(selected?.assessmentID, assessmentID);
  assert.equal(selected?.expectedFingerprint, header.sourceFingerprint);
  assert.equal(
    await latestAssessment(source.ID, "newer-source-fingerprint"),
    undefined,
  );
  const read = await app.axios.get(
    `/odata/v4/desk/SupplierPlannedTimes('${encodeURIComponent(source.ID)}')`,
    AUTH,
  );
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(JSON.parse(read.data.assessmentJson).assessmentID, assessmentID);
  assert.equal(
    JSON.parse(read.data.assessmentJson).expectedFingerprint,
    header.sourceFingerprint,
  );
});

test("assessed approvals snapshot exact displayed evidence and remain immutable after reassessment", async () => {
  const source = await upsertFinding(
    finding({
      list: "price",
      objectKey: "ASSESSPRICE/10",
      nextActionKind: "price_clarification",
      priceDetail: {
        unitPrice: 100,
        priorMedian: 10,
        priorCount: 3,
        ratio: 10,
        factor: 10,
        currentPrice: 100,
        priceQuantity: 1,
        proposalPrice: 10,
        currency: "EUR",
      },
    } as any),
  );
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const url = `/odata/v4/desk/PriceDeviations('${encodeURIComponent(source.ID)}')/PurchasingDeskService.`;
  const assessed = await app.axios.post(
    `${url}assessPrevention`,
    { expectedFingerprint: header.sourceFingerprint },
    AUTH,
  );
  assert.equal(assessed.status, 200, JSON.stringify(assessed.data));
  assert.equal(assessed.data.status, "available");
  const input = {
    expectedFingerprint: assessed.data.expectedFingerprint,
    responsiblePerson: "Buyer",
    responsibleMessage: "Clarify the price",
  };
  const assessedHeader = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: source.ID });
  assert.equal(
    (
      await prepareWorkflowCase(assessedHeader, {
        ...input,
        expectedFingerprint: "stale",
      })
    ).status,
    409,
  );
  const prepared = await prepareWorkflowCase(assessedHeader, input);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: prepared.data.actionID });
  const snapshot = JSON.parse(item.data);
  assert.equal(snapshot.assessment.assessmentID, assessed.data.assessmentID);
  assert.deepEqual(
    snapshot.assessment.metrics,
    JSON.parse(assessed.data.metrics),
  );
  const failed = await app.axios.post(
    `${url}assessPrevention`,
    {
      metric: "planning",
      expectedFingerprint: assessed.data.expectedFingerprint,
    },
    AUTH,
  );
  assert.equal(failed.status, 400);
  assert.match(failed.data.error.message, /not supported for this case type/);
  const read = await app.axios.get(
    `/odata/v4/desk/PriceDeviations('${encodeURIComponent(source.ID)}')`,
    AUTH,
  );
  assert.equal(
    JSON.parse(read.data.assessmentJson).assessmentID,
    assessed.data.assessmentID,
  );
  const rerun = await app.axios.post(
    `${url}assessPrevention`,
    { expectedFingerprint: assessed.data.expectedFingerprint },
    AUTH,
  );
  assert.equal(rerun.status, 200, JSON.stringify(rerun.data));
  assert.notEqual(rerun.data.assessmentID, assessed.data.assessmentID);
  assert.equal(
    (await SELECT.one.from(`${NS}.ActionItems`).where({ ID: item.ID })).data,
    item.data,
  );
});

type Case = {
  entitySet: string;
  typedEntitySet: string;
  list: string;
  objectKey: string;
  nextActionKind: string;
  detailKey: string;
  detail: Record<string, unknown>;
};

const CASES: Case[] = [
  {
    entitySet: "PriceFindings",
    typedEntitySet: "PriceDeviations",
    list: "price",
    objectKey: "PR1/10",
    nextActionKind: "price_clarification",
    detailKey: "priceDetail",
    detail: {
      unitPrice: 100,
      priorMedian: 10,
      priorCount: 3,
      ratio: 10,
      factor: 10,
      direction: "higher",
      priceKey: "M|P",
      currentPrice: 100,
      priceQuantity: 1,
      proposalPrice: 10,
      currency: "EUR",
    },
  },
  {
    entitySet: "DuplicateFindings",
    typedEntitySet: "DuplicateMaterials",
    list: "duplicate",
    objectKey: "DUP1/10",
    nextActionKind: "mdg_case",
    detailKey: "duplicateDetail",
    detail: {
      groupKey: "M1|M2",
      activity: 5,
      candidateCount: 2,
      materialType: "trading_goods",
      materialNumbers: "M1,M2",
      mainPlant: "P1",
      purchasingGroup: "001",
    },
  },
  {
    entitySet: "RareSettingFindings",
    typedEntitySet: "UnusualSettings",
    list: "rare",
    objectKey: "RARE1/10",
    nextActionKind: "planner_review",
    detailKey: "rareDetail",
    detail: {
      groupSize: 10,
      materialType: "make_to_stock",
      unusualPairCount: 1,
      firstPair: "MRPType=PD, LotSize=EX",
    },
  },
  {
    entitySet: "SupplierPlannedTimeFindings",
    typedEntitySet: "SupplierPlannedTimes",
    list: "pdt",
    objectKey: "PDT1/10",
    nextActionKind: "pdt_change",
    detailKey: "pdtDetail",
    detail: {
      proposalDays: 12,
      proposalQuantile: 0.8,
      proposalRule: "p80",
      currentDays: 5,
      currentFrom: "info record",
      purchasingInfoRecord: "5500000001",
      ownDeliveries: 20,
      p10: 3,
      p50: 8,
      p80: 12,
      p90: 15,
      orders12m: 10,
      value12mEUR: 50000,
    },
  },
  {
    entitySet: "MaterialMasterPlannedTimeFindings",
    typedEntitySet: "MaterialPlannedTimes",
    list: "mm_pdt",
    objectKey: "MMPDT1",
    nextActionKind: "pdt_change",
    detailKey: "mmPdtDetail",
    detail: {
      proposalDays: 9,
      proposalRule: "order-share weighted median",
      masterDays: 3,
      masterFlag: "manual",
      difference: 6,
      tolerance: 2,
      orders12m: 8,
      note: null,
    },
  },
];

test("explicit typed migration backfills legacy findings; reads and counts do not write", async () => {
  for (const c of CASES) {
    const row = finding({
      list: c.list as any,
      objectKey: `LEGACY-${c.objectKey}`,
      source: "rule",
      nextActionKind: c.nextActionKind as any,
      [c.detailKey]: c.detail,
    } as any);
    await writeFindings("legacy-snapshot", [c.list as any], [row], {
      projectOnly: true,
    });
  }

  const before = await SELECT.from(`${NS}.Cases`);
  for (const c of CASES)
    await app.axios.get(`/odata/v4/desk/${c.typedEntitySet}?$count=true`, AUTH);
  assert.deepEqual(await SELECT.from(`${NS}.Cases`), before);
  await backfillTypedCases();
  const events = await SELECT.from(`${NS}.CaseEvents`);
  await backfillTypedCases();
  assert.deepEqual(await SELECT.from(`${NS}.CaseEvents`), events);
  for (const c of CASES) {
    const response = await app.axios.get(
      `/odata/v4/desk/${c.typedEntitySet}?$count=true`,
      AUTH,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data["@odata.count"], 1, c.typedEntitySet);
  }
});

test("Prevention summary returns all five worklist totals through one backend function", async () => {
  for (const c of CASES) {
    await writeFindings(
      "summary-snapshot",
      [c.list as any],
      [
        finding({
          list: c.list as any,
          objectKey: `SUMMARY-${c.objectKey}`,
          source: "rule",
          nextActionKind: c.nextActionKind as any,
          [c.detailKey]: c.detail,
        } as any),
      ],
    );
  }
  const response = await app.axios.get(
    "/odata/v4/desk/PurchasingDeskService.preventionSummary()",
    AUTH,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(
    {
      price: response.data.price,
      duplicates: response.data.duplicates,
      unusual: response.data.unusual,
      supplier: response.data.supplier,
      material: response.data.material,
    },
    {
      price: 1,
      duplicates: 1,
      unusual: 1,
      supplier: 1,
      material: 1,
    },
  );
});

test("combined planned-time list exposes record types and enforces buyer scope", async () => {
  for (const entry of CASES.filter((item) =>
    ["pdt", "mm_pdt"].includes(item.list),
  )) {
    const row = finding({
      list: entry.list as any,
      objectKey: `COMBINED-${entry.objectKey}`,
      Plant: "AT21",
      PurchasingGroup: "A01",
      [entry.detailKey]: entry.detail,
    } as any);
    const outside = finding({
      ...row,
      objectKey: `OUTSIDE-${entry.objectKey}`,
      Plant: "OUTSIDE",
      PurchasingGroup: "999",
    } as any);
    await writeFindings("combined-list", [entry.list as any], [row, outside]);
  }
  const response = await app.axios.get(
    "/odata/v4/desk/PlannedTimes?$count=true&$filter=caseStatus%20eq%20'open'%20and%20caseListing%20eq%20'listed'",
    { ...AUTH, auth: { username: "buyerA01", password: "buyerA01" } },
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data["@odata.count"], 2);
  assert.deepEqual(
    response.data.value.map((row: any) => row.recordType).sort(),
    ["Info Record", "Material Master"],
  );
  assert.ok(
    response.data.value.every(
      (row: any) =>
        row.caseID === row.header_ID && !row.caseID.includes("OUTSIDE"),
    ),
  );
});

for (const c of CASES) {
  test(`${c.typedEntitySet}: assessment is case-bound, fingerprint guarded and retained on READ`, async () => {
    const row = finding({
      list: c.list as any,
      objectKey: c.objectKey,
      nextActionKind: c.nextActionKind as any,
      [c.detailKey]: c.detail,
    } as any);
    await writeFindings("assessment-snapshot", [c.list as any], [row]);
    const caseID = `${c.list}:${c.objectKey}`;
    const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
    const url = `/odata/v4/desk/${c.typedEntitySet}(header_ID='${encodeURIComponent(caseID)}')/PurchasingDeskService.assessPrevention`;
    const stale = await app.axios.post(
      url,
      { metric: "overview", lateDays: 1, expectedFingerprint: "stale" },
      AUTH,
    );
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    const invalid = await app.axios.post(
      url,
      {
        metric: "arbitrary",
        lateDays: 1,
        expectedFingerprint: header.sourceFingerprint,
      },
      AUTH,
    );
    assert.equal(invalid.status, 400);
    const response = await app.axios.post(
      url,
      {
        metric: "overview",
        lateDays: 1,
        expectedFingerprint: header.sourceFingerprint,
      },
      AUTH,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.ok(response.data.assessmentID);
    assert.ok(
      ["available", "insufficient", "unsupported", "failed"].includes(
        response.data.status,
      ),
    );
    assert.ok(Array.isArray(JSON.parse(response.data.metrics)));
    if (c.list === "rare") {
      const labels = JSON.parse(response.data.metrics).map(
        (entry: any) => entry.label,
      );
      assert.ok(
        labels.some((label: string) =>
          /Planning fields|ProcurementType|MRPType/.test(label),
        ),
        labels.join(", "),
      );
      assert.ok(
        labels.some((label: string) =>
          /Delivery-time ranges|delivery P|model P/.test(label),
        ),
        labels.join(", "),
      );
      assert.ok(
        labels.some((label: string) => /Late-delivery|late/i.test(label)),
        labels.join(", "),
      );
    }
    const read = await app.axios.get(
      `/odata/v4/desk/${c.typedEntitySet}(header_ID='${encodeURIComponent(caseID)}')`,
      AUTH,
    );
    assert.equal(read.status, 200, JSON.stringify(read.data));
    const assessment = JSON.parse(read.data.assessmentJson);
    assert.equal(assessment.assessmentID, response.data.assessmentID);
    assert.ok(Array.isArray(assessment.metrics));
    const persisted = await SELECT.one
      .from(`${NS}.PreventionAssessment`)
      .where({ assessmentID: assessment.assessmentID });
    assert.equal(persisted.caseID, caseID);
    assert.equal(
      assessment.expectedFingerprint,
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID }))
        .sourceFingerprint,
    );
  });

  test(`${c.entitySet}: prepareFindingAction and acceptException are reachable as bound OData actions`, async () => {
    const row = finding({
      list: c.list as any,
      objectKey: c.objectKey,
      source: "rule",
      nextActionKind: c.nextActionKind as any,
      [c.detailKey]: c.detail,
    } as any);
    const source = await upsertFinding(row);
    const key = encodeURIComponent(source.ID);

    const retired = await app.axios.post(
      `/odata/v4/desk/${c.entitySet}('${key}')/PurchasingDeskService.prepareFindingAction`,
      {},
      AUTH,
    );
    assert.equal(retired.status, 410, JSON.stringify(retired.data));
    assert.equal((await SELECT.from(`${NS}.Actions`)).length, 0);
    const header = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: source.ID });
    const prepared = await prepareWorkflowCase(header);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
    const preparedID = prepared.data.actionID;
    assert.ok(preparedID, "workflow preparation did not return an action");
    const action = await SELECT.one
      .from(`${NS}.Actions`)
      .where({ ID: preparedID });
    assert.equal(action.status, "needs_decision");
    assert.equal(action.problemKey, source.ID);
    const link = await SELECT.one
      .from(`${NS}.CaseActions`)
      .where({ action_ID: action.ID });
    assert.deepEqual(
      [link.header_ID, link.operation],
      [`${c.list}:${c.objectKey}`, action.operationKey],
    );
    assert.equal(
      (
        await SELECT.from(`${NS}.OperationLocks`).where({
          action_ID: action.ID,
        })
      ).length,
      1,
    );
    assert.equal(
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: link.header_ID }))
        .attention,
      "awaiting_decision",
    );

    // Repeating the reviewed preparation returns the active approval.
    const duplicate = await prepareWorkflowCase(
      await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID }),
    );
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.data));
    assert.equal(duplicate.data.actionID, preparedID);
    assert.equal((await SELECT.from(`${NS}.Actions`)).length, 1);
  });

  test(`${c.entitySet}: acceptException closes the typed case and records its audit event`, async () => {
    const row = finding({
      list: c.list as any,
      objectKey: `${c.objectKey}-EX`,
      source: "rule",
      nextActionKind: c.nextActionKind as any,
      [c.detailKey]: c.detail,
    } as any);
    const source = await upsertFinding(row);
    const key = encodeURIComponent(source.ID);

    const retired = await app.axios.post(
      `/odata/v4/desk/${c.entitySet}('${key}')/PurchasingDeskService.acceptException`,
      {
        note: "Known and accepted",
        reviewOn: "2026-12-01",
        expectedFingerprint: (
          await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })
        ).sourceFingerprint,
      },
      AUTH,
    );
    assert.equal(retired.status, 410, JSON.stringify(retired.data));
    const accepted = await acceptWorkflowException(
      await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID }),
      "Known and accepted",
    );
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.status, "closed");
    const stored = await SELECT.one
      .from(`PurchasingDeskService.${c.typedEntitySet}`)
      .where({ header_ID: source.ID });
    assert.equal(stored.caseStatus, "closed");
    const caseRow = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: `${c.list}:${c.objectKey}-EX` });
    assert.deepEqual(
      [caseRow.status, caseRow.closure, caseRow.closureNote],
      ["closed", "exception_accepted", "Known and accepted"],
    );
    assert.equal(
      (
        await SELECT.from(`${NS}.CaseEvents`).where({
          header_ID: caseRow.ID,
          event: "exception_accepted",
        })
      ).length,
      1,
    );
  });

  test(`${c.entitySet}: prepareAction is reachable from the typed prevention page`, async () => {
    const source = await upsertFinding(
      finding({
        list: c.list as any,
        objectKey: `${c.objectKey}-PREPARE`,
        source: "rule",
        nextActionKind: c.nextActionKind as any,
        [c.detailKey]: c.detail,
      } as any),
    );
    const retired = await app.axios.post(
      `/odata/v4/desk/${c.typedEntitySet}('${encodeURIComponent(source.ID)}')/PurchasingDeskService.prepareAction`,
      {
        expectedFingerprint: (
          await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })
        ).sourceFingerprint,
        ...(c.entitySet === "PriceFindings"
          ? {
              responsiblePerson: "Buyer D01",
              responsibleMessage: "Please clarify this price deviation.",
            }
          : {}),
      },
      AUTH,
    );
    assert.equal(retired.status, 410, JSON.stringify(retired.data));
    const response = await prepareWorkflowCase(
      await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID }),
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(
      (
        await SELECT.one.from(`${NS}.Actions`).where({
          ID: response.data.actionID,
        })
      ).status,
      "needs_decision",
    );
    const reviewed = await app.axios.get(
      `/odata/v4/desk/${c.typedEntitySet}('${encodeURIComponent(source.ID)}')?$expand=header,caseActions($expand=action),caseEvents`,
      AUTH,
    );
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.equal(reviewed.data.caseActions[0].action.status, "needs_decision");
    assert.ok(reviewed.data.header.sourceFingerprint);
  });
}

test("supplier planned-time preparation freezes the selected duration and purchasing source", async () => {
  const entry = CASES.find((row) => row.list === "pdt")!;
  const source = await upsertFinding(
    finding({
      list: "pdt",
      objectKey: "M1|S1|P1",
      nextActionKind: "pdt_change",
      pdtDetail: entry.detail,
    } as any),
  );
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const prepared = await prepareSupplierPilot(header, 21);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: prepared.data.actionID });
  assert.equal(item.newValue, "21");
  assert.equal(item.objectKey, "5500000001");
  assert.equal(item.field, "MaterialPlannedDeliveryDurn");
  const evidence = JSON.parse(item.data);
  assert.equal(evidence.PurchasingInfoRecord, "5500000001");
  assert.equal(evidence.sourceFingerprint, header.sourceFingerprint);
  assert.equal(evidence.proposalDays, 12);
  assert.equal(evidence.selectedDays, 21);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
    "open",
  );
});

async function supplierPilot() {
  const entry = CASES.find((row) => row.list === "pdt")!;
  const row = finding({
    list: "pdt",
    objectKey: "PILOT|S1|P1",
    Material: "PILOT",
    Supplier: "S1",
    itemTitle: "PILOT",
    nextActionKind: "pdt_change",
    pdtDetail: entry.detail,
  } as any);
  const source = await upsertFinding(row);
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const url = `/odata/v4/desk/SupplierPlannedTimes('${encodeURIComponent(source.ID)}')/PurchasingDeskService.prepareAction`;
  return { row, source, header, url };
}

async function prepareSupplierPilot(header: any, days: number) {
  return app.axios.post(
    "/odata/v4/workflow/prepareSupplierPlannedTimeAction",
    {
      caseID: header.ID,
      days,
      commandID: cds.utils.uuid(),
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    AUTH,
  );
}

async function prepareWorkflowCase(
  header: any,
  extra: Record<string, unknown> = {},
) {
  if (header.kind === "supplier_planned_time")
    return prepareSupplierPilot(header, 21);
  return app.axios.post(
    "/odata/v4/workflow/prepareCaseAction",
    {
      caseID: header.ID,
      commandID: cds.utils.uuid(),
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
      ...(header.kind === "price"
        ? {
            responsiblePerson: "Buyer D01",
            responsibleMessage: "Please clarify this price deviation.",
          }
        : {}),
      ...extra,
    },
    AUTH,
  );
}

async function acceptWorkflowException(header: any, note: string) {
  return app.axios.post(
    header.kind === "supplier_planned_time"
      ? "/odata/v4/workflow/acceptSupplierPlannedTimeException"
      : "/odata/v4/workflow/acceptCaseException",
    {
      caseID: header.ID,
      note,
      commandID: cds.utils.uuid(),
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    AUTH,
  );
}

async function approveSupplierPilot(prepared: any) {
  return app.axios.post(
    "/odata/v4/workflow/approveAction",
    {
      actionID: prepared.actionID,
      expectedModifiedAt: prepared.actionModifiedAt,
      commandID: cds.utils.uuid(),
    },
    AUTH,
  );
}

async function reportSupplierPilot(approved: any, note: string) {
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: approved.actionID });
  return app.axios.post(
    "/odata/v4/workflow/recordSupplierPosting",
    {
      actionID: approved.actionID,
      expectedModifiedAt: approved.actionModifiedAt,
      commandID: cds.utils.uuid(),
      completeness: "complete",
      note,
      target: item.objectKey,
      field: item.field,
      value: item.newValue,
    },
    AUTH,
  );
}

async function supplierAssessmentPilot() {
  const pilot = await supplierPilot();
  await cds.ql.INSERT.into("tide.s4.Product").entries({
    Product: "PILOT",
    ProductType: "HAWA",
    ProductGroup: "G1",
    BaseUnit: "EA",
  });
  await cds.ql.INSERT.into("tide.s4.ProductPlantSupplyPlanning").entries({
    Product: "PILOT",
    Plant: "P1",
    ProcurementType: "F",
    PlannedDeliveryDurationInDays: 5,
  });
  await cds.ql.INSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder: "EVIPILOT",
    PurchaseOrderDate: "2026-09-01",
    Supplier: "S1",
    PurchasingGroup: "001",
  });
  await cds.ql.INSERT.into("tide.s4.PurchaseOrderItem").entries({
    PurchaseOrder: "EVIPILOT",
    PurchaseOrderItem: "10",
    Material: "PILOT",
    Plant: "P1",
  });
  await cds.ql.INSERT.into(`${NS}.ItemFact`).entries(
    Array.from({ length: 30 }, (_, index) => ({
      PurchaseOrder: index === 0 ? "EVIPILOT" : `EVIP${index}`,
      PurchaseOrderItem: "10",
      Material: "PILOT",
      Supplier: "S1",
      Plant: "P1",
      PurchasingGroup: "001",
      MaterialGroup: "G1",
      MaterialType: "HAWA",
      OrderQuantity: 1,
      NetAmountEUR: 100,
      PurchaseOrderDate: "2026-09-01",
      AvailableDate: "2026-09-25",
      LeadTimeDays: 10 + (index % 3),
      IsOpen: false,
    })),
  );
  await cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
    .set({ loadId: cds.utils.uuid(), loadedAt: "2026-10-05T00:00:00.000Z" })
    .where({ ID: "current" });
  const assessUrl = `/odata/v4/desk/SupplierPlannedTimes('${encodeURIComponent(pilot.source.ID)}')/PurchasingDeskService.assessPrevention`;
  return { ...pilot, assessUrl };
}

test("supplier assessment revisions retain provenance and prepared evidence through reassessment and unavailable results", async () => {
  const { source, header, assessUrl } = await supplierAssessmentPilot();
  const first = await app.axios.post(
    assessUrl,
    { expectedFingerprint: header.sourceFingerprint },
    AUTH,
  );
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.status, "available", JSON.stringify(first.data));
  assert.equal(first.data.source, "fake");
  const retained = await SELECT.one
    .from(`${NS}.PreventionAssessment`)
    .where({ assessmentID: first.data.assessmentID });
  verifyAssessmentRevision(retained);
  assert.ok(retained.sourceLoadId);
  assert.equal(retained.sourceLoadedAt, "2026-10-05T00:00:00.000Z");
  assert.ok(retained.run_ID);
  const reviewed = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: source.ID });
  const prepared = await app.axios.post(
    "/odata/v4/workflow/prepareSupplierPlannedTimeAction",
    {
      caseID: source.ID,
      days: 21,
      commandID: cds.utils.uuid(),
      expectedModifiedAt: reviewed.modifiedAt,
      expectedFingerprint: first.data.expectedFingerprint,
    },
    AUTH,
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: prepared.data.actionID });
  const frozen = JSON.parse(item.data).assessment;
  assert.equal(frozen.evidenceRevision.payloadHash, retained.payloadHash);
  const second = await app.axios.post(
    assessUrl,
    { expectedFingerprint: first.data.expectedFingerprint },
    AUTH,
  );
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.status, "available", JSON.stringify(second.data));
  assert.notEqual(second.data.assessmentID, first.data.assessmentID);
  assert.deepEqual(
    await SELECT.one
      .from(`${NS}.PreventionAssessment`)
      .where({ assessmentID: retained.assessmentID }),
    retained,
  );
  await cds.ql.UPDATE.entity("tide.s4.ProductPlantSupplyPlanning")
    .set({ ProcurementType: "E" })
    .where({ Product: "PILOT" });
  const unavailable = await app.axios.post(
    assessUrl,
    { expectedFingerprint: second.data.expectedFingerprint },
    AUTH,
  );
  assert.equal(unavailable.status, 200, JSON.stringify(unavailable.data));
  assert.equal(unavailable.data.status, "unsupported");
  assert.equal(
    unavailable.data.expectedFingerprint,
    second.data.expectedFingerprint,
  );
  assert.equal(
    (await latestAssessment(source.ID, second.data.expectedFingerprint))
      ?.assessmentID,
    second.data.assessmentID,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.PreventionAssessment`).where({
        caseID: source.ID,
      })
    ).length,
    3,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.ActionItems`).where({ ID: item.ID })).data,
    item.data,
  );
  await cds.ql.UPDATE.entity(`${NS}.PreventionAssessment`)
    .set({ summary: "Changed retained evidence" })
    .where({ assessmentID: second.data.assessmentID });
  await assert.rejects(
    () => latestAssessment(source.ID, second.data.expectedFingerprint),
    /integrity verification/,
  );
  const corruptedRead = await app.axios.get(
    `/odata/v4/desk/SupplierPlannedTimes('${encodeURIComponent(source.ID)}')`,
    AUTH,
  );
  assert.equal(corruptedRead.status, 409, JSON.stringify(corruptedRead.data));
  assert.match(corruptedRead.data.error.message, /integrity verification/);
});

test("versioned assessment applicability survives unchanged refresh and expires on a source change without rewriting evidence", async () => {
  const { row, source, header, assessUrl } = await supplierAssessmentPilot();
  const response = await app.axios.post(
    assessUrl,
    { expectedFingerprint: header.sourceFingerprint },
    AUTH,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const retained = await SELECT.one
    .from(`${NS}.PreventionAssessment`)
    .where({ assessmentID: response.data.assessmentID });
  await cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
    .set({ source: "synthetic" })
    .where({ ID: "current" });
  await cds.ql.UPDATE.entity(`${NS}.Cases`)
    .set({ sourceFingerprint: header.sourceFingerprint })
    .where({ ID: source.ID });
  assert.equal(await relinkPreparedAssessments(), 1);
  assert.equal(await relinkPreparedAssessments(), 0);
  const bound = await latestAssessment(source.ID, header.sourceFingerprint);
  assert.equal(bound?.assessmentID, retained.assessmentID);
  verifyAssessmentRevision(bound!);
  assert.equal(bound?.evidenceFingerprint, retained.expectedFingerprint);
  const read = await app.axios.get(
    `/odata/v4/desk/SupplierPlannedTimes('${encodeURIComponent(source.ID)}')`,
    AUTH,
  );
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(
    JSON.parse(read.data.assessmentJson).evidenceRevision.expectedFingerprint,
    retained.expectedFingerprint,
  );
  await upsertTypedCase(row);
  assert.equal(
    (await latestAssessment(source.ID, header.sourceFingerprint))?.assessmentID,
    retained.assessmentID,
  );
  await upsertTypedCase({
    ...row,
    pdtDetail: { ...(row as any).pdtDetail, currentDays: 6 },
  } as any);
  const changed = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  assert.notEqual(changed.sourceFingerprint, header.sourceFingerprint);
  assert.equal(
    await latestAssessment(source.ID, changed.sourceFingerprint),
    undefined,
  );
  assert.deepEqual(
    await SELECT.one
      .from(`${NS}.PreventionAssessment`)
      .where({ assessmentID: retained.assessmentID }),
    retained,
  );
});

test("concurrent supplier assessments publish one revision for the reviewed fingerprint", async () => {
  const { source, header, assessUrl } = await supplierAssessmentPilot();
  const responses: {
    status: number;
    data: { assessmentID?: string; expectedFingerprint?: string };
  }[] = await Promise.all(
    Array.from({ length: 2 }, () =>
      app.axios.post(
        assessUrl,
        { expectedFingerprint: header.sourceFingerprint },
        AUTH,
      ),
    ),
  );
  assert.equal(
    responses.filter((response) => response.status === 200).length,
    1,
    JSON.stringify(responses.map((response) => response.data)),
  );
  assert.equal(
    responses.filter((response) => response.status === 409).length,
    1,
  );
  const committed = responses.find((response) => response.status === 200)!;
  const revisions = await SELECT.from(`${NS}.PreventionAssessment`).where({
    caseID: source.ID,
  });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].assessmentID, committed.data.assessmentID);
  assert.equal(
    (await latestAssessment(source.ID, committed.data.expectedFingerprint!))
      ?.assessmentID,
    committed.data.assessmentID,
  );
});

test("supplier assessment publication failure preserves the last good revision and Case history", async () => {
  const { source, header, assessUrl } = await supplierAssessmentPilot();
  const first = await app.axios.post(
    assessUrl,
    { expectedFingerprint: header.sourceFingerprint },
    AUTH,
  );
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const retained = await SELECT.one
    .from(`${NS}.PreventionAssessment`)
    .where({ assessmentID: first.data.assessmentID });
  const before = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const events = await SELECT.from(`${NS}.CaseEvents`).where({
    header_ID: source.ID,
  });
  let rejectInsert = true;
  cds.db.after("CREATE", `${NS}.PreventionAssessment`, () => {
    if (rejectInsert) throw new Error("assessment publication rollback probe");
  });
  try {
    const rejected = await app.axios.post(
      assessUrl,
      { expectedFingerprint: first.data.expectedFingerprint },
      AUTH,
    );
    assert.equal(rejected.status, 500, JSON.stringify(rejected.data));
  } finally {
    rejectInsert = false;
  }
  assert.deepEqual(
    await SELECT.from(`${NS}.PreventionAssessment`).where({
      caseID: source.ID,
    }),
    [retained],
  );
  assert.deepEqual(
    await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID }),
    before,
  );
  assert.deepEqual(
    await SELECT.from(`${NS}.CaseEvents`).where({ header_ID: source.ID }),
    events,
  );
  assert.equal(
    (await latestAssessment(source.ID, first.data.expectedFingerprint))
      ?.assessmentID,
    retained.assessmentID,
  );
});

test("supplier assessment rejects same-date source changes without publishing a revision or changing the Case", async () => {
  const { source, header, assessUrl } = await supplierAssessmentPilot();
  const before = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const events = await SELECT.from(`${NS}.CaseEvents`).where({
    header_ID: source.ID,
  });
  const nextLoad = cds.utils.uuid();
  beforeModelResponse = () =>
    cds.tx(async () => {
      await cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
        .set({ loadId: nextLoad })
        .where({ ID: "current" });
    });
  const response = await app.axios.post(
    assessUrl,
    { expectedFingerprint: header.sourceFingerprint },
    AUTH,
  );
  assert.equal(response.status, 409, JSON.stringify(response.data));
  assert.match(response.data.error.message, /Imported source changed/);
  assert.equal(
    (
      await SELECT.from(`${NS}.PreventionAssessment`).where({
        caseID: source.ID,
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.AssessmentApplicability`).where({
        caseID: source.ID,
      })
    ).length,
    0,
  );
  assert.deepEqual(
    await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID }),
    before,
  );
  assert.deepEqual(
    await SELECT.from(`${NS}.CaseEvents`).where({ header_ID: source.ID }),
    events,
  );
  assert.equal(
    (await SELECT.one.from("tide.s4.DatasetInfo").where({ ID: "current" }))
      .loadId,
    nextLoad,
  );
});

test("supplier pilot shares source, typed and tool preparation while rejecting conflicting selections", async () => {
  const { source, header } = await supplierPilot();
  const url = "/odata/v4/workflow/prepareSupplierPlannedTimeAction";
  const selected = {
    caseID: source.ID,
    days: 21,
    expectedFingerprint: header.sourceFingerprint,
    expectedModifiedAt: header.modifiedAt,
    commandID: cds.utils.uuid(),
  };
  const first = await app.axios.post(url, selected, AUTH);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const agent = await cds.connect.to("CockpitMcpService");
  const user = new cds.User({
    id: "ilyesse.hettenbach@cbs-consulting.de",
    attr: {},
    roles: ["user", "admin"],
  });
  const tool = await cds.tx({ user }, () =>
    agent.send("prepare_case_action", selected),
  );
  assert.equal(tool.actionID, first.data.actionID);
  await assert.rejects(
    cds.tx({ user }, () =>
      agent.send("prepare_case_action", { caseID: source.ID, days: 21 }),
    ),
    (error: any) =>
      [error, ...(error.details ?? [])].some(
        (entry: any) =>
          Number(entry.status ?? entry.statusCode ?? entry.code) === 400,
      ),
  );
  const compatible = await app.axios.post(
    "/odata/v4/desk/SourceFindings(Material='PILOT',Supplier='S1',Plant='P1')/PurchasingDeskService.addToChangeList",
    { days: 21 },
    AUTH,
  );
  assert.equal(compatible.status, 410, JSON.stringify(compatible.data));
  const changed = await app.axios.post(url, { ...selected, days: 22 }, AUTH);
  assert.equal(changed.status, 409);
  assert.equal((await SELECT.from(`${NS}.Actions`)).length, 1);
  assert.equal((await SELECT.from(`${NS}.OperationLocks`)).length, 1);
});

test("supplier pilot rejects invalid, stale and unauthorized preparation without writes and rolls back failures", async () => {
  const { source, header } = await supplierPilot();
  const url = "/odata/v4/workflow/prepareSupplierPlannedTimeAction";
  const payload = {
    caseID: source.ID,
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  for (const days of [0, 5, 366, 2.5]) {
    const response = await app.axios.post(
      url,
      { ...payload, days, commandID: cds.utils.uuid() },
      AUTH,
    );
    assert.equal(response.status, 400, JSON.stringify(response.data));
  }
  assert.equal(
    (
      await app.axios.post(
        url,
        {
          ...payload,
          days: 21,
          expectedFingerprint: "stale",
          commandID: cds.utils.uuid(),
        },
        AUTH,
      )
    ).status,
    409,
  );
  const foreign = {
    ...AUTH,
    auth: { username: "buyerD07", password: "buyerD07" },
  };
  assert.equal(
    (
      await app.axios.post(
        url,
        { ...payload, days: 21, commandID: cds.utils.uuid() },
        foreign,
      )
    ).status,
    404,
  );
  await assert.rejects(
    cds.tx({ user: cds.User.privileged }, async () => {
      const workflow = await cds.connect.to("WorkflowService");
      await workflow.send("prepareSupplierPlannedTimeAction", {
        ...payload,
        days: 21,
        commandID: cds.utils.uuid(),
      });
      throw new Error("supplier rollback probe");
    }),
    /supplier rollback probe/,
  );
  for (const entity of [
    "Actions",
    "ActionItems",
    "CaseActions",
    "OperationLocks",
    "ActionEvents",
  ])
    assert.equal((await SELECT.from(`${NS}.${entity}`)).length, 0, entity);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
    "open",
  );
});

test("supplier pilot racing HTTP preparations reserve one active operation", async () => {
  const { header } = await supplierPilot();
  const responses: { status: number; data: { actionID?: string } }[] =
    await Promise.all(
      Array.from({ length: 4 }, () =>
        app.axios.post(
          "/odata/v4/workflow/prepareSupplierPlannedTimeAction",
          {
            caseID: header.ID,
            days: 21,
            expectedFingerprint: header.sourceFingerprint,
            expectedModifiedAt: header.modifiedAt,
            commandID: cds.utils.uuid(),
          },
          AUTH,
        ),
      ),
    );
  assert.ok(
    responses.every((response) => [200, 409].includes(response.status)),
    JSON.stringify(responses.map((response) => response.data)),
  );
  const actions = await SELECT.from(`${NS}.Actions`);
  assert.equal(actions.length, 1);
  assert.ok(responses.some((response) => response.status === 200));
  assert.ok(
    responses
      .filter((response) => response.status === 200)
      .every((response) => response.data.actionID === actions[0].ID),
  );
  for (const entity of ["ActionItems", "CaseActions", "OperationLocks"])
    assert.equal((await SELECT.from(`${NS}.${entity}`)).length, 1, entity);
});

test("supplier pilot retains frozen evidence, rejects stale approval and allows decline then fresh preparation", async () => {
  const { row, source, header } = await supplierPilot();
  const first = await prepareSupplierPilot(header, 21);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: first.data.actionID });
  await upsertFinding({
    ...row,
    pdtDetail: { ...row.pdtDetail!, currentDays: 6 },
  });
  const beforeEvents = await SELECT.from(`${NS}.ActionEvents`);
  const stale = await approveSupplierPilot(first.data);
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.deepEqual(await SELECT.from(`${NS}.ActionEvents`), beforeEvents);
  assert.equal(
    (await SELECT.one.from(`${NS}.ActionItems`).where({ ID: item.ID })).data,
    item.data,
  );
  const blank = await app.axios.post(
    "/odata/v4/workflow/declineAction",
    {
      actionID: first.data.actionID,
      expectedModifiedAt: first.data.actionModifiedAt,
      commandID: cds.utils.uuid(),
      note: " ",
    },
    AUTH,
  );
  assert.equal(blank.status, 400);
  const declined = await app.axios.post(
    "/odata/v4/workflow/declineAction",
    {
      actionID: first.data.actionID,
      expectedModifiedAt: first.data.actionModifiedAt,
      commandID: cds.utils.uuid(),
      note: "Evidence changed; review again",
    },
    AUTH,
  );
  assert.equal(declined.status, 200, JSON.stringify(declined.data));
  const current = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const fresh = await prepareSupplierPilot(current, 22);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.notEqual(fresh.data.actionID, first.data.actionID);
  assert.equal(current.status, "open");
});

test("supplier pilot resolves only from a unique matching refreshed source, never approval or recorded work", async () => {
  const { source, header } = await supplierPilot();
  const first = await prepareSupplierPilot(header, 21);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const approved = await approveSupplierPilot(first.data);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, "waiting");
  const exported = await app.axios.get(
    `/odata/v4/desk/exportAction(ID=${first.data.actionID})`,
    AUTH,
  );
  assert.equal(exported.status, 410, JSON.stringify(exported.data));
  const inspected = await app.axios.get(
    `/odata/v4/desk/Actions('${first.data.actionID}')?$expand=items,actionEvents`,
    AUTH,
  );
  assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
  assert.equal(inspected.data.items[0].newValue, "21");
  assert.ok(
    inspected.data.actionEvents.some(
      (event: any) => event.event === "approved",
    ),
  );
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
    "open",
  );
  await cds.ql.INSERT.into("tide.s4.PurgInfoRecdOrgPlantData").entries({
    PurchasingInfoRecord: "5500000001",
    PurchasingInfoRecordCategory: "0",
    PurchasingOrganization: "1000",
    Material: "PILOT",
    Supplier: "S1",
    Plant: "P1",
    MaterialPlannedDeliveryDurn: 20,
  });
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  const recorded = await reportSupplierPilot(
    approved.data,
    "Buyer recorded the exact instruction; reference LOCAL-1",
  );
  assert.equal(recorded.status, 200, JSON.stringify(recorded.data));
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
    "open",
  );
  await cds.ql.UPDATE.entity("tide.s4.PurgInfoRecdOrgPlantData")
    .set({ MaterialPlannedDeliveryDurn: 21 })
    .where({ Material: "PILOT" });
  await cds.ql.INSERT.into("tide.s4.PurgInfoRecdOrgPlantData").entries({
    PurchasingInfoRecord: "5500000001",
    PurchasingInfoRecordCategory: "0",
    PurchasingOrganization: "2000",
    Material: "PILOT",
    Supplier: "S1",
    Plant: "P1",
    MaterialPlannedDeliveryDurn: 21,
  });
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  await DELETE.from("tide.s4.PurgInfoRecdOrgPlantData").where({
    Material: "PILOT",
    PurchasingOrganization: "2000",
  });
  await cds.ql.UPDATE.entity("tide.s4.PurgInfoRecdOrgPlantData")
    .set({ IsMarkedForDeletion: true })
    .where({ Material: "PILOT" });
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  await cds.ql.UPDATE.entity("tide.s4.PurgInfoRecdOrgPlantData")
    .set({ IsMarkedForDeletion: false })
    .where({ Material: "PILOT" });
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  await upsertRows({
    PurgInfoRecdOrgPlantData: [
      {
        PurchasingInfoRecord: "5500000001",
        PurchasingInfoRecordCategory: "0",
        PurchasingOrganization: "1000",
        Plant: "P1",
        Material: "PILOT",
        Supplier: "S1",
      },
    ],
  });
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  await upsertRows({
    PurgInfoRecdOrgPlantData: [
      {
        PurchasingInfoRecord: "5500000001",
        PurchasingInfoRecordCategory: "0",
        PurchasingOrganization: "1000",
        Plant: "P1",
        Material: "PILOT",
        Supplier: "S1",
        MaterialPlannedDeliveryDurn: 21,
      },
    ],
  });
  assert.equal(
    await cds.tx({ user: cds.User.privileged }, () =>
      reconcileSupplierPlannedTimes(),
    ),
    1,
  );
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  const closed = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  assert.equal(closed.closure, "resolved_at_source");
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: source.ID,
        event: "source_resolved",
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.ActionItems`)
        .where({ action_ID: first.data.actionID })
    ).newValue,
    "21",
  );
});

test("supplier pilot ignores superseded instructions and malformed evidence during source reconciliation", async () => {
  const { source, header } = await supplierPilot();
  const first = await prepareSupplierPilot(header, 21);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const approved = await approveSupplierPilot(first.data);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const recorded = await reportSupplierPilot(
    approved.data,
    "Buyer recorded earlier exact work; reference LOCAL-2",
  );
  assert.equal(recorded.status, 200, JSON.stringify(recorded.data));
  const current = await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID });
  const next = await prepareSupplierPilot(current, 22);
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.notEqual(next.data.actionID, first.data.actionID);
  await cds.ql.INSERT.into("tide.s4.PurgInfoRecdOrgPlantData").entries({
    PurchasingInfoRecord: "5500000001",
    PurchasingInfoRecordCategory: "0",
    PurchasingOrganization: "1000",
    Material: "PILOT",
    Supplier: "S1",
    Plant: "P1",
    MaterialPlannedDeliveryDurn: 21,
  });
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
    "open",
  );
  const observed = {
    PurgInfoRecdOrgPlantData: [
      {
        PurchasingInfoRecord: "5500000001",
        PurchasingInfoRecordCategory: "0",
        PurchasingOrganization: "1000",
        Plant: "P1",
        Material: "PILOT",
        Supplier: "S1",
        MaterialPlannedDeliveryDurn: 22,
      },
    ],
  };
  await upsertRows(observed);
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  assert.equal((await approveSupplierPilot(next.data)).status, 200);
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: next.data.actionID });
  await cds.ql.UPDATE.entity(`${NS}.ActionItems`)
    .set({ data: "{" })
    .where({ ID: item.ID });
  assert.equal(await cds.tx(() => reconcileSupplierPlannedTimes()), 0);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
    "open",
  );
  await cds.ql.UPDATE.entity(`${NS}.ActionItems`)
    .set({ data: item.data })
    .where({ ID: item.ID });
  assert.equal(
    await cds.tx(() => reconcileSupplierPlannedTimes()),
    0,
    "an observation before approval is not fresh fulfillment proof",
  );
  await upsertRows(observed);
  assert.equal(
    await cds.tx({ user: cds.User.privileged }, () =>
      reconcileSupplierPlannedTimes(),
    ),
    1,
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.ActionItems`)
        .where({ action_ID: first.data.actionID })
    ).newValue,
    "21",
  );
});

test(
  "supplier pilot browser selects, prepares, inspects and approves without resolving the source case",
  { skip: !process.env.CDS_UI_BROWSER },
  async () => {
    const { source } = await supplierPilot();
    const result = await promisify(execFile)(
      "node",
      [
        path.join(__dirname, "browser", "supplier-planned-time.mjs"),
        app.url,
        source.ID,
      ],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
    );
    console.log(result.stdout, result.stderr);
    const action = await SELECT.one.from(`${NS}.Actions`);
    assert.equal(action.status, "waiting");
    assert.equal(
      (
        await SELECT.one
          .from(`${NS}.ActionItems`)
          .where({ action_ID: action.ID })
      ).newValue,
      "21",
    );
    assert.equal(
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
      "open",
    );
    const receipt = await SELECT.one
      .from("tide.workflow.WorkflowCommands")
      .where({ commandType: "prepareSupplierPlannedTimeAction" });
    assert.equal(JSON.parse(receipt.result).actionID, action.ID);
    const approval = await SELECT.one
      .from("tide.workflow.WorkflowCommands")
      .where({ commandType: "approveAction" });
    assert.equal(JSON.parse(approval.result).actionID, action.ID);
    assert.equal(
      (
        await SELECT.from(`${NS}.ActionEvents`).where({
          action_ID: action.ID,
          event: "approved",
          command_ID: approval.ID,
        })
      ).length,
      1,
    );
    assert.equal(
      (
        await SELECT.from("tide.workflow.SubjectClaims").where({
          actionID: action.ID,
        })
      ).length,
      1,
    );
    const observation = await SELECT.one
      .from("tide.workflow.OutcomeObservations")
      .where({ actionID: action.ID });
    assert.equal(observation.completeness, "unknown");
    assert.equal(observation.origin, "user_report");
    assert.ok(observation.command_ID);
  },
);

test("typed planned-time evidence exposes retained quantiles and the material proposal rule", async () => {
  for (const entry of CASES.filter((row) =>
    ["pdt", "mm_pdt"].includes(row.list),
  )) {
    const source = await upsertFinding(
      finding({
        list: entry.list,
        objectKey: entry.objectKey,
        source: "rule",
        nextActionKind: entry.nextActionKind,
        [entry.detailKey]: entry.detail,
      } as any),
    );
    const response = await app.axios.get(
      `/odata/v4/desk/${entry.typedEntitySet}('${encodeURIComponent(source.ID)}')`,
      AUTH,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    if (entry.list === "pdt") {
      assert.deepEqual(
        [
          response.data.rangeP10,
          response.data.rangeP50,
          response.data.rangeP80,
          response.data.rangeP90,
          response.data.rangeSource,
        ],
        [3, 8, 12, 15, "empirical"],
      );
    } else {
      assert.equal(response.data.proposalRule, "order-share weighted median");
    }
    await cds.ql.UPDATE.entity(`${NS}.${entry.typedEntitySet}`)
      .set({ detail: "null" })
      .where({ header_ID: source.ID });
    const missing = await app.axios.get(
      `/odata/v4/desk/${entry.typedEntitySet}('${encodeURIComponent(source.ID)}')`,
      AUTH,
    );
    assert.equal(missing.status, 200);
    assert.equal(
      entry.list === "pdt" ? missing.data.rangeP50 : missing.data.proposalRule,
      null,
    );
  }
});

test("DuplicateMaterials: review snapshots candidate similarity and activity without merging materials", async () => {
  const source = await upsertFinding(
    finding({
      list: "duplicate",
      objectKey: "SNAPSHOT",
      nextActionKind: "mdg_case",
      duplicateDetail: {
        candidateCount: 2,
        materialNumbers: "A,B",
        materialType: "ROH",
      },
    } as any),
  );
  await cds.ql.INSERT.into(`${NS}.RuleLine`).entries([
    {
      findingID: source.ID,
      line: 1,
      kind: "member",
      label: "A",
      text: "Bearing 6204",
      similarityScore: 100,
      n1: 5,
      n2: 2,
    },
    {
      findingID: source.ID,
      line: 2,
      kind: "member",
      label: "B",
      text: "Bearring 6204",
      similarityScore: 95,
      n1: 3,
      n2: 1,
    },
  ]);
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const response = await prepareWorkflowCase(header);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: response.data.actionID });
  const snapshot = JSON.parse(item.data);
  assert.equal(snapshot.candidates[1].similarityScore, 95);
  assert.equal(snapshot.candidates[1].n1, 3);
  assert.match(snapshot.similarityBasis, /not duplicate probability/);
  await cds.ql.UPDATE.entity(`${NS}.RuleLine`)
    .set({ similarityScore: 90 })
    .where({ findingID: source.ID, line: 2 });
  assert.equal(
    (await SELECT.one.from(`${NS}.ActionItems`).where({ ID: item.ID })).data,
    item.data,
  );
});

test("PriceDeviations: prepareAction accepts the responsible-person dialog payload", async () => {
  const source = await upsertFinding(
    finding({
      list: "price",
      objectKey: "ASK1/10",
      source: "rule",
      nextActionKind: "price_clarification",
      priceDetail: {
        unitPrice: 100,
        priorMedian: 10,
        priorCount: 3,
        ratio: 10,
        factor: 10,
        direction: "higher",
        priceKey: "M|P",
        currentPrice: 100,
        priceQuantity: 1,
        proposalPrice: 10,
        currency: "EUR",
      },
    } as any),
  );
  const response = await prepareWorkflowCase(
    await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID }),
    {
      responsiblePerson: "Buyer D01",
      responsibleMessage: "Please explain this price deviation.",
    },
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const action = await SELECT.one
    .from(`${NS}.Actions`)
    .where({ ID: response.data.actionID });
  assert.deepEqual(
    [action.responsiblePerson, action.responsibleMessage],
    ["Buyer D01", "Please explain this price deviation."],
  );
});

test("PriceDeviations: typed clarification retains model range, provenance and empirical evidence", async () => {
  const source = await upsertFinding(
    finding({
      list: "price",
      objectKey: "MODEL/10",
      PurchaseOrder: "MODEL",
      PurchaseOrderItem: "10",
      source: "tabpfn",
      nextActionKind: "price_clarification",
      priceDetail: {
        unitPrice: 20,
        currentPrice: 200,
        priceQuantity: 10,
        currency: "EUR",
        priorMedian: 9,
        priorCount: 24,
        expectedP10: 8,
        expectedP50: 10,
        expectedP90: 12,
        assessmentSource: "tabpfn",
        assessmentRunID: "retained-model-run",
        calibrationStatus: "calibrated",
      },
    } as any),
  );
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const response = await prepareWorkflowCase(header, {
    responsiblePerson: "Buyer D01",
    responsibleMessage: "Clarify the model price discrepancy.",
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: response.data.actionID });
  const data = JSON.parse(item.data);
  assert.equal(item.oldValue, "200");
  assert.equal(item.newValue, "100");
  assert.equal(data.source, "tabpfn");
  assert.equal(data.modelEvidence.runID, "retained-model-run");
  assert.equal(data.modelEvidence.expectedP90, 12);
  assert.equal(data.empiricalEvidence.median, 9);
  assert.equal(data.empiricalEvidence.observations, 24);
});

test("PriceDeviations: responsible-person action parameters have buyer-facing labels", async () => {
  const service = (await cds.load(
    path.join(__dirname, "..", "srv", "purchasing-desk-service"),
  )) as any;
  const action =
    service.definitions["PurchasingDeskService.PriceDeviations"].actions
      .prepareAction;
  assert.equal(action.params.responsiblePerson["@title"], "Responsible person");
  assert.equal(
    action.params.responsibleMessage["@title"],
    "Clarification needed",
  );
});

test("PriceDeviations: custom action card is the only action entry point", async () => {
  const annotations = (await cds.load(
    path.join(
      __dirname,
      "..",
      "app",
      "purchasing-desk",
      "annotations",
      "typedcases",
    ),
  )) as any;
  const price =
    annotations.definitions["PurchasingDeskService.PriceDeviations"];
  assert.equal(price["@UI.Identification"], undefined);
});

test("PriceDeviations: acceptException closes the typed price case", async () => {
  const source = await upsertFinding(
    finding({
      list: "price",
      objectKey: "ACCEPT1/10",
      source: "rule",
      nextActionKind: "price_clarification",
      priceDetail: {
        unitPrice: 100,
        priorMedian: 10,
        priorCount: 3,
        ratio: 10,
        factor: 10,
        direction: "higher",
        priceKey: "M|P",
        currentPrice: 100,
        priceQuantity: 1,
        proposalPrice: 10,
        currency: "EUR",
      },
    } as any),
  );
  const reviewed = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: source.ID });
  const legacy = await app.axios.post(
    `/odata/v4/desk/PriceDeviations('${encodeURIComponent(source.ID)}')/PurchasingDeskService.acceptException`,
    {
      note: "Price is contractually agreed",
      expectedFingerprint: reviewed.sourceFingerprint,
    },
    AUTH,
  );
  assert.equal(legacy.status, 410);
  const response = await app.axios.post(
    "/odata/v4/workflow/acceptCaseException",
    {
      caseID: source.ID,
      commandID: "typed-price-accept",
      expectedModifiedAt: reviewed.modifiedAt,
      note: "Price is contractually agreed",
      expectedFingerprint: reviewed.sourceFingerprint,
    },
    AUTH,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const caseRow = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  assert.deepEqual(
    [caseRow.status, caseRow.closure, caseRow.closureNote],
    ["closed", "exception_accepted", "Price is contractually agreed"],
  );
});

test("exception acceptance rejects the stale buyer fingerprint over OData", async () => {
  const row = finding({
    list: "price",
    objectKey: "STALE/10",
    source: "rule",
    priceDetail: { currentPrice: 100, priorMedian: 10 },
  } as any);
  const source = await upsertFinding(row);
  const prior = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  await upsertFinding({
    ...row,
    priceDetail: { currentPrice: 200, priorMedian: 10 },
  } as any);
  const current = await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID });
  const response = await app.axios.post(
    "/odata/v4/workflow/acceptCaseException",
    {
      caseID: source.ID,
      commandID: "stale-price-accept",
      expectedModifiedAt: current.modifiedAt,
      note: "Reviewed earlier",
      expectedFingerprint: prior.sourceFingerprint,
    },
    AUTH,
  );
  assert.equal(response.status, 409);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: source.ID })).status,
    "open",
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: source.ID,
        event: "exception_accepted",
      })
    ).length,
    0,
  );
});
