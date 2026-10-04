import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import {
  acceptException as kernelAcceptException,
  ensureCase,
  recordSourceChange,
  resolveFromSource,
  setListing,
} from "../srv/cockpit/kernel/cases";
import { touchCase } from "../srv/cockpit/kernel/attention";
import {
  decide as kernelDecide,
  flagOverdue,
  logOutcome as kernelLogOutcome,
} from "../srv/cockpit/kernel/action-state";
import { asWorkflowCommand } from "./fixtures/workflow";

const acceptException = (...args: Parameters<typeof kernelAcceptException>) =>
  asWorkflowCommand(() => kernelAcceptException(...args));
const decide = (...args: Parameters<typeof kernelDecide>) =>
  asWorkflowCommand(() => kernelDecide(...args));
const logOutcome = (...args: Parameters<typeof kernelLogOutcome>) =>
  asWorkflowCommand(() => kernelLogOutcome(...args));
import { prepareAction } from "../srv/cockpit/kernel/actions";
import { prepareFindingAction } from "../srv/cockpit/kernel/actions";
import { upsertDeliveryRisk } from "../srv/cockpit/kernel/delivery-risks";
import { upsertFinding } from "../srv/cockpit/kernel/findings";
import {
  replaceDetectorCases,
  resolveDetectorCase,
  upsertDetectorCase,
} from "../srv/cockpit/kernel/detector-writers";
import { queueFindingForLater } from "../srv/cockpit/kernel/actions";
import { evidenceFingerprint } from "../srv/cockpit/kernel/evidence";
import { overview } from "../srv/cockpit/overview";

const { DELETE, SELECT } = cds.ql;
const NS = "tide.cockpit";
const app = cds.test(path.join(__dirname, ".."));

before(async () => app);

beforeEach(async () => {
  await DELETE.from("tide.workflow.SubjectClaims");
  await DELETE.from("tide.workflow.WorkflowCommands");
  for (const entity of [
    "ActionEvents",
    "OperationLocks",
    "CaseActions",
    "CaseEvents",
    "Cases",
    "ApprovalLock",
    "ApprovalEvent",
    "ActionItems",
    "Actions",
  ])
    await DELETE.from(`${NS}.${entity}`);
});

async function preparationRoute(
  user: cds.User,
  caseID: string,
  context: Record<string, unknown> = {},
  channel: "http" | "api" | "mcp" = "mcp",
) {
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  const payload = {
    caseID,
    commandID: cds.utils.uuid(),
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
    ...context,
  };
  const supplier = header.kind === "supplier_planned_time";
  const event = supplier
    ? "prepareSupplierPlannedTimeAction"
    : "prepareCaseAction";
  const tool = "prepare_case_action";
  return async () => {
    const result =
      channel === "http"
        ? (
            await app.axios.post(`/odata/v4/workflow/${event}`, payload, {
              auth: { username: user.id, password: "alice" },
            })
          ).data
        : await cds.tx({ user }, async () => {
            const service = await cds.connect.to(
              channel === "mcp" ? "CockpitMcpService" : "WorkflowService",
            );
            return service.send(channel === "mcp" ? tool : event, payload);
          });
    const receipt = await SELECT.one
      .from("tide.workflow.WorkflowCommands")
      .where({ commandID: payload.commandID, principal: user.id });
    assert.equal(receipt.commandType, event);
    const { "@odata.context": metadata, ...businessResult } = result;
    assert.deepEqual(businessResult, JSON.parse(receipt.result));
    assert.ok(result.actionID);
    return SELECT.one.from(`${NS}.Actions`).where({ ID: result.actionID });
  };
}

for (const phase of ["at_risk", "overdue"] as const)
  test(`${phase}: delivery preparation has three-channel parity and returns the active action`, async () => {
    const caseID = "delivery:PARITY/10";
    const row: any = {
      list: phase,
      objectKey: "PARITY/10",
      PurchaseOrder: "PARITY",
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "Delivery parity",
      dueDate: "2026-10-01",
      source: "rule",
      nextActionKind: "reminder",
      revenueAtRisk: 12400,
      ...(phase === "at_risk"
        ? { atRiskDetail: { gapDays: 2, plannedDays: 10 } }
        : { overdueDetail: { daysOverdue: 4 } }),
    };
    await upsertDetectorCase(row);
    const user = new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["user", "admin"],
      attr: {},
    });
    const signatures = [];
    for (const channel of ["http", "api", "mcp"] as const) {
      const route = await preparationRoute(user, caseID, {}, channel);
      const response = await route();
      assert.equal((await route()).ID, response.ID);
      const action = await SELECT.one
        .from(`${NS}.Actions`)
        .where({ ID: response.ID });
      const item = await SELECT.one
        .from(`${NS}.ActionItems`)
        .where({ action_ID: response.ID });
      const link = await SELECT.one
        .from(`${NS}.CaseActions`)
        .where({ action_ID: response.ID });
      signatures.push([
        action.kind,
        action.operationKey,
        action.requestType,
        action.decisionReady,
        action.summary,
        item.field,
        item.oldValue,
        item.newValue,
        item.text,
        item.data,
        link.header_ID,
        link.operation,
      ]);
      assert.doesNotMatch(item.text, /revenue|customer|12,400|probability/i);
      await DELETE.from("tide.workflow.SubjectClaims");
      for (const entity of [
        "OperationLocks",
        "CaseActions",
        "ActionEvents",
        "ActionItems",
        "Actions",
      ])
        await DELETE.from(`${NS}.${entity}`).where(
          entity === "Actions"
            ? { ID: response.ID }
            : { action_ID: response.ID },
        );
    }
    assert.deepEqual(signatures[0], signatures[1]);
    assert.deepEqual(signatures[0], signatures[2]);
  });

test("preparing a reminder acknowledges changed delivery evidence and leaves action required", async () => {
  const caseID = "delivery:4500000616/420";
  await upsertDetectorCase({
    list: "at_risk",
    objectKey: "4500000616/420",
    PurchaseOrder: "4500000616",
    PurchaseOrderItem: "420",
    Material: "M1",
    Supplier: "S1",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Changed delivery evidence",
    dueDate: "2026-10-04",
    source: "rule",
    nextActionKind: "reminder",
    atRiskDetail: {
      source: "rule",
      gapDays: 2,
      plannedDays: 10,
      lateShare: null,
      plannedFlag: null,
      riskRank: 1,
      ruleVerdict: "fires",
      ownDeliveries: 0,
      contextLevel: null,
      gridRef: "",
      fastDays: null,
      typicalDays: null,
      slowDays: null,
      dueCriticality: 1,
    },
  });
  await recordSourceChange(caseID, 2, "current-evidence");
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID })).attention,
    "source_changed",
  );
  const user = new cds.User({
    id: "ilyesse.hettenbach@cbs-consulting.de",
    roles: ["user", "admin"],
    attr: {},
  });
  const prepare = async (expectedFingerprint = "current-evidence") =>
    (await preparationRoute(user, caseID, { expectedFingerprint }, "api"))();
  const action = await prepare();
  let header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  assert.deepEqual(
    [header.status, header.sourceChanged, header.attention],
    ["open", false, "awaiting_decision"],
  );
  await cds.ql.UPDATE.entity(`${NS}.Cases`)
    .set({ sourceChanged: true })
    .where({ ID: caseID });
  await touchCase(caseID);
  assert.equal((await prepare()).ID, action.ID);
  header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  assert.deepEqual(
    [header.sourceChanged, header.attention],
    [false, "awaiting_decision"],
  );
  const auth = { auth: { username: user.id, password: "alice" } };
  const response = await app.axios.get(
    "/odata/v4/desk/DeliveryRisks?$filter=PurchaseOrder eq '4500000616' and PurchaseOrderItem eq '420'",
    auth,
  );
  assert.equal(response.data.value[0].caseAttention, "awaiting_decision");
  const required = await app.axios.get(
    "/odata/v4/desk/DeliveryRisks?$filter=PurchaseOrder eq '4500000616' and PurchaseOrderItem eq '420' and (caseAttention eq 'needs_attention' or caseAttention eq 'source_changed' or caseAttention eq 'needs_review' or caseAttention eq 'follow_up_overdue')",
    auth,
  );
  assert.equal(required.data.value.length, 0);
  await recordSourceChange(caseID, 3, "new-evidence");
  await assert.rejects(
    prepare("new-evidence"),
    (error: any) =>
      Number(error.status ?? error.statusCode ?? error.code) === 409 &&
      /older evidence/.test(error.message),
  );
  header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  assert.deepEqual(
    [header.sourceChanged, header.attention],
    [true, "source_changed"],
  );
  assert.equal(
    (await SELECT.from(`${NS}.CaseActions`).where({ header_ID: caseID }))
      .length,
    1,
  );
});

const preparationContracts: ReadonlyArray<
  readonly [string, string, string, string, string, Record<string, unknown>]
> = [
  [
    "price",
    "PriceDeviations",
    "price_clarification",
    "price_clarification",
    "priceDetail",
    { currentPrice: 120, priorMedian: 12, currency: "EUR" },
  ],
  [
    "duplicate",
    "DuplicateMaterials",
    "mdg_case",
    "master_data_duplicate_review",
    "duplicateDetail",
    { materialNumbers: "M1,M2" },
  ],
  [
    "rare",
    "UnusualSettings",
    "planner_review",
    "planner_review",
    "rareDetail",
    { firstPair: "MRP type / lot size" },
  ],
  [
    "pdt",
    "SupplierPlannedTimes",
    "pdt_change",
    "pdt_change",
    "pdtDetail",
    {
      currentDays: 2,
      proposalDays: 14,
      PurchasingInfoRecord: "IR1",
      currentFrom: "info record",
    },
  ],
  [
    "mm_pdt",
    "MaterialPlannedTimes",
    "pdt_change",
    "pdt_change",
    "mmPdtDetail",
    { masterDays: 2, proposalDays: 14 },
  ],
];
for (const [
  list,
  entity,
  kind,
  operation,
  detailName,
  detail,
] of preparationContracts)
  test(`${entity}: typed and MCP preparation preserve scope and action ownership`, async () => {
    const row: any = {
      list,
      objectKey: "PARITY/10",
      PurchaseOrder: "PARITY",
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "Evidence comparison",
      issue: "Check current values",
      source: "rule",
      nextActionKind: kind,
      [detailName]: detail,
    };
    const caseID = (await upsertDetectorCase(row)).ID;
    const user = new cds.User({
      id: "ilyesse.hettenbach@cbs-consulting.de",
      roles: ["user", "admin"],
      attr: {},
    });
    const foreign = new cds.User({
      id: "buyerD07",
      roles: ["user"],
      attr: { Plant: "DE31", PurchasingGroup: "D07" },
    });
    const cockpit: any = await cds.connect.to("PurchasingDeskService");
    const agent: any = await cds.connect.to("CockpitMcpService");
    const context =
      list === "price"
        ? {
            responsiblePerson: "Buyer D01",
            responsibleMessage: "Explain the tenfold difference",
          }
        : {};
    if (list === "price") {
      await assert.rejects(
        (await preparationRoute(user, caseID))(),
        (e: any) =>
          e.status === 400 &&
          /responsiblePerson.*responsibleMessage/.test(e.message),
      );
      assert.equal(
        (await SELECT.from(`${NS}.OperationLocks`).where({ header_ID: caseID }))
          .length,
        0,
      );
    }
    await assert.rejects(
      (await preparationRoute(foreign, caseID, context))(),
      (e: any) => e.status === 404,
    );
    await assert.rejects(
      (await preparationRoute(foreign, caseID, context, "api"))(),
      (e: any) => Number(e.status ?? e.statusCode ?? e.code) === 404,
    );
    assert.equal(
      (await SELECT.from(`${NS}.OperationLocks`).where({ header_ID: caseID }))
        .length,
      0,
    );
    if (list === "pdt") {
      const routes = [
        () =>
          cockpit.tx({ user }).send({
            event: "prepareAction",
            entity,
            params: [{ header_ID: caseID }],
            data: context,
          }),
      ];
      for (const route of routes)
        await assert.rejects(
          route(),
          (error: any) =>
            Number(error.status ?? error.statusCode ?? error.code) === 410,
        );
      assert.equal(
        (await SELECT.from(`${NS}.OperationLocks`).where({ header_ID: caseID }))
          .length,
        0,
      );
      assert.equal(
        (await SELECT.from(`${NS}.CaseActions`).where({ header_ID: caseID }))
          .length,
        0,
      );
      return;
    }
    const signatures = [];
    for (const channel of ["api", "mcp"] as const) {
      const route = await preparationRoute(user, caseID, context, channel);
      const response = await route();
      assert.equal((await route()).ID, response.ID);
      const action = await SELECT.one
        .from(`${NS}.Actions`)
        .where({ ID: response.ID });
      const item = await SELECT.one
        .from(`${NS}.ActionItems`)
        .where({ action_ID: response.ID });
      const lock = await SELECT.one
        .from(`${NS}.OperationLocks`)
        .where({ action_ID: response.ID });
      assert.deepEqual(
        [action.kind, action.operationKey, lock.header_ID, lock.operation],
        [kind, operation, caseID, operation],
      );
      signatures.push([
        action.kind,
        action.operationKey,
        action.requestType,
        action.responsiblePerson,
        action.responsibleMessage,
        action.summary,
        item.field,
        item.oldValue,
        item.newValue,
        item.text,
        item.data,
      ]);
      if (list === "pdt" || list === "mm_pdt")
        assert.deepEqual([item.oldValue, item.newValue], ["2", "14"]);
      await DELETE.from("tide.workflow.SubjectClaims");
      for (const table of [
        "OperationLocks",
        "CaseActions",
        "ActionEvents",
        "ActionItems",
        "Actions",
      ])
        await DELETE.from(`${NS}.${table}`).where(
          table === "Actions"
            ? { ID: response.ID }
            : { action_ID: response.ID },
        );
    }
    assert.deepEqual(signatures[0], signatures[1]);
  });

async function deliveryCase(ID = "delivery:4500000001/10") {
  return ensureCase({
    ID,
    kind: "delivery",
    Plant: "DE11",
    PurchasingGroup: "D01",
    sourceRevision: 1,
    sourceFingerprint: "evidence-1",
  });
}

test("case lifecycle, listing, and attention remain independent", async () => {
  await deliveryCase();
  await setListing("delivery:4500000001/10", "unlisted");
  let row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  assert.equal(row.status, "open");
  assert.equal(row.listing, "unlisted");

  await recordSourceChange("delivery:4500000001/10", 2, "evidence-2");
  row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  assert.equal(row.attention, "source_changed");

  await resolveFromSource("delivery:4500000001/10");
  row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  assert.deepEqual(
    [row.status, row.closure, row.listing, row.attention],
    ["closed", "resolved_at_source", "unlisted", "done"],
  );
  const events = await SELECT.from(`${NS}.CaseEvents`)
    .where({ header_ID: "delivery:4500000001/10" })
    .orderBy("occurredAt");
  assert.deepEqual(
    events.map((event: any) => event.event),
    ["case_detected", "unlisted", "source_changed", "source_resolved"],
  );
});

test("exception acceptance requires the current evidence fingerprint", async () => {
  await deliveryCase("price:4500000001/10");
  await assert.rejects(
    acceptException("price:4500000001/10", "stale"),
    (error: any) => error.status === 409,
  );
  await acceptException(
    "price:4500000001/10",
    "evidence-1",
    "Contractually agreed",
  );
  const row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "price:4500000001/10" });
  assert.deepEqual(
    [row.status, row.closure, row.attention],
    ["closed", "exception_accepted", "done"],
  );
});

test("conflicting decisions produce one success and one conflict without duplicate history", async () => {
  await deliveryCase();
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    title: "Confirm",
    via: "app",
    cases: [
      { ID: "delivery:4500000001/10", operation: "delivery_intervention" },
    ],
    items: [{ objectKey: "4500000001/10", text: "Confirm" }],
  });
  const results = await Promise.allSettled([
    decide(action.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: "2026-10-05",
    }),
    decide(action.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: "2026-10-05",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
      .reason.status,
    409,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.ActionEvents`).where({
        action_ID: action.ID,
        event: "approved",
      })
    ).length,
    1,
  );
});

test("failed preparation rolls back locks, links and both audit streams", async () => {
  await deliveryCase();
  const before = await SELECT.from(`${NS}.CaseEvents`);
  await assert.rejects(
    cds.tx(async () => {
      await prepareAction({
        kind: "reminder",
        objectKey: "4500000001/10",
        title: "Confirm",
        via: "app",
        cases: [
          { ID: "delivery:4500000001/10", operation: "delivery_intervention" },
        ],
        items: [{ objectKey: "4500000001/10", text: "Confirm" }],
      });
      throw new Error("Abort command after preparation");
    }),
    /Abort command/,
  );
  for (const table of [
    "Actions",
    "OperationLocks",
    "CaseActions",
    "ActionEvents",
    "ActionItems",
  ])
    assert.equal((await SELECT.from(`${NS}.${table}`)).length, 0);
  assert.deepEqual(await SELECT.from(`${NS}.CaseEvents`), before);
});

test("changed reviewed evidence blocks approval without writing decision history", async () => {
  await deliveryCase();
  const ID = "delivery:4500000001/10";
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    title: "Confirm",
    via: "app",
    cases: [{ ID, operation: "delivery_intervention" }],
    items: [{ objectKey: "4500000001/10", text: "Confirm" }],
  });
  await recordSourceChange(ID, 2, "new-evidence");
  await assert.rejects(
    decide(action.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: "2026-10-05",
    }),
    (e: any) => e.status === 409,
  );
  assert.equal(
    (await SELECT.from(`${NS}.ActionEvents`).where({ action_ID: action.ID }))
      .length,
    1,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Actions`).where({ ID: action.ID })).status,
    "needs_decision",
  );
});

test("typed-only delivery attention agrees across OData MCP and overview", async () => {
  const ID = await upsertDeliveryRisk(
    {
      PurchaseOrder: "ALIGN",
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "Alignment",
      dueDate: "2026-10-05",
      source: "rule",
      atRiskDetail: { gapDays: 2, plannedDays: 10 },
    },
    "at_risk",
  );
  const user = new cds.User({
    id: "buyerD01",
    roles: ["user"],
    attr: { PurchasingGroup: "D01", Plant: "DE11" },
  });
  const agent: any = await cds.connect.to("CockpitMcpService");
  const action = await (await preparationRoute(user, ID))();
  await decide(action.ID, { decidedBy: user.id, asOf: "2026-10-05" });
  await logOutcome(action.ID, { resolution: "confirmed", resolvedBy: user.id });
  const mcp = await agent.tx({ user }).send("get_case", { caseID: ID });
  const odata = await cds.ql.SELECT.one
    .from("PurchasingDeskService.DeliveryRisks")
    .where({ header_ID: ID });
  assert.deepEqual(
    [mcp.attention, odata.caseAttention, mcp.actions[0].status],
    ["awaiting_source", "awaiting_source", "resolved"],
  );
  const brief = await overview({ PurchasingGroup: "D01", Plant: "DE11" });
  assert.ok(brief.kpis.atRisk >= 1);
});

test("identical rebuilds preserve exceptions while business changes invalidate stale decisions", async () => {
  const row: any = {
    list: "price",
    objectKey: "STABLE/10",
    PurchaseOrder: "STABLE",
    PurchaseOrderItem: "10",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Price",
    source: "rule",
    rank: 1,
    priceDetail: { currentPrice: 120, priorMedian: 12, currency: "EUR" },
  };
  const finding = await upsertDetectorCase(row);
  const hash = evidenceFingerprint(row);
  await acceptException(finding.ID, hash, "Agreed");
  await upsertDetectorCase({
    ...row,
    rank: 90,
    itemTitle: "Generated text changed",
    snapshot_ID: "another-run",
    priceDetail: { ...row.priceDetail, finding_ID: finding.ID },
  });
  const unchanged = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: finding.ID });
  assert.deepEqual(
    [unchanged.status, unchanged.sourceFingerprint, unchanged.listing],
    ["closed", hash, "unlisted"],
  );
  await upsertDetectorCase({
    ...row,
    priceDetail: { ...row.priceDetail, currentPrice: 130 },
  });
  const changed = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: finding.ID });
  assert.deepEqual(
    [changed.status, changed.sourceChanged, changed.attention],
    ["open", true, "source_changed"],
  );
  await assert.rejects(
    acceptException(finding.ID, hash, "Stale"),
    (e: any) => e.status === 409,
  );
});

test("action resolution keeps its linked case open pending source reconciliation", async () => {
  await deliveryCase();
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    title: "Confirm delivery",
    via: "app",
    cases: [
      { ID: "delivery:4500000001/10", operation: "delivery_intervention" },
    ],
    items: [{ objectKey: "4500000001/10", text: "Please confirm delivery." }],
  });
  let row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  assert.equal(row.attention, "awaiting_decision");
  await decide(action.ID, {
    decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
    asOf: "2026-10-05",
  });
  row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  assert.equal(row.attention, "waiting_external");
  await logOutcome(action.ID, {
    resolution: "confirmed",
    resolvedBy: "ilyesse.hettenbach@cbs-consulting.de",
  });
  row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  assert.deepEqual(
    [row.status, row.closure, row.listing, row.attention],
    ["open", null, "listed", "awaiting_source"],
  );
  assert.equal(
    (await SELECT.from(`${NS}.OperationLocks`).where({ action_ID: action.ID }))
      .length,
    0,
  );
  assert.equal(
    (await SELECT.from(`${NS}.ActionEvents`).where({ action_ID: action.ID }))
      .length,
    3,
  );
  const link = await SELECT.one
    .from(`${NS}.CaseActions`)
    .where({ action_ID: action.ID });
  assert.deepEqual([link.resolution, !!link.resolvedAt], ["confirmed", true]);
  const event = await SELECT.one
    .from(`${NS}.CaseEvents`)
    .where({ header_ID: "delivery:4500000001/10", event: "action_resolved" });
  assert.deepEqual([event.fromStatus, event.toStatus], [null, null]);
});

test("a resolved action does not hide another waiting action on the same case", async () => {
  await deliveryCase();
  const intervention = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    title: "Confirm delivery",
    via: "app",
    cases: [
      { ID: "delivery:4500000001/10", operation: "delivery_intervention" },
    ],
    items: [{ objectKey: "4500000001/10", text: "Please confirm delivery." }],
  });
  const escalation = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    title: "Escalate delivery",
    via: "app",
    cases: [{ ID: "delivery:4500000001/10", operation: "delivery_escalation" }],
    items: [
      {
        objectKey: "4500000001/10",
        text: "Please resolve the overdue delivery.",
      },
    ],
  });
  await decide(intervention.ID, {
    decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
    asOf: "2026-10-05",
  });
  await decide(escalation.ID, {
    decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
    asOf: "2026-10-05",
  });
  await logOutcome(intervention.ID, {
    resolution: "confirmed",
    resolvedBy: "ilyesse.hettenbach@cbs-consulting.de",
  });
  const row = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  assert.deepEqual(
    [row.status, row.listing, row.attention],
    ["open", "listed", "waiting_external"],
  );
});

test("overdue actions immediately update linked case attention and history", async () => {
  await deliveryCase();
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    title: "Confirm delivery",
    via: "app",
    cases: [
      { ID: "delivery:4500000001/10", operation: "delivery_intervention" },
    ],
    items: [{ objectKey: "4500000001/10", text: "Please confirm delivery." }],
  });
  await decide(action.ID, {
    decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
    asOf: "2026-10-05",
  });
  const deadline = (
    await SELECT.one.from(`${NS}.Actions`).where({ ID: action.ID })
  ).expectedBy;
  await cds.tx({ user: cds.User.privileged }, () =>
    flagOverdue(action.ID, "2026-10-06", deadline),
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Actions`).where({ ID: action.ID })).overdue,
    false,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.ActionEvents`).where({
        action_ID: action.ID,
        event: "follow_up_overdue",
      })
    ).length,
    0,
  );
  const foreignUser = new cds.User({
    id: "foreign-deadline-observer",
    roles: ["user", "buyer"],
    attr: { Plant: "DE31", PurchasingGroup: "D07" },
  });
  await assert.rejects(
    cds.tx({ user: foreignUser }, () =>
      flagOverdue(action.ID, "2026-10-09", deadline),
    ),
    /Case not found/,
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Actions`).where({ ID: action.ID })).overdue,
    false,
  );
  assert.equal(
    (
      await SELECT.from("tide.workflow.WorkflowCommands").where({
        principal: foreignUser.id,
        commandType: "flagFollowUpOverdue",
      })
    ).length,
    0,
  );
  await cds.tx({ user: cds.User.privileged }, () =>
    flagOverdue(action.ID, "2026-10-09", deadline),
  );
  await cds.tx({ user: cds.User.privileged }, () =>
    flagOverdue(action.ID, "2026-10-12", deadline),
  );
  const flagged = await SELECT.one
    .from(`${NS}.Actions`)
    .where({ ID: action.ID });
  assert.equal(flagged.status, "waiting");
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: "delivery:4500000001/10" })
    ).status,
    "open",
  );
  const deadlineEvents = await SELECT.from(`${NS}.ActionEvents`).where({
    action_ID: action.ID,
    event: "follow_up_overdue",
  });
  assert.equal(deadlineEvents.length, 1);
  const receipt = await SELECT.one
    .from("tide.workflow.WorkflowCommands")
    .where({ ID: deadlineEvents[0].command_ID });
  assert.equal(receipt.commandType, "flagFollowUpOverdue");
  assert.equal(JSON.parse(receipt.result).overdue, true);
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: "delivery:4500000001/10" })
    ).attention,
    "follow_up_overdue",
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.ActionEvents`).where({
        action_ID: action.ID,
        event: "follow_up_overdue",
      })
    ).length,
    1,
  );
  await cds.run(
    cds.ql.UPDATE.entity(`${NS}.Actions`)
      .where({ ID: action.ID })
      .set({ expectedBy: "2026-10-15", overdue: false }),
  );
  await cds.tx({ user: cds.User.privileged }, () =>
    flagOverdue(action.ID, "2026-10-12", "2026-10-15"),
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Actions`).where({ ID: action.ID })).overdue,
    false,
  );
  await cds.tx({ user: cds.User.privileged }, () =>
    flagOverdue(action.ID, "2026-10-15", "2026-10-15"),
  );
  await cds.tx({ user: cds.User.privileged }, () =>
    flagOverdue(action.ID, "2026-10-16", "2026-10-15"),
  );
  const versions: { command_ID: string }[] = await SELECT.from(
    `${NS}.ActionEvents`,
  ).where({
    action_ID: action.ID,
    event: "follow_up_overdue",
  });
  assert.equal(versions.length, 2);
  assert.equal(new Set(versions.map((event) => event.command_ID)).size, 2);
  const secondVersion = await SELECT.one
    .from("tide.workflow.WorkflowCommands")
    .where({
      ID: versions.find((event) => event.command_ID !== receipt.ID)!.command_ID,
    });
  assert.equal(JSON.parse(secondVersion.result).expectedBy, "2026-10-15");
  assert.equal(JSON.parse(secondVersion.result).status, "waiting");
});

test("delivery phase changes reuse one typed case and retain action links", async () => {
  const atRisk = {
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    Material: "M1",
    Supplier: "S1",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "4500000001/10",
    dueDate: "2026-10-05",
    arrivalSource: "grid",
    source: "tabpfn",
    nextActionKind: "reminder",
    atRiskDetail: { typicalDays: 10 },
  };
  await upsertDeliveryRisk(atRisk, "at_risk");
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: "delivery:4500000001/10" })
    ).priority,
    2,
  );
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "4500000001/10",
    title: "Confirm delivery",
    via: "app",
    cases: [
      { ID: "delivery:4500000001/10", operation: "delivery_intervention" },
    ],
    items: [{ objectKey: "4500000001/10", text: "Please confirm delivery." }],
  });
  await upsertDeliveryRisk(
    { ...atRisk, overdueDetail: { daysOverdue: 2 } },
    "overdue",
  );
  const caseRow = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: "delivery:4500000001/10" });
  const risk = await SELECT.one
    .from(`${NS}.DeliveryRisks`)
    .where({ header_ID: "delivery:4500000001/10" });
  assert.deepEqual(
    [caseRow.status, risk.phase, risk.arrivalSource],
    ["open", "overdue", "grid"],
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseActions`).where({
        header_ID: caseRow.ID,
        action_ID: action.ID,
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: caseRow.ID,
        event: "delivery_phase_changed",
      })
    ).length,
    1,
  );
});

test("registered delivery action builder links the durable case", async () => {
  await upsertDeliveryRisk(
    {
      PurchaseOrder: "4500000001",
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "4500000001/10",
      dueDate: "2026-10-05",
      source: "tabpfn",
      nextActionKind: "reminder",
      atRiskDetail: { gapDays: 2, plannedDays: 10 },
    },
    "at_risk",
  );
  const finding = await upsertFinding({
    list: "at_risk",
    objectKey: "4500000001/10",
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    Material: "M1",
    Supplier: "S1",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "4500000001/10",
    dueDate: "2026-10-05",
    source: "tabpfn",
    nextActionKind: "reminder",
    atRiskDetail: { gapDays: 2, plannedDays: 10 } as any,
  });
  const action = await prepareFindingAction(finding.ID);
  const link = await SELECT.one
    .from(`${NS}.CaseActions`)
    .where({ action_ID: action.ID });
  assert.deepEqual(
    [link.header_ID, link.operation],
    ["delivery:4500000001/10", "delivery_intervention"],
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: link.header_ID }))
      .attention,
    "awaiting_decision",
  );
});

test("case MCP reads return typed delivery detail", async () => {
  await upsertDeliveryRisk(
    {
      PurchaseOrder: "4500000001",
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "PO 4500000001/10",
      dueDate: "2026-10-05",
      source: "tabpfn",
      nextActionKind: "reminder",
      atRiskDetail: {},
    },
    "at_risk",
  );
  const agent: any = await cds.connect.to("CockpitMcpService");
  const user = new cds.User({
    id: "buyerD01",
    roles: ["user"],
    attr: { PurchasingGroup: "D01", Plant: "DE11" },
  });
  const work = await agent.tx({ user }).send("list_cases", {});
  assert.deepEqual(
    work.cases.map((row: any) => [row.caseID, row.kind, row.typedEntitySet]),
    [["delivery:4500000001/10", "delivery", "DeliveryRisks"]],
  );
  const detail = await agent
    .tx({ user })
    .send("get_case", { caseID: "delivery:4500000001/10" });
  assert.deepEqual(
    [detail.phase, detail.PurchaseOrder, detail.PurchaseOrderItem],
    ["at_risk", "4500000001", "10"],
  );
  assert.equal(detail.nextActionKind, "reminder");
  assert.equal(JSON.parse(detail.evidence).PurchaseOrder, "4500000001");
  assert.ok(detail.sourceFingerprint);
  assert.match(detail.link, /DeliveryRisks/);
});

test("typed MCP action prepares from caseID without reading Finding", async () => {
  await upsertDeliveryRisk(
    {
      PurchaseOrder: "4500000001",
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "PO 4500000001/10",
      dueDate: "2026-10-05",
      source: "tabpfn",
      nextActionKind: "reminder",
      atRiskDetail: {},
    },
    "at_risk",
  );
  const agent: any = await cds.connect.to("CockpitMcpService");
  const user = new cds.User({
    id: "buyerD01",
    roles: ["user"],
    attr: { PurchasingGroup: "D01", Plant: "DE11" },
  });
  const action = await (
    await preparationRoute(user, "delivery:4500000001/10")
  )();
  const link = await SELECT.one
    .from(`${NS}.CaseActions`)
    .where({ action_ID: action.ID });
  assert.deepEqual(
    [action.kind, action.status, link.header_ID],
    ["reminder", "needs_decision", "delivery:4500000001/10"],
  );
});

test("typed MCP delivery preparation uses the phase-aware delivery draft", async () => {
  const caseID = await upsertDeliveryRisk(
    {
      PurchaseOrder: "4500000002",
      PurchaseOrderItem: "10",
      Material: "M2",
      Supplier: "S2",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "PO 4500000002/10",
      dueDate: "2026-10-01",
      source: "rule",
      nextActionKind: "reminder",
      revenueAtRisk: 12400,
      overdueDetail: { daysOverdue: 4 },
    },
    "overdue",
  );
  const agent: any = await cds.connect.to("CockpitMcpService");
  const user = new cds.User({
    id: "buyerD01",
    roles: ["user"],
    attr: { PurchasingGroup: "D01", Plant: "DE11" },
  });
  const response = await (await preparationRoute(user, caseID))();
  const action = await SELECT.one
    .from(`${NS}.Actions`)
    .where({ ID: response.ID });
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: response.ID });
  const link = await SELECT.one
    .from(`${NS}.CaseActions`)
    .where({ action_ID: response.ID });
  assert.deepEqual(
    [
      action.kind,
      action.operationKey,
      action.requestType,
      action.preparedVia,
      action.decisionReady,
      link.header_ID,
      link.operation,
    ],
    [
      "reminder",
      "delivery_escalation",
      "Delivery Risk - Overdue",
      "mcp",
      true,
      caseID,
      "delivery_escalation",
    ],
  );
  assert.match(action.summary, /4 days ago/);
  assert.match(action.summary, /12,400 EUR/);
  assert.deepEqual(
    [item.oldValue, item.newValue],
    [
      "2026-10-01",
      "Ask the supplier to confirm the earliest achievable delivery date",
    ],
  );
  assert.doesNotMatch(item.text, /12,400|revenue|customer/i);
});

test("detector facade writes typed roots before refreshing the compatibility projection", async () => {
  const row: any = {
    list: "price",
    objectKey: "4500000002/10",
    PurchaseOrder: "4500000002",
    PurchaseOrderItem: "10",
    Material: "M2",
    Supplier: "S2",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Price deviation",
    source: "rule",
    rank: 1,
    priceDetail: {
      unitPrice: 100,
      priorCount: 3,
      currentPrice: 100,
      priorMedian: 10,
      ratio: 10,
      factor: 10,
      potentialDifference: 90,
      currency: "EUR",
    },
  };
  const finding = await upsertDetectorCase(row);
  assert.equal(finding.ID, "price:4500000002/10");
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: finding.ID })).kind,
    "price",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.PriceDeviations`)
        .where({ header_ID: finding.ID })
    ).currentPrice,
    100,
  );

  await replaceDetectorCases(
    "00000000-0000-0000-0000-000000000001",
    ["price"],
    [],
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: finding.ID })).listing,
    "unlisted",
  );
  await resolveDetectorCase(finding.ID, "No longer present in source facts.");
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: finding.ID })).status,
    "closed",
  );
});

test("typed price action reuses the clarification payload instead of a generic review", async () => {
  const row: any = {
    list: "price",
    objectKey: "4500000003/10",
    PurchaseOrder: "4500000003",
    PurchaseOrderItem: "10",
    Material: "M3",
    Supplier: "S3",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Price deviation",
    issue: "Normalized unit price is much higher than earlier prices",
    source: "rule",
    rank: 1,
    nextActionKind: "price_clarification",
    priceDetail: {
      unitPrice: 120,
      priorCount: 8,
      currentPrice: 120,
      priceQuantity: 1,
      priorMedian: 12,
      ratio: 10,
      factor: 10,
      potentialDifference: 108,
      currency: "EUR",
    },
  };
  const finding = await upsertDetectorCase(row);
  const action = await prepareFindingAction(finding.ID);
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: action.ID });
  assert.deepEqual(
    [action.kind, item.field, item.oldValue, item.newValue],
    ["price_clarification", "NetPriceAmount (review only)", "120", "12"],
  );
});

test("prepared price clarification keeps the responsible person and message", async () => {
  await deliveryCase("price:4500000004/10");
  const action = await prepareAction({
    kind: "price_clarification",
    objectKey: "4500000004/10",
    title: "Price clarification",
    via: "app",
    responsiblePerson: "Buyer D01",
    responsibleMessage:
      "Please confirm why the entered price is ten times the prior median.",
    cases: [{ ID: "price:4500000004/10", operation: "price_clarification" }],
    items: [{ objectKey: "4500000004/10", text: "Clarify the price." }],
  });
  const stored = await SELECT.one
    .from(`${NS}.Actions`)
    .where({ ID: action.ID });
  assert.deepEqual(
    [stored.responsiblePerson, stored.responsibleMessage],
    [
      "Buyer D01",
      "Please confirm why the entered price is ten times the prior median.",
    ],
  );
});

test("material planned-time acceptance survives model and incomplete refresh until a maintained setting changes", async () => {
  const row: any = {
    list: "mm_pdt",
    objectKey: "RECURRENCE-M1|DE11",
    Material: "RECURRENCE-M1",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Material planned time",
    source: "empirical",
    nextActionKind: "pdt_change",
    mmPdtDetail: { masterDays: 2, proposalDays: 14, orders12m: 12 },
  };
  const finding = await upsertDetectorCase(row);
  const workflow = await cds.connect.to("WorkflowService");
  for (const [index, days] of [null, "", false, "invalid", " "].entries()) {
    await upsertDetectorCase({
      ...row,
      mmPdtDetail: { ...row.mmPdtDetail, masterDays: days },
    });
    const incomplete = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: finding.ID });
    await assert.rejects(
      cds.tx({ user: cds.User.privileged }, () =>
        workflow.send("acceptCaseException", {
          caseID: finding.ID,
          commandID: `material-condition-incomplete-${index}`,
          expectedModifiedAt: incomplete.modifiedAt,
          expectedFingerprint: incomplete.sourceFingerprint,
          note: "An incomplete setting cannot establish the accepted baseline.",
        }),
      ),
      /Maintained material setting is incomplete/,
    );
    assert.equal(
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: finding.ID })).status,
      "open",
    );
  }
  await upsertDetectorCase(row);
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: finding.ID });
  await cds.tx({ user: cds.User.privileged }, () =>
    workflow.send("acceptCaseException", {
      caseID: finding.ID,
      commandID: "material-condition-accept",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
      note: "Maintained material duration is intentional.",
    }),
  );
  const accepted = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: finding.ID });
  assert.deepEqual(JSON.parse(accepted.acceptedSourceCondition), {
    Material: row.Material,
    Plant: row.Plant,
    days: 2,
  });
  for (const days of [2, null, "", false, "invalid", " ", 2]) {
    await upsertDetectorCase({
      ...row,
      mmPdtDetail: {
        ...row.mmPdtDetail,
        masterDays: days,
        proposalDays: 21,
        orders12m: 99,
      },
    });
    const refreshed = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: finding.ID });
    assert.equal(refreshed.status, "closed");
    assert.equal(refreshed.closure, "exception_accepted");
    assert.equal(
      refreshed.acceptedSourceCondition,
      accepted.acceptedSourceCondition,
    );
  }
  const changed = {
    ...row,
    mmPdtDetail: { ...row.mmPdtDetail, masterDays: 3, proposalDays: 21 },
  };
  await upsertDetectorCase(changed);
  await upsertDetectorCase(changed);
  const reopened = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: finding.ID });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.closure, null);
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: finding.ID,
        fromStatus: "closed",
        toStatus: "open",
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: finding.ID,
        event: "source_resolved",
      })
    ).length,
    0,
  );
});

for (const disposition of ["open", "exception_accepted"] as const)
  test(`supplier planned-time baseline: ${disposition} survives technical refresh and list omission`, async () => {
    const row: any = {
      list: "pdt",
      objectKey: "PILOT-M1|PILOT-S1|DE11",
      Material: "PILOT-M1",
      Supplier: "PILOT-S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "Supplier planned time",
      source: "empirical",
      rank: 1,
      nextActionKind: "pdt_change",
      pdtDetail: {
        currentDays: 2,
        proposalDays: 14,
        purchasingInfoRecord: "PILOT-IR1",
        ownDeliveries: 12,
        p50: 10,
      },
    };
    const finding = await upsertDetectorCase(row);
    const fingerprint = evidenceFingerprint(row);
    if (disposition === "exception_accepted") {
      const header = await SELECT.one
        .from(`${NS}.Cases`)
        .where({ ID: finding.ID });
      const workflow = await cds.connect.to("WorkflowService");
      await cds.tx({ user: cds.User.privileged }, () =>
        workflow.send("acceptSupplierPlannedTimeException", {
          caseID: finding.ID,
          expectedModifiedAt: header.modifiedAt,
          expectedFingerprint: fingerprint,
          commandID: "baseline-accept-exception",
          note: "Current setting is intentional.",
        }),
      );
    }
    const beforeRefresh = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: finding.ID });
    const history = await SELECT.from(`${NS}.CaseEvents`)
      .where({ header_ID: finding.ID })
      .orderBy("ID");

    await upsertDetectorCase({
      ...row,
      rank: 99,
      itemTitle: "Regenerated presentation",
      snapshot_ID: "00000000-0000-0000-0000-000000000002",
      pdtDetail: { ...row.pdtDetail, finding_ID: finding.ID, runID: "new-run" },
    });
    const refreshed = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: finding.ID });
    assert.deepEqual(
      [
        refreshed.status,
        refreshed.closure,
        refreshed.sourceFingerprint,
        refreshed.sourceRevision,
        refreshed.sourceChanged,
      ],
      [
        beforeRefresh.status,
        beforeRefresh.closure,
        fingerprint,
        beforeRefresh.sourceRevision,
        false,
      ],
    );
    assert.deepEqual(
      await SELECT.from(`${NS}.CaseEvents`)
        .where({ header_ID: finding.ID })
        .orderBy("ID"),
      history,
    );

    await replaceDetectorCases(
      "00000000-0000-0000-0000-000000000002",
      ["pdt"],
      [],
    );
    const omitted = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: finding.ID });
    assert.deepEqual(
      [
        omitted.status,
        omitted.closure,
        omitted.listing,
        omitted.sourceFingerprint,
      ],
      [beforeRefresh.status, beforeRefresh.closure, "unlisted", fingerprint],
    );
    assert.equal(
      (
        await SELECT.from(`${NS}.CaseEvents`).where({
          header_ID: finding.ID,
          event: "source_resolved",
        })
      ).length,
      0,
    );
  });
