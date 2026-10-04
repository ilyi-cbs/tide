// Cockpit kernel v3: calendar, supplier region, findings, events, actions
// (409 per kind), step order, stubs and prepareFindingAction.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import {
  addWorkingDays,
  workingDaysBetween,
  addDays,
  daysBetween,
} from "../srv/cockpit/kernel/calendar";
import { supplierRegion } from "../srv/cockpit/kernel/asof";
import {
  closeFindings,
  impactText,
  sourceText,
  upsertFinding,
  writeFindings,
  savePreventionDisposition,
} from "../srv/cockpit/kernel/findings";
import { emit } from "../srv/cockpit/kernel/events";
import {
  prepareAction,
  prepareReminderAction,
  queueFindingForLater,
} from "../srv/cockpit/kernel/actions";
import {
  decide,
  decline,
  logOutcome,
} from "../srv/cockpit/kernel/action-state";
import { runSteps, STEP_ORDER, steps } from "../srv/cockpit/kernel/steps";
import {
  hooksFor,
  registerHook,
  resetHooks,
} from "../srv/cockpit/kernel/hooks";
import { STUB_OPERATIONS } from "../srv/cockpit/kernel/service";
import {
  FIXTURE_AS_OF,
  FIXTURE_SNAPSHOT,
  finding,
  seedFixtures,
} from "./fixtures/cockpit";
import { asWorkflowCommand } from "./fixtures/workflow";

const { SELECT, DELETE } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
  validateStatus: () => true,
};

before(async () => {
  await app;
});

beforeEach(async () => {
  for (const e of [
    "MaterialPlannedTimes",
    "SupplierPlannedTimes",
    "UnusualSettings",
    "DuplicateMaterials",
    "PriceDeviations",
    "ActionEvents",
    "OperationLocks",
    "CaseActions",
    "CaseEvents",
    "Cases",
    "ApprovalLock",
    "ApprovalEvent",
    "ProblemEvent",
    "FindingEvidence",
    "Finding",
    "Event",
    "ActionItems",
    "Actions",
    "Problem",
    "Snapshot",
  ])
    await DELETE.from(`${NS}.${e}`);
  await seedFixtures(cds.db);
});

test("calendar: working days like numpy busday_count / busday_offset", () => {
  // 2026-10-05 is a Monday.
  assert.equal(workingDaysBetween("2026-10-05", "2026-10-08"), 3);
  assert.equal(workingDaysBetween("2026-10-02", "2026-10-05"), 1); // Fri counted, Mon not
  assert.equal(workingDaysBetween("2026-10-03", "2026-10-05"), 0); // weekend
  assert.equal(workingDaysBetween("2026-10-08", "2026-10-05"), -3);
  assert.equal(addWorkingDays("2026-10-02", 3), "2026-10-07");
  assert.equal(addWorkingDays("2026-10-03", 0), "2026-10-05"); // rolls forward
  assert.equal(addWorkingDays("2026-10-05", 10), "2026-10-19");
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(daysBetween("2026-10-01", "2026-11-01"), 31);
});

test("supplierRegion maps countries per P-0", () => {
  assert.equal(supplierRegion("DE"), "domestic");
  assert.equal(supplierRegion("at"), "domestic");
  assert.equal(supplierRegion("PL"), "eu");
  assert.equal(supplierRegion("TW"), "overseas");
  assert.equal(supplierRegion("BR"), "unknown");
  assert.equal(supplierRegion(null), "unknown");
});

test("buyer words for sources and impact levels", () => {
  assert.equal(sourceText("tabpfn"), "AI estimate");
  assert.equal(sourceText("fallback"), "Past deliveries");
  assert.equal(sourceText("confirmation"), "Supplier confirmation");
  assert.equal(sourceText(undefined), "–");
  assert.equal(
    impactText("customer_order_late", 12400),
    "Customer order at risk · 12,400 EUR",
  );
  assert.equal(impactText("covered_by_stock", 0), "Stock covers it");
  assert.equal(impactText(null), "");
});

test("writeFindings replaces only its lists and fills ID / sourceText; closeFindings closes open rows", async () => {
  await writeFindings(
    FIXTURE_SNAPSHOT,
    ["overdue"],
    [finding({ list: "overdue", objectKey: "1/10", source: "rule" })],
  );
  await writeFindings(
    FIXTURE_SNAPSHOT,
    ["at_risk"],
    [
      finding({ objectKey: "1/10", source: "tabpfn" }),
      finding({ objectKey: "2/10", source: "empirical" }),
    ],
  );
  await writeFindings(
    FIXTURE_SNAPSHOT,
    ["at_risk"],
    [finding({ objectKey: "3/10", source: "tabpfn" })],
  );
  const rows = await SELECT.from(`${NS}.Finding`).orderBy("ID");
  assert.deepEqual(
    rows.map((r: any) => [r.ID, r.sourceText, r.status, r.snapshot_ID]),
    [
      ["at_risk:3/10", "AI estimate", "open", FIXTURE_SNAPSHOT],
      ["overdue:1/10", "Check", "open", FIXTURE_SNAPSHOT],
    ],
  );
  await assert.rejects(
    writeFindings(FIXTURE_SNAPSHOT, ["price"], [finding({ list: "overdue" })]),
    /not in/,
  );

  const up = await upsertFinding(
    finding({
      list: "at_risk",
      objectKey: "4/10",
      trigger: "arrived",
      arrivedAt: "2026-10-05T10:00:00Z",
    }),
  );
  assert.equal(up.ID, "at_risk:4/10");
  assert.equal(up.trigger, "arrived");
  assert.equal(await closeFindings({ list: "at_risk" }), 2);
  assert.equal(await closeFindings({ list: "at_risk" }), 0);
  const open = await SELECT.from(`${NS}.Finding`).where({ status: "open" });
  assert.deepEqual(
    open.map((r: any) => r.ID),
    ["overdue:1/10"],
  );
});

test("finding details are replaced with their headers and stale details are removed", async () => {
  await writeFindings(
    FIXTURE_SNAPSHOT,
    ["at_risk"],
    [
      finding({
        objectKey: "detail/10",
        atRiskDetail: {
          source: "empirical",
          lateShare: 0.8,
          gapDays: 2,
          plannedDays: 4,
          plannedFlag: null,
          riskRank: 1,
          ruleVerdict: "fires",
          ownDeliveries: 12,
          contextLevel: "own",
          gridRef: "LineGrids(...)",
          fastDays: 2,
          typicalDays: 4,
          slowDays: 8,
          dueCriticality: 1,
        },
      }),
    ],
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.AtRiskDetail`)
        .where({ finding_ID: "at_risk:detail/10" })
    ).typicalDays,
    4,
  );
  await writeFindings(
    FIXTURE_SNAPSHOT,
    ["at_risk"],
    [finding({ objectKey: "replacement/10" })],
  );
  assert.equal(
    await SELECT.one
      .from(`${NS}.AtRiskDetail`)
      .where({ finding_ID: "at_risk:detail/10" }),
    undefined,
  );
});

test("emit numbers events 1, 2, 3 …", async () => {
  const a = await emit({ kind: "morning", title: "Morning run" });
  const b = await emit({
    kind: "po_item",
    title: "New PO item",
    objectKey: "1/10",
  });
  const c = await emit({ kind: "why", title: "Why?" });
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  const res = await app.axios.get(
    "/odata/v4/desk/Events?$filter=seq gt 1&$orderby=seq",
    AUTH,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.data.value.map((e: any) => e.kind),
    ["po_item", "why"],
  );
});

test("prepareAction refuses a second pending action of the same kind and object (409)", async () => {
  const input = {
    kind: "code_list" as const,
    objectKey: "PR1/10",
    title: "Codes for PR1/10",
    via: "app" as const,
    items: [
      {
        objectKey: "PR1/10",
        field: "MaterialGroup",
        newValue: "MG01",
        data: { confidence: 0.97, status: "prefilled", source: "tabpfn" },
      },
    ],
  };
  const a = await prepareAction(input);
  assert.equal(a.status, "needs_decision");
  assert.equal(a.kind, "code_list");
  assert.equal(a.problemKey, "PR1/10");
  assert.equal(a.operationKey, "code_list");
  assert.equal(a.exportFormat, "csv");
  await assert.rejects(
    prepareAction(input),
    (e: any) => e.status === 409 && e.actionID === a.ID,
  );
  const ev = await SELECT.from(`${NS}.Event`).where({ kind: "action" });
  assert.equal(ev.length, 1);
  assert.equal(
    (await SELECT.from(`${NS}.ActionEvents`).where({ action_ID: a.ID })).length,
    1,
  );
});

test("resolving an approval does not close its source finding", async () => {
  const source = await upsertFinding(
    finding({ list: "at_risk", objectKey: "A1/10" }),
  );
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "A1/10",
    title: "Reminder for A1/10",
    via: "app",
    findingID: source.ID,
    items: [{ objectKey: "A1/10", text: "Please confirm." }],
  });
  await asWorkflowCommand(() =>
    decide(action.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: FIXTURE_AS_OF,
    }),
  );
  await asWorkflowCommand(() =>
    logOutcome(action.ID, {
      resolution: "confirmed",
      resolvedBy: "ilyesse.hettenbach@cbs-consulting.de",
    }),
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Finding`).where({ ID: source.ID })).status,
    "open",
  );
});

test("an incomplete delivery request cannot be approved", async () => {
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "A1/10",
    title: "Confirm delivery",
    via: "app",
    requestType: "Delivery Risk - At Risk",
    items: [{ objectKey: "A1/10", text: "Please confirm delivery." }],
  });
  assert.equal(action.decisionReady, false);
  assert.match(action.decisionBlockReason, /required delivery date/);
  await assert.rejects(
    asWorkflowCommand(() =>
      decide(action.ID, {
        decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
        asOf: FIXTURE_AS_OF,
      }),
    ),
    (error: any) => error.status === 409,
  );
});

test("a finding exposes its active approval only while a decision or outcome is pending", async () => {
  const source = await upsertFinding(
    finding({ list: "at_risk", objectKey: "A2/10" }),
  );
  const action = await prepareAction({
    kind: "reminder",
    objectKey: "A2/10",
    title: "Reminder for A2/10",
    via: "app",
    findingID: source.ID,
    items: [{ objectKey: "A2/10", text: "Please confirm." }],
  });
  const active = await (
    SELECT.one.from("PurchasingDeskService.Findings") as any
  )
    .columns("ID", "activeActionStatus", "activeActionOverdue", {
      ref: ["activeAction"],
      expand: [{ ref: ["ID"] }],
    })
    .where({ ID: source.ID });
  assert.equal(active.activeAction.ID, action.ID);
  assert.equal(active.activeActionStatus, "needs_decision");
  assert.equal(active.activeActionOverdue, false);
  await asWorkflowCommand(() =>
    decide(action.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: FIXTURE_AS_OF,
    }),
  );
  const waiting = await (
    SELECT.one.from("PurchasingDeskService.Findings") as any
  )
    .columns("ID", "activeActionStatus", "activeActionOverdue", {
      ref: ["activeAction"],
      expand: [{ ref: ["ID"] }],
    })
    .where({ ID: source.ID });
  assert.equal(waiting.activeAction.ID, action.ID);
  assert.equal(waiting.activeActionStatus, "waiting");
  await asWorkflowCommand(() =>
    logOutcome(action.ID, {
      resolution: "confirmed",
      resolvedBy: "ilyesse.hettenbach@cbs-consulting.de",
    }),
  );
  const completed = await (
    SELECT.one.from("PurchasingDeskService.Findings") as any
  )
    .columns("ID", "activeActionStatus", "activeActionOverdue", {
      ref: ["activeAction"],
      expand: [{ ref: ["ID"] }],
    })
    .where({ ID: source.ID });
  assert.equal(completed.activeAction, null);
  assert.equal(completed.activeActionStatus, null);
});

test("delivery intervention and escalation are independent approvals for one problem", async () => {
  const problemKey = "delivery:A3/10";
  const intervention = await prepareAction({
    kind: "reminder",
    objectKey: "A3/10",
    problemKey,
    operationKey: "delivery_intervention",
    exportFormat: "reminder",
    title: "Intervene",
    via: "app",
    items: [
      {
        objectKey: "A3/10",
        problemKey,
        operationKey: "delivery_intervention",
        text: "Confirm.",
      },
    ],
  });
  const escalation = await prepareAction({
    kind: "reminder",
    objectKey: "A3/10",
    problemKey,
    operationKey: "delivery_escalation",
    exportFormat: "reminder",
    title: "Escalate",
    via: "app",
    items: [
      {
        objectKey: "A3/10",
        problemKey,
        operationKey: "delivery_escalation",
        text: "Escalate.",
      },
    ],
  });
  assert.notEqual(intervention.ID, escalation.ID);
  await assert.rejects(
    prepareAction({
      kind: "reminder",
      objectKey: "A3/10",
      problemKey,
      operationKey: "delivery_intervention",
      exportFormat: "reminder",
      title: "Duplicate",
      via: "app",
      items: [
        {
          objectKey: "A3/10",
          problemKey,
          operationKey: "delivery_intervention",
          text: "Duplicate.",
        },
      ],
    }),
    (error: any) => error.status === 409 && error.actionID === intervention.ID,
  );
});

test("compatibility reminder preparation links its delivery case and updates attention", async () => {
  await cds.ql.UPSERT.into(`${NS}.OpenItem`).entries({
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    Supplier: "S1",
    Material: "M1",
    Plant: "P1",
    RequestedDate: "2026-10-05",
    OpenQuantity: 10,
  });
  await upsertFinding(finding());
  const action = await prepareReminderAction(["4500000001/10"], "app");
  const caseID = "delivery:4500000001/10";
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: caseID });
  const link = await SELECT.one
    .from(`${NS}.CaseActions`)
    .where({ header_ID: caseID, action_ID: action.ID });
  const lock = await SELECT.one
    .from(`${NS}.OperationLocks`)
    .where({ header_ID: caseID, action_ID: action.ID });
  assert.deepEqual(
    [header.status, header.attention, header.sourceChanged],
    ["open", "awaiting_decision", false],
  );
  assert.equal(link.operation, "delivery_intervention");
  assert.equal(lock.operation, "delivery_intervention");
});

test("batch approval cannot bypass an active line-level operation", async () => {
  await prepareAction({
    kind: "reminder",
    objectKey: "B1/10",
    problemKey: "delivery:B1/10",
    operationKey: "delivery_intervention",
    title: "Single",
    via: "app",
    items: [{ objectKey: "B1/10", text: "Single." }],
  });
  await assert.rejects(
    prepareAction({
      kind: "reminder",
      objectKey: "batch",
      problemKey: "delivery-batch:B1,B2",
      operationKey: "delivery_intervention",
      title: "Batch",
      via: "app",
      items: [
        { objectKey: "B1/10", problemKey: "delivery:B1/10", text: "One." },
        { objectKey: "B2/10", problemKey: "delivery:B2/10", text: "Two." },
      ],
    }),
    (error: any) => error.status === 409,
  );
});

test("terminal decisions release the active lock and retain immutable audit history", async () => {
  const input = {
    kind: "price_clarification" as const,
    objectKey: "P1/10",
    problemKey: "price:P1/10",
    operationKey: "price_clarification" as const,
    title: "Clarify price",
    via: "app" as const,
    items: [{ objectKey: "P1/10", text: "Clarify." }],
  };
  const first = await prepareAction(input);
  for (const note of ["", " ", "\n\t"]) {
    await assert.rejects(
      asWorkflowCommand(() =>
        decline(first.ID, "ilyesse.hettenbach@cbs-consulting.de", note),
      ),
      (error: any) => error.status === 400 && /reason/.test(error.message),
    );
  }
  assert.equal(
    (await SELECT.one.from(`${NS}.Actions`).where({ ID: first.ID })).status,
    "needs_decision",
  );
  assert.deepEqual(
    (
      await SELECT.from(`${NS}.ActionEvents`).where({ action_ID: first.ID })
    ).map((event: any) => event.event),
    ["prepared"],
  );
  await asWorkflowCommand(() =>
    decline(
      first.ID,
      "ilyesse.hettenbach@cbs-consulting.de",
      "Known contract price",
    ),
  );
  const second = await prepareAction(input);
  assert.notEqual(second.ID, first.ID);
  const history = await SELECT.from(`${NS}.ActionEvents`)
    .where({ action_ID: first.ID })
    .orderBy("occurredAt");
  assert.deepEqual(
    history.map((event: any) => event.event),
    ["prepared", "declined"],
  );
  assert.equal(
    (await SELECT.from(`${NS}.ActionItems`).where({ action_ID: first.ID }))
      .length,
    1,
  );
});

test("prevention fingerprints ignore persisted detail foreign keys", async () => {
  const row = finding({
    list: "price",
    objectKey: "FP/10",
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
  });
  await writeFindings(FIXTURE_SNAPSHOT, ["price"], [row]);
  await asWorkflowCommand(() =>
    savePreventionDisposition("price:FP/10", "accepted"),
  );
  await writeFindings(FIXTURE_SNAPSHOT, ["price"], [row]);
  assert.equal(
    (await SELECT.one.from(`${NS}.Finding`).where({ ID: "price:FP/10" }))
      .status,
    "closed",
  );
});

test("steps run in A1 order, optional failures continue and required failures abort", async () => {
  assert.deepEqual(
    steps().map((s) => s.name),
    [...STEP_ORDER],
  );
  assert.deepEqual(
    [...STEP_ORDER],
    [
      "guard",
      "atrisk",
      "rules",
      "impact",
      "leadtimes",
      "planning",
      "freetext",
      "expire",
      "feed",
      "overview",
    ],
  );
  const seen: string[] = [];
  const mk = (name: string, fail = false, required = true) => ({
    name,
    required,
    async run(ctx: any) {
      seen.push(`${name}:${ctx.dryRun}`);
      if (fail) throw new Error("boom");
    },
  });
  const ctx: any = {
    user: new cds.User("ilyesse.hettenbach@cbs-consulting.de"),
    snapshotId: "s",
    asOf: "2026-10-05",
    dryRun: true,
    meter: {},
  };
  const errors = await runSteps(ctx, [mk("a"), mk("b", true, false), mk("c")]);
  assert.deepEqual(seen, ["a:true", "b:true", "c:true"]);
  assert.deepEqual(errors, ["b: boom"]);
  seen.length = 0;
  await assert.rejects(
    runSteps(ctx, [mk("a"), mk("b", true), mk("c")]),
    /boom/,
  );
  assert.deepEqual(seen, ["a:true", "b:true"]);
  assert.deepEqual(await runSteps(ctx), []);
});

test("a required preparation failure aborts later phases and discards its staged writes", async () => {
  const seen: string[] = [];
  const publication = { writes: [{ retained: "previous-good-phase" }] };
  const ctx: any = {
    snapshotId: "s",
    asOf: "2026-10-05",
    dryRun: true,
    meter: {},
    publication,
  };
  await assert.rejects(
    runSteps(ctx, [
      {
        name: "required",
        run: async () => {
          seen.push("required");
          publication.writes.push({ retained: "partial-failed-phase" });
          throw new Error("required phase failed");
        },
      },
      {
        name: "never-publish",
        run: async () => {
          seen.push("never-publish");
        },
      },
    ]),
    /required phase failed/,
  );
  assert.deepEqual(seen, ["required"]);
  assert.deepEqual(publication.writes, [{ retained: "previous-good-phase" }]);
});

test("hooks run in step order per kind", () => {
  resetHooks();
  const noop = async () => undefined;
  registerHook("confirmation", "impact.recompute", noop);
  registerHook("confirmation", "rules.confirm", noop);
  registerHook("confirmation", "atrisk.recheck", noop);
  registerHook("po_item", "feed.x", noop);
  assert.deepEqual(
    hooksFor("confirmation").map((h) => h.name),
    ["atrisk.recheck", "rules.confirm", "impact.recompute"],
  );
  resetHooks();
});

test("service: new entities are readable, stubbed operations exist and answer 501 until implemented", async () => {
  for (const set of [
    "Findings",
    "LineGrids",
    "ItemImpacts",
    "Confirmations",
    "Events",
    "Buyers",
  ]) {
    const res = await app.axios.get(`/odata/v4/desk/${set}`, AUTH);
    assert.equal(res.status, 200, set);
  }
  // Every stub name is an unbound operation of PurchasingDeskService.
  for (const op of STUB_OPERATIONS) {
    const def: any = cds.model!.definitions[`PurchasingDeskService.${op}`];
    assert.ok(
      def && (def.kind === "action" || def.kind === "function"),
      `PurchasingDeskService.${op} is an operation`,
    );
  }
  // An operation whose only on-handler is the kernel stub answers 501.
  const srv: any = await cds.connect.to("PurchasingDeskService");
  const onlyStub = STUB_OPERATIONS.find(
    (op) => srv.handlers.on.filter((h: any) => h.on === op).length === 1,
  );
  if (onlyStub) {
    await assert.rejects(
      srv.tx({ user: cds.User.privileged }).send(onlyStub, {}),
      (e: any) => e.status === 501 && /not implemented yet/.test(e.message),
    );
  }
});

test("queueFindingForLater prepares the finding's next step once (H-4 reminder text)", async () => {
  await seedFixtures(cds.db, {
    findings: [
      {
        list: "overdue",
        objectKey: "4500000009/10",
        PurchaseOrder: "4500000009",
        PurchaseOrderItem: "10",
        impactText: "Customer order at risk · 12,400 EUR",
        revenueAtRisk: 12400,
      },
      { list: "rare", objectKey: "M9|P1", nextActionKind: null },
    ],
  });
  const ok = await queueFindingForLater("overdue:4500000009/10", "app");
  assert.equal(ok.kind, "reminder");
  assert.equal(ok.findingID, "overdue:4500000009/10");
  assert.equal(ok.preparedVia, "app");
  const [line] = await SELECT.from(`${NS}.ActionItems`).where({
    action_ID: ok.ID,
  });
  assert.match(line.text, /confirm the delivery date/);
  assert.doesNotMatch(line.text, /EUR|%|probab/i);

  const again = await queueFindingForLater("overdue:4500000009/10", "app");
  assert.equal(again.ID, ok.ID);
  await assert.rejects(
    queueFindingForLater("rare:M9|P1", "app"),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    queueFindingForLater("nope", "app"),
    (e: any) => e.status === 404,
  );
});
