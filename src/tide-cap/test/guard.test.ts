// Guard (T8b): buyer scope on Findings, me(), budget ledger (atomic, 429
// beyond the limit, dry run records nothing), buyers from the order book.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import { finding, seedFixtures } from "./fixtures/cockpit";
import * as ledger from "../srv/cockpit/guard/ledger";
import { step } from "../srv/cockpit/guard";
import { prepareAction } from "../srv/cockpit/kernel/actions";
import { ensureCase } from "../srv/cockpit/kernel/cases";
import { useFakeTabular } from "./fixtures/tabular";

useFakeTabular();

const { DELETE, SELECT, INSERT, UPSERT } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const as = (u: string) => ({
  auth: {
    username: u,
    password: u === "ilyesse.hettenbach@cbs-consulting.de" ? "alice" : u,
  },
  validateStatus: () => true,
});
const API = "/odata/v4/desk";
const WORKFLOW = "/odata/v4/workflow";

before(async () => {
  await app;
});

beforeEach(async () => {
  for (const e of [
    "ApprovalLock",
    "ApprovalEvent",
    "ProblemEvent",
    "FindingEvidence",
    "ActionItems",
    "Actions",
    "Problem",
    "Finding",
    "Buyer",
    "BudgetLedger",
    "BudgetEntry",
    "Snapshot",
    "SalesOrderImpact",
    "ProductionOrderImpact",
    "RuleLine",
    "MmPdtSource",
    "MmPdtDetail",
    "ItemImpact",
    "OpenItem",
  ])
    await DELETE.from(`${NS}.${e}`);
  delete process.env.TIDE_BUDGET;
  await seedFixtures(cds.db, {
    findings: [
      finding({
        objectKey: "4500000001/10",
        PurchaseOrder: "4500000001",
        PurchasingGroup: "D01",
        Plant: "DE11",
      }),
      finding({
        list: "overdue",
        objectKey: "4500000003/10",
        PurchaseOrder: "4500000003",
        PurchasingGroup: "D01",
        Plant: "DE11",
      }),
      finding({
        objectKey: "4500000002/10",
        PurchaseOrder: "4500000002",
        PurchasingGroup: "D07",
        Plant: "DE31",
      }),
      finding({
        list: "mm_pdt",
        objectKey: "M9|DE11",
        PurchaseOrder: null,
        PurchasingGroup: "D01",
        Plant: "DE11",
      } as any),
    ],
  });
});

test("an authenticated non-admin without buyer attributes is denied business data", async () => {
  const identity = await app.axios.get(`${API}/me()`, as("carol"));
  assert.equal(identity.status, 200);
  assert.equal(identity.data.isAdmin, false);
  assert.equal(identity.data.PurchasingGroup, null);
  assert.equal(identity.data.Plant, null);
  assert.equal(identity.data.mockAuthentication, true);
  for (const resource of ["Findings", "Cases", "Customers", "overview()"]) {
    const response = await app.axios.get(`${API}/${resource}`, as("carol"));
    assert.equal(response.status, 403, resource);
  }
});

test("impact and finding details enforce scope on lists, keys, counts, navigation and expansion", async () => {
  for (const [PurchaseOrder, PurchasingGroup, Plant] of [
    ["4500000001", "D01", "DE11"],
    ["4500000002", "D07", "DE31"],
  ]) {
    const item = { PurchaseOrder, PurchaseOrderItem: "10" };
    const findingID = `at_risk:${PurchaseOrder}/10`;
    await UPSERT.into("tide.s4.PurchaseOrder").entries({
      PurchaseOrder,
      PurchasingGroup,
    });
    await UPSERT.into("tide.s4.PurchaseOrderItem").entries({ ...item, Plant });
    await INSERT.into(`${NS}.OpenItem`).entries({
      ...item,
      PurchasingGroup,
      Plant,
    });
    await INSERT.into(`${NS}.ItemImpact`).entries(item);
    await INSERT.into(`${NS}.SalesOrderImpact`).entries({
      ...item,
      SalesOrder: "SO1",
      SalesOrderItem: "10",
    });
    await INSERT.into(`${NS}.ProductionOrderImpact`).entries({
      ...item,
      ProductionOrder: "PROD1",
    });
    await INSERT.into(`${NS}.RuleLine`).entries({
      findingID,
      line: 1,
      label: PurchaseOrder,
    });
    await INSERT.into(`${NS}.MmPdtDetail`).entries({ finding_ID: findingID });
    await INSERT.into(`${NS}.MmPdtSource`).entries({
      finding_finding_ID: findingID,
      supplier: "S1",
    });
  }
  for (const [resource, foreignKey] of [
    [
      "SalesOrderImpacts",
      "PurchaseOrder='4500000002',PurchaseOrderItem='10',SalesOrder='SO1',SalesOrderItem='10'",
    ],
    [
      "ProductionOrderImpacts",
      "PurchaseOrder='4500000002',PurchaseOrderItem='10',ProductionOrder='PROD1'",
    ],
    ["RuleLines", "findingID='at_risk%3A4500000002%2F10',line=1"],
    [
      "MmPdtSources",
      "finding_finding_ID='at_risk%3A4500000002%2F10',supplier='S1'",
    ],
  ]) {
    const list = await app.axios.get(
      `${API}/${resource}?$count=true`,
      as("buyerD01"),
    );
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.equal(list.data.value.length, 1, resource);
    assert.equal(list.data["@odata.count"], 1, resource);
    const denied = await app.axios.get(
      `${API}/${resource}(${foreignKey})`,
      as("buyerD01"),
    );
    assert.equal(denied.status, 404, resource);
    const admin = await app.axios.get(
      `${API}/${resource}`,
      as("ilyesse.hettenbach@cbs-consulting.de"),
    );
    assert.equal(admin.data.value.length, 2, resource);
  }
  const navigation = await app.axios.get(
    `${API}/ItemImpacts(PurchaseOrder='4500000002',PurchaseOrderItem='10')/salesOrderImpacts`,
    as("buyerD01"),
  );
  assert.ok(
    navigation.status === 404 ||
      (navigation.status === 200 && navigation.data.value.length === 0),
  );
  const expanded = await app.axios.get(
    `${API}/ItemImpacts?$expand=salesOrderImpacts,productionOrderImpacts`,
    as("buyerD01"),
  );
  assert.equal(expanded.status, 200, JSON.stringify(expanded.data));
  assert.equal(expanded.data.value.length, 1);
  assert.equal(expanded.data.value[0].PurchaseOrder, "4500000001");
  assert.equal(expanded.data.value[0].salesOrderImpacts.length, 1);
  assert.equal(expanded.data.value[0].productionOrderImpacts.length, 1);
});

test("impact expansion does not expose another plant's item on the same purchase order", async () => {
  const PurchaseOrder = "MIXEDPLANT";
  await UPSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder,
    PurchasingGroup: "D01",
  });
  for (const [PurchaseOrderItem, Plant] of [
    ["10", "DE11"],
    ["20", "DE31"],
  ]) {
    const item = { PurchaseOrder, PurchaseOrderItem };
    await UPSERT.into("tide.s4.PurchaseOrderItem").entries({ ...item, Plant });
    await INSERT.into(`${NS}.OpenItem`).entries({
      ...item,
      Plant,
      PurchasingGroup: "D01",
    });
    await INSERT.into(`${NS}.ItemImpact`).entries(item);
    await INSERT.into(`${NS}.SalesOrderImpact`).entries({
      ...item,
      SalesOrder: "SO1",
      SalesOrderItem: "10",
    });
  }
  const direct = await app.axios.get(
    `${API}/SalesOrderImpacts?$count=true`,
    as("buyerD01"),
  );
  assert.equal(direct.status, 200);
  assert.equal(direct.data["@odata.count"], 1);
  const expanded = await app.axios.get(
    `${API}/ItemImpacts?$count=true&$expand=salesOrderImpacts`,
    as("buyerD01"),
  );
  assert.equal(expanded.status, 200, JSON.stringify(expanded.data));
  assert.equal(expanded.data["@odata.count"], 1);
  assert.deepEqual(
    expanded.data.value.map((row: any) => row.PurchaseOrderItem),
    ["10"],
  );
  assert.deepEqual(
    expanded.data.value[0].salesOrderImpacts.map(
      (row: any) => row.PurchaseOrderItem,
    ),
    ["10"],
  );
  const denied = await app.axios.get(
    `${API}/ItemImpacts(PurchaseOrder='${PurchaseOrder}',PurchaseOrderItem='20')?$expand=salesOrderImpacts`,
    as("buyerD01"),
  );
  assert.equal(denied.status, 404);
});

test("buyers can read and decide only approvals in their purchasing scope", async () => {
  for (const [PurchaseOrder, PurchasingGroup, Plant] of [
    ["4500000001", "D01", "DE11"],
    ["4500000002", "D07", "DE31"],
  ])
    await ensureCase({
      ID: `delivery:${PurchaseOrder}/10`,
      kind: "delivery",
      PurchasingGroup,
      Plant,
      title: PurchaseOrder,
    });
  const owned = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    problemKey: "delivery:4500000001/10",
    operationKey: "delivery_intervention",
    findingID: "at_risk:4500000001/10",
    title: "Owned",
    via: "app",
    cases: [
      { ID: "delivery:4500000001/10", operation: "delivery_intervention" },
    ],
    items: [
      {
        objectKey: "4500000001/10",
        findingID: "at_risk:4500000001/10",
        text: "Owned.",
      },
    ],
  });
  const foreign = await prepareAction({
    kind: "reminder",
    objectKey: "4500000002/10",
    problemKey: "delivery:4500000002/10",
    operationKey: "delivery_intervention",
    findingID: "at_risk:4500000002/10",
    title: "Foreign",
    via: "app",
    cases: [
      { ID: "delivery:4500000002/10", operation: "delivery_intervention" },
    ],
    items: [
      {
        objectKey: "4500000002/10",
        findingID: "at_risk:4500000002/10",
        text: "Foreign.",
      },
    ],
  });
  const list = await app.axios.get(`${API}/Actions?$select=ID`, as("buyerD01"));
  assert.deepEqual(
    list.data.value.map((row: any) => row.ID),
    [owned.ID],
  );
  const approve = async (actionID: string, commandID: string) => {
    const action = await SELECT.one
      .from(`${NS}.Actions`)
      .where({ ID: actionID });
    return app.axios.post(
      `${WORKFLOW}/approveAction`,
      {
        actionID,
        commandID,
        expectedModifiedAt: action.modifiedAt,
        note: commandID,
      },
      as("buyerD01"),
    );
  };
  const denied = await approve(foreign.ID, "guard-foreign-approval");
  assert.equal(denied.status, 404);
  const accepted = await approve(owned.ID, "guard-owned-approval");
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
});

test("typed cases, approval audit rows and bound actions enforce the same buyer scope", async () => {
  const ownedID = "price:scope-owned";
  const foreignID = "price:scope-foreign";
  for (const [ID, PurchasingGroup, Plant] of [
    [ownedID, "D01", "DE11"],
    [foreignID, "D07", "DE31"],
  ]) {
    await ensureCase({ ID, kind: "price", PurchasingGroup, Plant, title: ID });
    await INSERT.into(`${NS}.PriceDeviations`).entries({ header_ID: ID });
  }
  const foreign = await prepareAction({
    kind: "price_clarification",
    objectKey: foreignID,
    title: "Foreign",
    via: "app",
    cases: [{ ID: foreignID, operation: "price_clarification" }],
    items: [{ objectKey: foreignID, text: "Clarify." }],
  });
  const list = await app.axios.get(
    `${API}/PriceDeviations?$select=header_ID`,
    as("buyerD01"),
  );
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.data.value.map((row: any) => row.header_ID),
    [ownedID],
  );
  const audit = await app.axios.get(
    `${API}/ActionEvents?$filter=action_ID eq ${foreign.ID}`,
    as("buyerD01"),
  );
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.data.value, []);
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: foreignID });
  const denied = await app.axios.post(
    `${WORKFLOW}/acceptCaseException`,
    {
      caseID: foreignID,
      note: "not mine",
      commandID: "guard-foreign-exception",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    as("buyerD01"),
  );
  assert.equal(denied.status, 404);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: foreignID })).status,
    "open",
  );
});

test("prediction questions and answers remain private to their requester", async () => {
  const owned = cds.utils.uuid();
  const foreign = cds.utils.uuid();
  await INSERT.into(`${NS}.PredictionQuestion`).entries([
    {
      ID: owned,
      createdBy: "buyerD01",
      target: "late_by_days",
      status: "passed",
    },
    {
      ID: foreign,
      createdBy: "buyerD07",
      target: "late_by_days",
      status: "passed",
    },
  ]);
  await INSERT.into(`${NS}.PredictionAnswer`).entries([
    { question_ID: owned, rank: 1 },
    { question_ID: foreign, rank: 1 },
  ]);
  for (const [entity, key] of [
    ["Questions", "ID"],
    ["Answers", "question_ID"],
  ]) {
    const response = await app.axios.get(
      `${API}/${entity}?$select=${key}`,
      as("buyerD01"),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.data.value.map((row: any) => row[key]),
      [owned],
    );
  }
});

test("customer totals do not reveal exposures belonging to another buyer", async () => {
  await INSERT.into(`${NS}.OpenItem`).entries([
    {
      PurchaseOrder: "SCOPE1",
      PurchaseOrderItem: "10",
      Plant: "DE11",
      PurchasingGroup: "D01",
    },
    {
      PurchaseOrder: "SCOPE2",
      PurchaseOrderItem: "10",
      Plant: "DE31",
      PurchasingGroup: "D07",
    },
  ]);
  await INSERT.into(`${NS}.CustomerImpact`).entries([
    {
      PurchaseOrder: "SCOPE1",
      PurchaseOrderItem: "10",
      SalesOrder: "SO1",
      SalesOrderItem: "10",
      Customer: "OWN",
    },
    {
      PurchaseOrder: "SCOPE1",
      PurchaseOrderItem: "10",
      SalesOrder: "SO2",
      SalesOrderItem: "10",
      Customer: "SHARED",
    },
    {
      PurchaseOrder: "SCOPE2",
      PurchaseOrderItem: "10",
      SalesOrder: "SO3",
      SalesOrderItem: "10",
      Customer: "SHARED",
    },
  ]);
  await INSERT.into(`${NS}.CustomerRisk`).entries([
    { Customer: "OWN" },
    { Customer: "SHARED" },
  ]);
  const response = await app.axios.get(
    `${API}/Customers?$select=Customer`,
    as("buyerD01"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.data.value.map((row: any) => row.Customer),
    ["OWN"],
  );
});

test("MCP explicit filters and direct detail IDs cannot override a buyer's scope", async () => {
  async function tool(name: string, args: object, userId = "buyerD01") {
    const response = await fetch(app.url + "/mcp/cockpit", {
      method: "POST",
      headers: {
        authorization: "Basic " + btoa(`${userId}:${userId}`),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const payload = JSON.parse(
      text.startsWith("{") ? text : text.match(/^data: (.*)$/m)![1],
    );
    assert.ok(payload.result, JSON.stringify(payload));
    return payload.result;
  }
  for (const [name, args] of [
    ["list_cases", { plant: "DE31" }],
    ["list_priorities", { plant: "DE31" }],
    ["get_case", { caseID: "delivery:4500000002/10" }],
  ] as const) {
    const result = await tool(name, args);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result), /Foreign|Revenue at risk/);
  }
  const unconfigured = await tool("list_cases", {}, "carol");
  assert.equal(unconfigured.isError, true, JSON.stringify(unconfigured));
});

test("a buyer sees only the findings of the own purchasing group and plant; ilyesse.hettenbach@cbs-consulting.de sees all", async () => {
  const b = await app.axios.get(
    `${API}/Findings?$select=objectKey`,
    as("buyerD01"),
  );
  assert.equal(b.status, 200);
  assert.deepEqual(b.data.value.map((r: any) => r.objectKey).sort(), [
    "4500000001/10",
    "4500000003/10",
    "M9|DE11",
  ]);
  const buyerActionable = await app.axios.get(
    `${API}/FulfillmentRisks?$select=list,objectKey`,
    as("buyerD01"),
  );
  assert.deepEqual(
    buyerActionable.data.value.map((r: any) => r.objectKey).sort(),
    ["4500000001/10", "4500000003/10"],
  );
  const buyerPrevention = await app.axios.get(
    `${API}/MaterialMasterPlannedTimeFindings?$select=list,objectKey`,
    as("buyerD01"),
  );
  assert.deepEqual(
    buyerPrevention.data.value.map((r: any) => r.objectKey),
    ["M9|DE11"],
  );
  const preventionStatus = await app.axios.get(
    `${API}/MaterialMasterPlannedTimeFindings?$select=status,statusCriticality`,
    as("buyerD01"),
  );
  assert.deepEqual(
    preventionStatus.data.value.map((row: any) => ({
      status: row.status,
      statusCriticality: row.statusCriticality,
    })),
    [{ status: "open", statusCriticality: 2 }],
  );
  const other = await app.axios.get(
    `${API}/Findings?$select=objectKey`,
    as("buyerD07"),
  );
  assert.deepEqual(
    other.data.value.map((r: any) => r.objectKey),
    ["4500000002/10"],
  );
  const a = await app.axios.get(
    `${API}/Findings?$select=objectKey`,
    as("ilyesse.hettenbach@cbs-consulting.de"),
  );
  assert.equal(a.data.value.length, 4);

  const actionable = await app.axios.get(
    `${API}/FulfillmentRisks?$select=list&$orderby=list`,
    as("ilyesse.hettenbach@cbs-consulting.de"),
  );
  assert.deepEqual(
    [...new Set(actionable.data.value.map((r: any) => r.list))].sort(),
    ["at_risk", "overdue"],
  );
  const cannotWiden = await app.axios.get(
    `${API}/FulfillmentRisks?$filter=list eq 'mm_pdt'`,
    as("ilyesse.hettenbach@cbs-consulting.de"),
  );
  assert.deepEqual(cannotWiden.data.value, []);
  const prevention = await app.axios.get(
    `${API}/MaterialMasterPlannedTimeFindings?$select=list&$orderby=list`,
    as("ilyesse.hettenbach@cbs-consulting.de"),
  );
  assert.deepEqual(
    [...new Set(prevention.data.value.map((r: any) => r.list))],
    ["mm_pdt"],
  );
  const preventionCannotWiden = await app.axios.get(
    `${API}/MaterialMasterPlannedTimeFindings?$filter=list eq 'at_risk'`,
    as("ilyesse.hettenbach@cbs-consulting.de"),
  );
  assert.deepEqual(preventionCannotWiden.data.value, []);
});

test("me() tells who is signed in, the scope and the snapshot", async () => {
  const r = await app.axios.get(`${API}/me()`, as("buyerD07"));
  assert.equal(r.status, 200);
  assert.equal(r.data.PurchasingGroup, "D07");
  assert.equal(r.data.Plant, "DE31");
  assert.equal(r.data.isAdmin, false);
  assert.equal(r.data.asOf, "2026-10-05");
  const a = await app.axios.get(
    `${API}/me()`,
    as("ilyesse.hettenbach@cbs-consulting.de"),
  );
  assert.equal(a.data.isAdmin, true);
  assert.equal(a.data.PurchasingGroup, null);
});

test("me() ignores dry runs and flags a completed snapshot with feature failures", async () => {
  await INSERT.into(`${NS}.Snapshot`).entries([
    {
      ID: "healthy",
      status: "done",
      startedAt: "2026-10-05T06:00:00Z",
      finishedAt: "2026-10-05T06:01:00Z",
    },
    {
      ID: "degraded",
      status: "done",
      startedAt: "2026-10-05T07:00:00Z",
      finishedAt: "2026-10-05T07:01:00Z",
      message: "failed steps: proof: unavailable",
    },
    {
      ID: "dry",
      status: "done",
      startedAt: "2026-10-05T08:00:00Z",
      finishedAt: "2026-10-05T08:01:00Z",
      message: "dry run: 1 prediction planned",
    },
  ]);
  const r = await app.axios.get(`${API}/me()`, as("buyerD07"));
  assert.equal(r.data.snapshotId, "degraded");
  assert.equal(r.data.snapshotStatus, "done");
  assert.equal(r.data.snapshotHasFailures, true);
});

test("budget: recorded use counts, a call beyond the limit is refused with 429", async () => {
  process.env.TIDE_BUDGET = "1";
  await ledger.check("predict", 0.4);
  await ledger.record("run a", 1, 0.6);
  await ledger.check("predict", 0.4); // 0.6 + 0.4 <= 1
  await assert.rejects(
    ledger.check("predict", 0.5),
    (e: any) => e.status === 429,
  );
  await ledger.record("run b", 1, 0.4);
  await assert.rejects(
    ledger.check("predict without estimate", 0),
    (e: any) => e.status === 429,
  );
  const r = await app.axios.get(
    `${API}/budget()`,
    as("ilyesse.hettenbach@cbs-consulting.de"),
  );
  assert.deepEqual(
    {
      calls: r.data.calls,
      costUnits: r.data.costUnits,
      limit: r.data.limit,
      remaining: r.data.remaining,
    },
    { calls: 2, costUnits: 1, limit: 1, remaining: 0 },
  );
  const refused = await SELECT.from(`${NS}.BudgetEntry`).where({
    kind: "refused",
  });
  assert.equal(refused.length, 2);
});

test("budget: concurrent recordings are not lost, a check alone writes no use", async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => ledger.record(`r${i}`, 1, 0.05)),
  );
  await ledger.check("dry run", 0.3);
  const s = await ledger.state();
  assert.equal(s.calls, 20);
  assert.equal(s.costUnits, 1);
});

test("the guard step writes one buyer per purchasing group", async () => {
  await DELETE.from("tide.s4.PurchaseOrder");
  await DELETE.from("tide.s4.PurchaseOrderItem");
  await INSERT.into("tide.s4.PurchaseOrder").entries([
    { PurchaseOrder: "1", PurchasingGroup: "D01" },
    { PurchaseOrder: "2", PurchasingGroup: "D07" },
  ]);
  await INSERT.into("tide.s4.PurchaseOrderItem").entries([
    { PurchaseOrder: "1", PurchaseOrderItem: "10", Plant: "DE11" },
    { PurchaseOrder: "2", PurchaseOrderItem: "10", Plant: "DE31" },
  ]);
  await step.run({ dryRun: false } as any);
  const buyers = await SELECT.from(`${NS}.Buyer`).orderBy("userId");
  assert.deepEqual(
    buyers.map((b: any) => [b.userId, b.PurchasingGroup, b.Plant]),
    [
      ["buyerD01", "D01", "DE11"],
      ["buyerD07", "D07", "DE31"],
    ],
  );
});
