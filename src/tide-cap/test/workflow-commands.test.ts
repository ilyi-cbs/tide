import cds from "@sap/cds";
import { NS } from "../srv/cockpit/kernel/model-calls";
import assert from "node:assert/strict";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  executeWorkflowCommand,
  readWorkflowCommandResult,
  type WorkflowCommand,
} from "../srv/cockpit/kernel/commands";
import { ensureCase } from "../srv/cockpit/kernel/cases";
import { fail } from "../srv/cockpit/kernel/errors";
import { upsertDetectorCase } from "../srv/cockpit/kernel/detector-writers";
import { prepareAction } from "../srv/cockpit/kernel/actions";
import { CASE_ENTITIES } from "../srv/cockpit/kernel/case-preparation";

const { SELECT, DELETE, INSERT } = cds.ql;
const RECEIPTS = "tide.workflow.WorkflowCommands";
const app = cds.test(path.join(__dirname, ".."));
const authUsers = (cds.env.requires.auth as any).users;
authUsers.buyerD01Peer = {
  password: "buyerD01Peer",
  roles: ["user"],
  attr: { Plant: "DE11", PurchasingGroup: "D01" },
};
const user = new cds.User({
  id: "buyerD01",
  roles: ["user"],
  attr: { Plant: "DE11", PurchasingGroup: "D01" },
});
const command: WorkflowCommand = {
  commandID: "command-1",
  commandType: "pilot_prepare",
  arguments: { days: 14, caseID: "pdt:PILOT" },
  subjects: [{ kind: "case", ID: "pdt:PILOT" }],
};

before(async () => app);
beforeEach(async () => {
  await DELETE.from(RECEIPTS);
  await DELETE.from("tide.workflow.SubjectClaims");
  await DELETE.from("tide.workflow.OutcomeObservations");
  for (const entity of [
    "OperationLocks",
    "ActionEvents",
    "CaseActions",
    "ActionItems",
    "Actions",
  ])
    await DELETE.from(`tide.cockpit.${entity}`);
  await DELETE.from("tide.cockpit.CaseEvents");
  await DELETE.from("tide.cockpit.Cases");
});

const authorize = async () => {};
const run = <Result>(work: () => Promise<Result>) => cds.tx({ user }, work);

test("canonical manual reminders require reviewed evidence and authorize every batch item", async () => {
  const api = "/odata/v4/workflow";
  const auth = {
    auth: { username: "buyerD01", password: "buyerD01" },
    validateStatus: () => true,
  };
  const foreign = {
    auth: { username: "buyerD07", password: "buyerD07" },
    validateStatus: () => true,
  };
  for (const [PurchaseOrder, Plant, PurchasingGroup] of [
    ["REMINDER1", "DE11", "D01"],
    ["REMINDER2", "DE31", "D07"],
  ]) {
    await cds.ql.UPSERT.into("tide.s4.PurchaseOrder").entries({
      PurchaseOrder,
      PurchasingGroup,
      Supplier: "S1",
      PurchaseOrderDate: "2026-09-01",
    });
    await cds.ql.UPSERT.into("tide.s4.PurchaseOrderItem").entries({
      PurchaseOrder,
      PurchaseOrderItem: "10",
      Material: "M1",
      Plant,
      OrderQuantity: 10,
    });
    await cds.ql.UPSERT.into("tide.s4.PurchaseOrderScheduleLine").entries({
      PurchaseOrder,
      PurchaseOrderItem: "10",
      ScheduleLine: "1",
      OpenPurchaseOrderQuantity: 10,
    });
    await cds.ql.UPSERT.into(`${NS}.OpenItem`).entries({
      PurchaseOrder,
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant,
      RequestedDate: "2026-10-05",
      OpenQuantity: 10,
      expectedP50: "2026-10-07",
    });
  }
  const items = ["REMINDER1/10"];
  const contextPath = `${api}/deliveryPreparationContext(items=@items)?@items=${encodeURIComponent(JSON.stringify(items))}`;
  const context = await app.GET(contextPath, auth);
  assert.equal(context.status, 200, JSON.stringify(context.data));
  const reviewed = JSON.parse(context.data.value);
  assert.deepEqual(reviewed.items, items);
  assert.match(
    reviewed.instructions[0],
    /REMINDER1\/10.*2026-10-05.*2026-10-07/,
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 0);
  assert.equal((await SELECT.from(`${NS}.Actions`)).length, 0);
  const payload = {
    items,
    expectedEvidence: reviewed.expectedEvidence,
    commandID: "manual-reminder",
  };
  assert.equal(
    (
      await app.POST(
        `${api}/prepareDeliveryReminder`,
        { ...payload, expectedEvidence: "stale", commandID: "stale-reminder" },
        auth,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await app.POST(
        `${api}/prepareDeliveryReminder`,
        {
          ...payload,
          items: [...items, "REMINDER2/10"],
          commandID: "mixed-reminder",
        },
        auth,
      )
    ).status,
    404,
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 0);
  assert.equal((await SELECT.from(`${NS}.Cases`)).length, 0);
  const prepared = await app.POST(
    `${api}/prepareDeliveryReminder`,
    payload,
    auth,
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const frozenItems = await SELECT.from(`${NS}.ActionItems`).where({
    action_ID: prepared.data.actionID,
  });
  const header = await SELECT.one
    .from(`${NS}.Cases`)
    .where({ ID: prepared.data.caseID });
  assert.deepEqual(
    [header.Plant, header.PurchasingGroup, header.status],
    ["DE11", "D01", "open"],
  );
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 2);
  await cds.ql.UPDATE.entity(`${NS}.OpenItem`)
    .where({ PurchaseOrder: "REMINDER1", PurchaseOrderItem: "10" })
    .with({ expectedP50: "2026-10-09" });
  const replay = await app.POST(
    `${api}/prepareDeliveryReminder`,
    payload,
    auth,
  );
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.deepEqual(replay.data, prepared.data);
  assert.equal(
    (
      await app.POST(
        `${api}/prepareDeliveryReminder`,
        { ...payload, commandID: "competing-reminder" },
        auth,
      )
    ).status,
    409,
  );
  assert.equal(
    (await app.POST(`${api}/prepareDeliveryReminder`, payload, foreign)).status,
    404,
  );
  assert.deepEqual(
    await SELECT.from(`${NS}.ActionItems`).where({
      action_ID: prepared.data.actionID,
    }),
    frozenItems,
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
  const approved = await app.POST(
    `${api}/approveAction`,
    {
      actionID: prepared.data.actionID,
      commandID: "approve-reminder",
      expectedModifiedAt: prepared.data.actionModifiedAt,
    },
    auth,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, "waiting");
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: prepared.data.caseID }))
      .status,
    "open",
  );
  const beforeLegacy = {
    actions: await SELECT.from(`${NS}.Actions`),
    events: await SELECT.from(`${NS}.ActionEvents`),
    receipts: await SELECT.from(RECEIPTS),
  };
  assert.equal(
    (await app.POST("/odata/v4/desk/prepareReminder", { items }, auth))
      .status,
    410,
  );
  for (const operation of ["decide", "decline", "logOutcome"]) {
    const rejected = await app.POST(
      `/odata/v4/desk/Actions('${prepared.data.actionID}')/PurchasingDeskService.${operation}`,
      {
        note: "Retired route",
        expectedModifiedAt: approved.data.actionModifiedAt,
        ...(operation === "logOutcome" ? { resolution: "confirmed" } : {}),
      },
      auth,
    );
    assert.equal(
      rejected.status,
      410,
      `${operation}: ${JSON.stringify(rejected.data)}`,
    );
  }
  assert.deepEqual(
    {
      actions: await SELECT.from(`${NS}.Actions`),
      events: await SELECT.from(`${NS}.ActionEvents`),
      receipts: await SELECT.from(RECEIPTS),
    },
    beforeLegacy,
  );
});

test("command receipt returns the committed result on exact replay without duplicate state or events", async () => {
  let executions = 0;
  const execute = async () => {
    executions++;
    await ensureCase({
      ID: "pdt:PILOT",
      kind: "supplier_planned_time",
      Plant: "DE11",
      PurchasingGroup: "D01",
    });
    return { ID: "pdt:PILOT", days: 14, executions };
  };
  const first = await run(() =>
    executeWorkflowCommand(command, { authorize, execute }),
  );
  const replay = await run(() =>
    executeWorkflowCommand(
      { ...command, arguments: { caseID: "pdt:PILOT", days: 14 } },
      { authorize, execute },
    ),
  );
  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
  assert.equal((await SELECT.from("tide.cockpit.CaseEvents")).length, 1);
});

test("command receipt rejects changed payload or type for the same identity", async () => {
  const execute = async () => ({ days: 14 });
  await run(() => executeWorkflowCommand(command, { authorize, execute }));
  for (const changed of [
    { ...command, arguments: { ...command.arguments, days: 15 } },
    { ...command, commandType: "pilot_accept" },
    { ...command, subjects: [{ kind: "case" as const, ID: "pdt:OTHER" }] },
  ])
    await assert.rejects(
      run(() => executeWorkflowCommand(changed, { authorize, execute })),
      (error: any) => error.status === 409,
    );
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
});

test("receipt lookup verifies exact arguments and type without executing or disclosing to revoked callers", async () => {
  let executions = 0;
  const committed = await run(() =>
    executeWorkflowCommand(command, {
      authorize,
      execute: async () => ({ executions: ++executions }),
    }),
  );
  assert.deepEqual(
    await run(() => readWorkflowCommandResult(command.commandID, authorize)),
    committed,
  );
  const expected = {
    commandType: command.commandType,
    arguments: JSON.stringify({ caseID: "pdt:PILOT", days: 14 }),
  };
  assert.deepEqual(
    await run(() =>
      readWorkflowCommandResult(command.commandID, authorize, expected),
    ),
    {
      ...committed,
      commandID: command.commandID,
      commandType: command.commandType,
      payloadMatched: true,
    },
  );
  for (const mismatch of [
    {
      ...expected,
      arguments: JSON.stringify({ ...command.arguments, days: 15 }),
    },
    { ...expected, commandType: "pilot_accept" },
  ])
    await assert.rejects(
      run(() =>
        readWorkflowCommandResult(command.commandID, authorize, mismatch),
      ),
      (error: any) => error.status === 409,
    );
  for (const invalid of ["not-json", "[]", "null", "14"]) {
    await assert.rejects(
      run(() =>
        readWorkflowCommandResult(command.commandID, authorize, {
          ...expected,
          arguments: invalid,
        }),
      ),
      (error: any) => error.status === 400,
    );
  }
  await assert.rejects(
    run(() =>
      readWorkflowCommandResult(
        command.commandID,
        async () => {
          throw fail(404, "Grant revoked");
        },
        expected,
      ),
    ),
    (error: any) => error.status === 404,
  );
  const other = new cds.User({ id: "buyerD07", roles: ["user"], attr: {} });
  assert.equal(
    await cds.tx({ user: other }, () =>
      readWorkflowCommandResult(command.commandID, authorize, expected),
    ),
    null,
  );
  assert.equal(executions, 1);
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
});

test("concurrent identical commands execute once and return one committed result", async () => {
  let executions = 0;
  const execute = async () => ({ executions: ++executions });
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      run(() => executeWorkflowCommand(command, { authorize, execute })),
    ),
  );
  assert.equal(executions, 1);
  assert.deepEqual(
    results,
    Array.from({ length: 4 }, () => ({ executions: 1 })),
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
});

test("injected failure rolls back command identity, business state and owner history", async () => {
  const execute = async () => {
    await ensureCase({ ID: "pdt:PILOT", kind: "supplier_planned_time" });
    throw fail(500, "Injected after business state and history");
  };
  await assert.rejects(
    run(() => executeWorkflowCommand(command, { authorize, execute })),
  );
  for (const entity of [
    RECEIPTS,
    "tide.cockpit.Cases",
    "tide.cockpit.CaseEvents",
  ])
    assert.equal((await SELECT.from(entity)).length, 0);
  const retry = await run(() =>
    executeWorkflowCommand(command, {
      authorize,
      execute: async () => ({ retried: true }),
    }),
  );
  assert.deepEqual(retry, { retried: true });
});

test("exact replay reauthorizes retained subjects before returning a committed result", async () => {
  await run(() =>
    executeWorkflowCommand(command, {
      authorize,
      execute: async () => ({ secret: "retained" }),
    }),
  );
  let executions = 0;
  await assert.rejects(
    run(() =>
      executeWorkflowCommand(command, {
        authorize: async (subjects) => {
          assert.deepEqual(subjects, command.subjects);
          throw fail(403, "Grant revoked");
        },
        execute: async () => ({ executions: ++executions }),
      }),
    ),
    (error: any) => error.status === 403,
  );
  assert.equal(executions, 0);
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
});

test("denied initial commands leave no persisted receipt", async () => {
  await assert.rejects(
    run(() =>
      executeWorkflowCommand(command, {
        authorize: async () => {
          throw fail(403, "Denied");
        },
        execute: async () => ({ forbidden: true }),
      }),
    ),
    (error: any) => error.status === 403,
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 0);
});

test("principal and tenant partitions come only from trusted CAP context", async () => {
  const other = new cds.User({ id: "buyerD07", roles: ["user"], attr: {} });
  const execute = async () => ({
    principal: cds.context?.user.id,
    tenant: cds.context?.tenant ?? "",
  });
  const input = {
    ...command,
    arguments: { principal: "spoofed", tenant: "spoofed" },
  };
  const first = await run(() =>
    executeWorkflowCommand(input, { authorize, execute }),
  );
  const second = await cds.tx({ user: other }, () =>
    executeWorkflowCommand(input, { authorize, execute }),
  );
  const third = await cds.tx({ user, tenant: "tenant-two" }, () =>
    executeWorkflowCommand(input, { authorize, execute }),
  );
  assert.deepEqual(
    [first.principal, second.principal, third.tenant],
    ["buyerD01", "buyerD07", "tenant-two"],
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 3);
});

async function seedPilot(overrides: Record<string, unknown> = {}) {
  const finding = await upsertDetectorCase({
    list: "pdt",
    objectKey: "PILOT-M1|PILOT-S1|DE11",
    Material: "PILOT-M1",
    Supplier: "PILOT-S1",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Supplier planned time",
    source: "empirical",
    nextActionKind: "pdt_change",
    pdtDetail: {
      currentDays: 2,
      proposalDays: 14,
      purchasingInfoRecord: "PILOT-IR1",
    },
    ...overrides,
  } as any);
  return SELECT.one.from("tide.cockpit.Cases").where({ ID: finding.ID });
}

const auth = {
  auth: { username: "buyerD01", password: "buyerD01" },
  validateStatus: () => true,
};
const api = "/odata/v4/workflow";

for (const [list, detailName, detail, resolution] of [
  ["at_risk", "atRiskDetail", { gapDays: 2 }, "confirmed"],
  [
    "price",
    "priceDetail",
    { currentPrice: 120, priorMedian: 12, currency: "EUR" },
    "confirmed",
  ],
  ["duplicate", "duplicateDetail", { materialNumbers: "M1,M2" }, "confirmed"],
  ["rare", "rareDetail", { firstPair: "MRP type / lot size" }, "confirmed"],
  ["mm_pdt", "mmPdtDetail", { masterDays: 2, proposalDays: 14 }, "posted"],
] as const)
  test(`${list}: canonical Case command freezes, replays and records partial and complete work independently`, async () => {
    const finding = await upsertDetectorCase({
      list,
      objectKey: "COMMAND/10",
      PurchaseOrder: "COMMAND",
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "Canonical operation",
      dueDate: "2026-10-01",
      source: "rule",
      [detailName]: detail,
    } as any);
    const header = await SELECT.one.from(`${NS}.Cases`).where({
      ID: list === "at_risk" ? "delivery:COMMAND/10" : finding.ID,
    });
    const payload = {
      caseID: header.ID,
      commandID: `prepare-${list}`,
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
      ...(list === "price"
        ? {
            responsiblePerson: "Buyer D01",
            responsibleMessage: "Clarify current price",
          }
        : {}),
    };
    const prepared = await app.POST(`${api}/prepareCaseAction`, payload, auth);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
    assert.ok(
      (
        await SELECT.from("tide.workflow.SubjectClaims").where({
          caseID: header.ID,
        })
      ).length >= 2,
    );
    const aliasID = `alias:${header.ID}`;
    await INSERT.into(`${NS}.Cases`).entries({ ...header, ID: aliasID });
    const entity = `${NS}.${CASE_ENTITIES[header.kind]}`;
    const represented = await SELECT.one
      .from(entity)
      .where({ header_ID: header.ID });
    await INSERT.into(entity).entries({ ...represented, header_ID: aliasID });
    const competing = await app.POST(
      `${api}/prepareCaseAction`,
      {
        ...payload,
        caseID: aliasID,
        commandID: `competing-${list}`,
      },
      auth,
    );
    assert.equal(competing.status, 409, JSON.stringify(competing.data));
    assert.equal((await SELECT.from(`${NS}.Actions`)).length, 1);
    assert.equal(
      (await SELECT.from(`${NS}.OperationLocks`).where({ header_ID: aliasID }))
        .length,
      0,
    );
    assert.equal(
      (await SELECT.from(`${NS}.CaseEvents`).where({ header_ID: aliasID }))
        .length,
      0,
    );
    assert.equal(
      (await SELECT.from(RECEIPTS).where({ commandID: `competing-${list}` }))
        .length,
      0,
    );
    if (list !== "at_risk") {
      const exception = await app.POST(
        `${api}/acceptCaseException`,
        {
          caseID: aliasID,
          commandID: `competing-exception-${list}`,
          expectedModifiedAt: header.modifiedAt,
          expectedFingerprint: header.sourceFingerprint,
          note: "Cannot bypass another active source obligation",
        },
        auth,
      );
      assert.equal(exception.status, 409, JSON.stringify(exception.data));
      assert.equal(
        (await SELECT.one.from(`${NS}.Cases`).where({ ID: aliasID })).status,
        "open",
      );
      assert.equal(
        (
          await SELECT.from(RECEIPTS).where({
            commandID: `competing-exception-${list}`,
          })
        ).length,
        0,
      );
    }
    if (list === "price") {
      const changedSelection = await app.POST(
        `${api}/prepareCaseAction`,
        {
          ...payload,
          commandID: "changed-active-price-instructions",
          expectedModifiedAt: prepared.data.caseModifiedAt,
          responsibleMessage: "Different unreviewed instructions",
        },
        auth,
      );
      assert.equal(
        changedSelection.status,
        409,
        JSON.stringify(changedSelection.data),
      );
      assert.equal(
        (
          await SELECT.from(RECEIPTS).where({
            commandID: "changed-active-price-instructions",
          })
        ).length,
        0,
      );
    }
    assert.deepEqual(
      (await app.POST(`${api}/prepareCaseAction`, payload, auth)).data,
      prepared.data,
    );
    const agent = await cds.connect.to("CockpitMcpService");
    const { ["@odata.context"]: metadata, ...committedResult } = prepared.data;
    assert.equal(metadata, "$metadata#WorkflowService.CommandResult");
    assert.deepEqual(
      await agent.tx({ user }, (tx) =>
        tx.send("prepare_case_action", payload),
      ),
      committedResult,
    );
    assert.equal((await SELECT.from(`${NS}.Actions`)).length, 1);
    assert.equal(
      (
        await app.POST(
          `${api}/prepareCaseAction`,
          {
            ...payload,
            responsibleMessage:
              "Changed payload cannot replace a retained command",
          },
          auth,
        )
      ).status,
      409,
    );
    const foreign = {
      ...auth,
      auth: { username: "buyerD07", password: "buyerD07" },
    };
    assert.equal(
      (
        await app.POST(
          `${api}/prepareCaseAction`,
          {
            ...payload,
            commandID: `foreign-${list}`,
          },
          foreign,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await app.POST(
          `${api}/prepareCaseAction`,
          { ...payload, commandID: `stale-${list}` },
          auth,
        )
      ).status,
      409,
    );
    const approved = await app.POST(
      `${api}/approveAction`,
      {
        actionID: prepared.data.actionID,
        commandID: `approve-${list}`,
        expectedModifiedAt: prepared.data.actionModifiedAt,
      },
      auth,
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const partialPayload = {
      actionID: prepared.data.actionID,
      resolution,
      completeness: "partial",
      note: "External work partially reported",
      commandID: `partial-${list}`,
      expectedModifiedAt: approved.data.actionModifiedAt,
    };
    const partial = await app.POST(
      `${api}/recordActionOutcome`,
      partialPayload,
      auth,
    );
    assert.equal(partial.status, 200, JSON.stringify(partial.data));
    assert.equal(partial.data.status, "waiting");
    assert.deepEqual(
      (await app.POST(`${api}/recordActionOutcome`, partialPayload, auth)).data,
      partial.data,
    );
    const completed = await app.POST(
      `${api}/recordActionOutcome`,
      {
        ...partialPayload,
        completeness: "complete",
        commandID: `complete-${list}`,
        expectedModifiedAt: partial.data.actionModifiedAt,
      },
      auth,
    );
    assert.equal(completed.status, 200, JSON.stringify(completed.data));
    assert.equal(completed.data.status, "resolved");
    assert.equal(
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID })).status,
      "open",
    );
    assert.equal(
      (await SELECT.from("tide.workflow.OutcomeObservations")).length,
      2,
    );
    assert.equal(
      (
        await SELECT.from(`${NS}.CaseEvents`).where({
          event: "source_resolved",
        })
      ).length,
      0,
    );
    assert.equal((await SELECT.from(`${NS}.OperationLocks`)).length, 0);
  });

test("two authorized buyers race reviewed HTTP commands and only one decision commits", async () => {
  const header = await seedPilot();
  const peerAuth = {
    ...auth,
    auth: { username: "buyerD01Peer", password: "buyerD01Peer" },
  };
  const payload = {
    caseID: header.ID,
    days: 14,
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  const preparations = await Promise.all([
    app.axios.post(
      `${api}/prepareSupplierPlannedTimeAction`,
      { ...payload, commandID: "buyer-one-prepare" },
      auth,
    ),
    app.axios.post(
      `${api}/prepareSupplierPlannedTimeAction`,
      { ...payload, commandID: "buyer-two-prepare" },
      peerAuth,
    ),
  ]);
  assert.deepEqual(
    preparations.map((response: { status: number }) => response.status).sort(),
    [200, 409],
  );
  const action = await SELECT.one.from("tide.cockpit.Actions");
  const decisions = await Promise.all([
    app.axios.post(
      `${api}/approveAction`,
      {
        actionID: action.ID,
        expectedModifiedAt: action.modifiedAt,
        commandID: "buyer-one-decide",
      },
      auth,
    ),
    app.axios.post(
      `${api}/declineAction`,
      {
        actionID: action.ID,
        expectedModifiedAt: action.modifiedAt,
        commandID: "buyer-two-decide",
        note: "Choose not to change this setting",
      },
      peerAuth,
    ),
  ]);
  assert.deepEqual(
    decisions.map((response: { status: number }) => response.status).sort(),
    [200, 409],
  );
  assert.equal((await SELECT.from("tide.cockpit.Actions")).length, 1);
  assert.equal((await SELECT.from(RECEIPTS)).length, 2);
  const events = await SELECT.from("tide.cockpit.ActionEvents").where({
    action_ID: action.ID,
  });
  assert.equal(events.length, 2);
  assert.ok(events.every((event: any) => event.command_ID));
  assert.equal(
    (await SELECT.one.from("tide.cockpit.Cases").where({ ID: header.ID }))
      .status,
    "open",
  );
});

test("revoked HTTP scope denies both saved-result lookup and exact replay without new artifacts", async () => {
  const header = await seedPilot();
  const payload = {
    caseID: header.ID,
    days: 14,
    commandID: "revoked-http",
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  const prepared = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    payload,
    auth,
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const history = await SELECT.from("tide.cockpit.ActionEvents");
  const previousPlant = authUsers.buyerD01.attr.Plant;
  try {
    authUsers.buyerD01.attr.Plant = "DE31";
    const replay = await app.axios.post(
      `${api}/prepareSupplierPlannedTimeAction`,
      payload,
      auth,
    );
    const saved = await app.axios.get(
      `${api}/commandResult(commandID='revoked-http')`,
      auth,
    );
    assert.equal(replay.status, 404, JSON.stringify(replay.data));
    assert.equal(saved.status, 404, JSON.stringify(saved.data));
    assert.equal((await SELECT.from(RECEIPTS)).length, 1);
    assert.deepEqual(await SELECT.from("tide.cockpit.ActionEvents"), history);
  } finally {
    authUsers.buyerD01.attr.Plant = previousPlant;
  }
});

test("material source confirmation requires fresh exact master-field proof after approval", async () => {
  const { upsertRows } = await import("../srv/cockpit/feed/store.js");
  const { reconcileMaterialPlannedTimes } =
    await import("../srv/cockpit/leadtimes/actions.js");
  const finding = await upsertDetectorCase({
    list: "mm_pdt",
    objectKey: "SOURCE-MATERIAL|DE11",
    Material: "SOURCE-MATERIAL",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Material master duration",
    source: "empirical",
    mmPdtDetail: { masterDays: 2, proposalDays: 14 },
  } as any);
  const header = await SELECT.one.from(`${NS}.Cases`).where({ ID: finding.ID });
  const prepared = await app.POST(
    `${api}/prepareCaseAction`,
    {
      caseID: header.ID,
      commandID: "material-source-prepare",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    auth,
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  await upsertRows({
    ProductPlantSupplyPlanning: [
      {
        Product: "SOURCE-MATERIAL",
        Plant: "DE11",
        PlannedDeliveryDurationInDays: 14,
      },
    ],
  });
  const approved = await app.POST(
    `${api}/approveAction`,
    {
      actionID: prepared.data.actionID,
      commandID: "material-source-approve",
      expectedModifiedAt: prepared.data.actionModifiedAt,
    },
    auth,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(await run(() => reconcileMaterialPlannedTimes()), 0);
  await upsertRows({
    ProductPlantSupplyPlanning: [
      {
        Product: "SOURCE-MATERIAL",
        Plant: "DE11",
        MRPResponsible: "123",
      },
    ],
  });
  assert.equal(await run(() => reconcileMaterialPlannedTimes()), 0);
  await upsertRows({
    ProductPlantSupplyPlanning: [
      {
        Product: "SOURCE-MATERIAL",
        Plant: "DE11",
        PlannedDeliveryDurationInDays: 13,
      },
    ],
  });
  assert.equal(await run(() => reconcileMaterialPlannedTimes()), 0);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID })).status,
    "open",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Actions`)
        .where({ ID: prepared.data.actionID })
    ).status,
    "waiting",
  );
  await upsertRows({
    ProductPlantSupplyPlanning: [
      {
        Product: "SOURCE-MATERIAL",
        Plant: "DE11",
        PlannedDeliveryDurationInDays: 14,
      },
    ],
  });
  assert.equal(await run(() => reconcileMaterialPlannedTimes()), 1);
  assert.equal(await run(() => reconcileMaterialPlannedTimes()), 0);
  const receipt = await SELECT.one
    .from(RECEIPTS)
    .where({ commandType: "reconcileMaterialPlannedTime" });
  assert.ok(receipt.committedAt);
  const observation = await SELECT.one
    .from("tide.workflow.OutcomeObservations")
    .where({ command_ID: receipt.ID });
  assert.equal(observation.completeness, "complete");
  assert.equal(observation.origin, "source_refresh");
  assert.equal(observation.field, "PlannedDeliveryDurationInDays");
  assert.equal(observation.value, "14");
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID })).closure,
    "resolved_at_source",
  );
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.Actions`)
        .where({ ID: prepared.data.actionID })
    ).status,
    "resolved",
  );
  assert.equal(
    (
      await SELECT.from("tide.workflow.SubjectClaims").where({
        caseID: header.ID,
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: header.ID,
        event: "source_resolved",
      })
    ).length,
    1,
  );
  const closed = await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID });
  assert.equal(JSON.parse(closed.resolvedSourceCondition).days, 14);
  for (const days of [14, null, " ", false, 14]) {
    await upsertDetectorCase({
      list: "mm_pdt",
      objectKey: "SOURCE-MATERIAL|DE11",
      Material: "SOURCE-MATERIAL",
      Plant: "DE11",
      PurchasingGroup: "D01",
      itemTitle: "Recalculated material signal",
      source: "empirical",
      mmPdtDetail: { masterDays: days, proposalDays: 21, orders12m: 99 },
    } as any);
    assert.equal(
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID })).status,
      "closed",
    );
  }
  await upsertDetectorCase({
    list: "mm_pdt",
    objectKey: "SOURCE-MATERIAL|DE11",
    Material: "SOURCE-MATERIAL",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Maintained material duration changed",
    source: "empirical",
    mmPdtDetail: { masterDays: 15, proposalDays: 21 },
  } as any);
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID })).status,
    "open",
  );
  assert.equal(await run(() => reconcileMaterialPlannedTimes()), 0);
});

test("supplier source confirmation commits one receipt, immutable proof and linked transitions", async () => {
  const { upsertRows } = await import("../srv/cockpit/feed/store.js");
  const { reconcileSupplierPlannedTimes } =
    await import("../srv/cockpit/leadtimes/actions.js");
  const header = await seedPilot();
  const prepared = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    {
      caseID: header.ID,
      days: 14,
      commandID: "source-prepare",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    auth,
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const action = await SELECT.one
    .from("tide.cockpit.Actions")
    .where({ ID: prepared.data.actionID });
  const approved = await app.axios.post(
    `${api}/approveAction`,
    {
      actionID: action.ID,
      commandID: "source-approve",
      expectedModifiedAt: action.modifiedAt,
    },
    auth,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  await DELETE.from("tide.s4.PurgInfoRecdOrgPlantData").where({
    PurchasingInfoRecord: "PILOT-IR1",
  });
  await upsertRows({
    PurgInfoRecdOrgPlantData: [
      {
        PurchasingInfoRecord: "PILOT-IR1",
        PurchasingInfoRecordCategory: "0",
        PurchasingOrganization: "1000",
        Plant: "DE11",
        Material: "PILOT-M1",
        Supplier: "PILOT-S1",
        MaterialPlannedDeliveryDurn: 14,
      },
    ],
  });
  let injectSourceFailure = true;
  cds.db.before("INSERT", "tide.cockpit.CaseEvents", (req: cds.Request) => {
    const entries = (req.query as any)?.INSERT?.entries ?? [];
    if (
      injectSourceFailure &&
      entries.some(
        (entry: any) =>
          entry.header_ID === header.ID && entry.event === "source_resolved",
      )
    ) {
      injectSourceFailure = false;
      throw fail(500, "Injected source closure history failure");
    }
  });
  const history = await SELECT.from("tide.cockpit.ActionEvents");
  await assert.rejects(
    run(() => reconcileSupplierPlannedTimes()),
    /Injected source closure history failure/,
  );
  assert.equal(
    (
      await SELECT.from(RECEIPTS).where({
        commandType: "reconcileSupplierPlannedTime",
      })
    ).length,
    0,
  );
  assert.equal(
    (await SELECT.from("tide.workflow.OutcomeObservations")).length,
    0,
  );
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 2);
  assert.equal(
    (await SELECT.one.from("tide.cockpit.Cases").where({ ID: header.ID }))
      .status,
    "open",
  );
  assert.equal(
    (await SELECT.one.from("tide.cockpit.Actions").where({ ID: action.ID }))
      .status,
    "waiting",
  );
  assert.deepEqual(await SELECT.from("tide.cockpit.ActionEvents"), history);
  assert.equal(await run(() => reconcileSupplierPlannedTimes()), 1);
  assert.equal(await run(() => reconcileSupplierPlannedTimes()), 0);
  const receipts = await SELECT.from(RECEIPTS).where({
    commandType: "reconcileSupplierPlannedTime",
  });
  assert.equal(receipts.length, 1);
  const observation = await SELECT.one
    .from("tide.workflow.OutcomeObservations")
    .where({ command_ID: receipts[0].ID });
  assert.equal(observation.origin, "source_refresh");
  assert.equal(observation.completeness, "complete");
  assert.equal(observation.value, "14");
  const events = await SELECT.from("tide.cockpit.CaseEvents").where({
    event: "source_resolved",
    header_ID: header.ID,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].command_ID, receipts[0].ID);
  assert.equal(
    (await SELECT.one.from("tide.cockpit.Cases").where({ ID: header.ID }))
      .closure,
    "resolved_at_source",
  );
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 0);
});

test("retired supplier preparation refuses the legacy HTTP route without state or history", async () => {
  const header = await seedPilot();
  const history = await SELECT.from("tide.cockpit.CaseEvents");
  const response = await app.axios.post(
    `/odata/v4/desk/SupplierPlannedTimes('${encodeURIComponent(header.ID)}')/PurchasingDeskService.prepareAction`,
    { days: 14, expectedFingerprint: header.sourceFingerprint },
    auth,
  );
  assert.equal(response.status, 410, JSON.stringify(response.data));
  assert.match(response.data.error.message, /WorkflowService/);
  assert.equal((await SELECT.from("tide.cockpit.Actions")).length, 0);
  assert.equal((await SELECT.from(RECEIPTS)).length, 0);
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 0);
  assert.deepEqual(await SELECT.from("tide.cockpit.CaseEvents"), history);
});

test("retired supplier exception and decision HTTP routes cannot mutate workflow-owned state", async () => {
  const header = await seedPilot();
  const exception = await app.axios.post(
    `/odata/v4/desk/SupplierPlannedTimes('${encodeURIComponent(header.ID)}')/PurchasingDeskService.acceptException`,
    { expectedFingerprint: header.sourceFingerprint, note: "Legacy exception" },
    auth,
  );
  assert.equal(exception.status, 410, JSON.stringify(exception.data));
  const prepared = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    {
      caseID: header.ID,
      days: 14,
      commandID: "retirement-prepare",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    auth,
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const action = await SELECT.one
    .from("tide.cockpit.Actions")
    .where({ ID: prepared.data.actionID });
  const events = await SELECT.from("tide.cockpit.ActionEvents");
  for (const operation of ["decide", "decline"]) {
    const response = await app.axios.post(
      `/odata/v4/desk/Actions(${action.ID})/PurchasingDeskService.${operation}`,
      { note: "Legacy decision", expectedModifiedAt: action.modifiedAt },
      auth,
    );
    assert.equal(response.status, 410, JSON.stringify(response.data));
  }
  assert.equal(
    (await SELECT.one.from("tide.cockpit.Actions").where({ ID: action.ID }))
      .status,
    "needs_decision",
  );
  assert.deepEqual(await SELECT.from("tide.cockpit.ActionEvents"), events);
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
});

test("HTTP pilot prepares one frozen proposal, replays and reconciles its committed result", async () => {
  const header = await seedPilot();
  const payload = {
    caseID: header.ID,
    days: 14,
    commandID: "http-prepare",
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  const first = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    payload,
    auth,
  );
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const replay = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    payload,
    auth,
  );
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.deepEqual(replay.data, first.data);
  const changed = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    { ...payload, days: 15 },
    auth,
  );
  assert.equal(changed.status, 409);
  const reconciled = await app.axios.get(
    `${api}/commandResult(commandID='http-prepare')`,
    auth,
  );
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.data));
  assert.deepEqual(reconciled.data, first.data);
  assert.equal((await SELECT.from("tide.cockpit.Actions")).length, 1);
  const item = await SELECT.one
    .from("tide.cockpit.ActionItems")
    .where({ action_ID: first.data.actionID });
  assert.deepEqual([item.oldValue, item.newValue], ["2", "14"]);
});

test("HTTP pilot rejects missing or stale versions without receipt, Action or claim", async () => {
  const header = await seedPilot();
  for (const expectedModifiedAt of [undefined, "2000-01-01T00:00:00.000Z"]) {
    const response = await app.axios.post(
      `${api}/prepareSupplierPlannedTimeAction`,
      {
        caseID: header.ID,
        commandID: "stale-command",
        expectedFingerprint: header.sourceFingerprint,
        expectedModifiedAt,
      },
      auth,
    );
    assert.equal(
      response.status,
      expectedModifiedAt ? 409 : 400,
      JSON.stringify(response.data),
    );
  }
  for (const entity of [
    RECEIPTS,
    "tide.cockpit.Actions",
    "tide.cockpit.OperationLocks",
  ])
    assert.equal((await SELECT.from(entity)).length, 0);
});

test("HTTP exception freezes a reason and command-linked history and permits exact replay", async () => {
  const header = await seedPilot();
  const payload = {
    caseID: header.ID,
    note: "Current setting is contractually required",
    commandID: "http-exception",
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  const first = await app.axios.post(
    `${api}/acceptSupplierPlannedTimeException`,
    payload,
    auth,
  );
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const replay = await app.axios.post(
    `${api}/acceptSupplierPlannedTimeException`,
    payload,
    auth,
  );
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.deepEqual(replay.data, first.data);
  const event = await SELECT.one
    .from("tide.cockpit.CaseEvents")
    .where({ header_ID: header.ID, event: "exception_accepted" });
  const receipt = await SELECT.one
    .from(RECEIPTS)
    .where({ commandID: payload.commandID });
  assert.equal(event.command_ID, receipt.ID);
  assert.equal(event.actor, "buyerD01");
  assert.equal(event.reason, payload.note);
  assert.equal(
    (
      await SELECT.from("tide.cockpit.CaseEvents").where({
        header_ID: header.ID,
        event: "exception_accepted",
      })
    ).length,
    1,
  );
});

test("HTTP pilot approval waits without closing the Case and decline requires its exact version", async () => {
  const header = await seedPilot();
  const prepared = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    {
      caseID: header.ID,
      commandID: "approve-prepare",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    auth,
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const payload = {
    actionID: prepared.data.actionID,
    commandID: "http-approve",
    expectedModifiedAt: prepared.data.actionModifiedAt,
  };
  const approved = await app.axios.post(`${api}/approveAction`, payload, auth);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, "waiting");
  const replay = await app.axios.post(`${api}/approveAction`, payload, auth);
  assert.deepEqual(replay.data, approved.data);
  const caseRow = await SELECT.one
    .from("tide.cockpit.Cases")
    .where({ ID: header.ID });
  assert.equal(caseRow.status, "open");
  const event = await SELECT.one
    .from("tide.cockpit.ActionEvents")
    .where({ action_ID: payload.actionID, event: "approved" });
  const receipt = await SELECT.one
    .from(RECEIPTS)
    .where({ commandID: payload.commandID });
  assert.equal(event.command_ID, receipt.ID);
  const staleDecline = await app.axios.post(
    `${api}/declineAction`,
    { ...payload, commandID: "stale-decline", note: "No longer needed" },
    auth,
  );
  assert.equal(staleDecline.status, 409);
});

test("correlated grants authorize complete pairs without Cartesian-product access or array guessing", async () => {
  const workflow: any = await cds.connect.to("WorkflowService");
  const paired = new cds.User({ id: "multi-buyer", roles: ["user"], attr: {} });
  Object.assign(paired.attr, {
    ScopeGrants: [
      { Plant: "DE11", PurchasingGroup: "D01" },
      { Plant: "DE31", PurchasingGroup: "D07" },
    ],
  });
  const header = await seedPilot();
  const payload = {
    caseID: header.ID,
    commandID: "paired-command",
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  const prepared = await cds.tx({ user: paired }, () =>
    workflow.send("prepareSupplierPlannedTimeAction", payload),
  );
  assert.ok(prepared.actionID);
  const crossed = await seedPilot({
    objectKey: "CROSSED",
    Plant: "DE31",
    PurchasingGroup: "D01",
  });
  await assert.rejects(
    cds.tx({ user: paired }, () =>
      workflow.send("prepareSupplierPlannedTimeAction", {
        ...payload,
        caseID: crossed.ID,
        commandID: "crossed-command",
        expectedModifiedAt: crossed.modifiedAt,
        expectedFingerprint: crossed.sourceFingerprint,
      }),
    ),
    (error: any) => Number(error.status ?? error.code) === 404,
  );
  const ambiguous = new cds.User({
    id: "array-buyer",
    roles: ["user"],
    attr: {},
  });
  Object.assign(ambiguous.attr, {
    Plant: ["DE11", "DE31"],
    PurchasingGroup: ["D01", "D07"],
  });
  await assert.rejects(
    cds.tx({ user: ambiguous }, () =>
      workflow.send("prepareSupplierPlannedTimeAction", payload),
    ),
    (error: any) => Number(error.status ?? error.code) === 404,
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
});

test("a mixed-scope linked Action denies approval without partial state, history or receipt", async () => {
  await ensureCase({
    ID: "pdt:OWN",
    kind: "supplier_planned_time",
    Plant: "DE11",
    PurchasingGroup: "D01",
  });
  await ensureCase({
    ID: "pdt:FOREIGN",
    kind: "supplier_planned_time",
    Plant: "DE31",
    PurchasingGroup: "D07",
  });
  const action = await run(() =>
    executeWorkflowCommand(
      {
        commandID: "mixed-fixture",
        commandType: "fixture_prepare",
        arguments: {},
        subjects: [
          { kind: "case", ID: "pdt:OWN" },
          { kind: "case", ID: "pdt:FOREIGN" },
        ],
      },
      {
        authorize,
        execute: () =>
          prepareAction({
            kind: "pdt_change",
            objectKey: "batch",
            title: "Mixed scope",
            via: "app",
            operationKey: "pdt_change",
            cases: [
              { ID: "pdt:OWN", operation: "pdt_change" },
              { ID: "pdt:FOREIGN", operation: "pdt_change" },
            ],
            items: [
              {
                objectKey: "batch",
                field: "MaterialPlannedDeliveryDurn",
                oldValue: "2",
                newValue: "14",
              },
            ],
          }),
      },
    ),
  );
  const history = await SELECT.from("tide.cockpit.ActionEvents").where({
    action_ID: action.ID,
  });
  const response = await app.axios.post(
    `${api}/approveAction`,
    {
      actionID: action.ID,
      commandID: "mixed-approval",
      expectedModifiedAt: action.modifiedAt,
    },
    auth,
  );
  assert.equal(response.status, 404, JSON.stringify(response.data));
  assert.equal(
    (await SELECT.one.from("tide.cockpit.Actions").where({ ID: action.ID }))
      .status,
    "needs_decision",
  );
  assert.deepEqual(
    await SELECT.from("tide.cockpit.ActionEvents").where({
      action_ID: action.ID,
    }),
    history,
  );
  assert.equal(
    (await SELECT.from(RECEIPTS).where({ commandID: "mixed-approval" })).length,
    0,
  );
});

test("source-subject claim rejects a competing Case alias and decline releases it atomically", async () => {
  const first = await seedPilot();
  const alias = await seedPilot({ objectKey: "ALIAS-OF-SAME-SOURCE" });
  const prepare = (header: any, commandID: string) =>
    app.axios.post(
      `${api}/prepareSupplierPlannedTimeAction`,
      {
        caseID: header.ID,
        commandID,
        expectedModifiedAt: header.modifiedAt,
        expectedFingerprint: header.sourceFingerprint,
      },
      auth,
    );
  const prepared = await prepare(first, "claim-first");
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const history = await SELECT.from("tide.cockpit.CaseEvents").where({
    header_ID: alias.ID,
  });
  const conflict = await prepare(alias, "claim-alias");
  assert.equal(conflict.status, 409, JSON.stringify(conflict.data));
  assert.equal((await SELECT.from("tide.cockpit.Actions")).length, 1);
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 2);
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
  assert.deepEqual(
    await SELECT.from("tide.cockpit.CaseEvents").where({ header_ID: alias.ID }),
    history,
  );
  const actionEvent = await SELECT.one
    .from("tide.cockpit.ActionEvents")
    .where({ action_ID: prepared.data.actionID, event: "prepared" });
  const receipt = await SELECT.one
    .from(RECEIPTS)
    .where({ commandID: "claim-first" });
  assert.equal(actionEvent.command_ID, receipt.ID);
  assert.equal(actionEvent.actor, "buyerD01");
  const declined = await app.axios.post(
    `${api}/declineAction`,
    {
      actionID: prepared.data.actionID,
      commandID: "claim-decline",
      expectedModifiedAt: prepared.data.actionModifiedAt,
      note: "Reviewed; do not make this change",
    },
    auth,
  );
  assert.equal(declined.status, 200, JSON.stringify(declined.data));
  assert.equal(
    (
      await SELECT.from("tide.workflow.SubjectClaims").where({
        claimType: "action",
      })
    ).length,
    0,
  );
  const episode = await SELECT.one
    .from("tide.workflow.SubjectClaims")
    .where({ claimType: "case" });
  assert.equal(episode.caseID, first.ID);
  const aliasNext = await prepare(alias, "claim-alias-next");
  assert.equal(aliasNext.status, 409, JSON.stringify(aliasNext.data));
  const current = await SELECT.one
    .from("tide.cockpit.Cases")
    .where({ ID: first.ID });
  const next = await prepare(current, "claim-next");
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.notEqual(next.data.actionID, prepared.data.actionID);
});

test("unknown subject scope denies a buyer write and leaves no command artifacts", async () => {
  const header = await seedPilot({ Plant: null, PurchasingGroup: null });
  const response = await app.axios.post(
    `${api}/acceptSupplierPlannedTimeException`,
    {
      caseID: header.ID,
      commandID: "unknown-scope",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
      note: "Reason",
    },
    auth,
  );
  assert.equal(response.status, 404);
  assert.equal((await SELECT.from(RECEIPTS)).length, 0);
  assert.equal(
    (await SELECT.one.from("tide.cockpit.Cases").where({ ID: header.ID }))
      .status,
    "open",
  );
});

test("failure after claim and receipt writes rolls back the full intrinsic HTTP transaction", async () => {
  const workflow: any = await cds.connect.to("WorkflowService");
  let inject = true;
  workflow.after(
    "prepareSupplierPlannedTimeAction",
    (_result: unknown, req: cds.Request) => {
      if (inject && req.data.commandID === "fault-after-claim") {
        inject = false;
        throw fail(500, "Injected after claims and receipt");
      }
    },
  );
  const header = await seedPilot();
  const history = await SELECT.from("tide.cockpit.CaseEvents").where({
    header_ID: header.ID,
  });
  const payload = {
    caseID: header.ID,
    commandID: "fault-after-claim",
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  const failed = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    payload,
    auth,
  );
  assert.equal(failed.status, 500);
  for (const entity of [
    RECEIPTS,
    "tide.workflow.SubjectClaims",
    "tide.cockpit.Actions",
    "tide.cockpit.ActionItems",
    "tide.cockpit.ActionEvents",
    "tide.cockpit.OperationLocks",
    "tide.cockpit.CaseActions",
  ])
    assert.equal((await SELECT.from(entity)).length, 0, entity);
  assert.deepEqual(
    await SELECT.from("tide.cockpit.CaseEvents").where({
      header_ID: header.ID,
    }),
    history,
  );
  const retried = await app.axios.post(
    `${api}/prepareSupplierPlannedTimeAction`,
    payload,
    auth,
  );
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 2);
});

test("agent preparation and unknown-write reconciliation share the exact WorkflowService result and identity", async () => {
  const header = await seedPilot();
  const agent: any = await cds.connect.to("CockpitMcpService");
  const workflow: any = await cds.connect.to("WorkflowService");
  const detail = await run(() => agent.send("get_case", { caseID: header.ID }));
  assert.equal(detail.modifiedAt, header.modifiedAt);
  const payload = {
    caseID: header.ID,
    days: 14,
    commandID: "agent-command",
    expectedModifiedAt: detail.modifiedAt,
    expectedFingerprint: detail.sourceFingerprint,
  };
  const prepared = await run(() =>
    agent.send("prepare_case_action", payload),
  );
  const stored = await SELECT.one.from("tide.cockpit.Actions").where({ ID: prepared.actionID });
  assert.equal(stored.preparedVia, "mcp");
  assert.equal(stored.createdBy, user.id);
  const replay = await run(() =>
    workflow.send("prepareSupplierPlannedTimeAction", payload),
  );
  const runtime: any = await cds.connect.to("AssistantRuntimeService");
  const { commandID: _id, ...attempted } = payload;
  const reconciled = await run(() =>
    runtime.send("command_result", {
      tool: "prepare_case_action",
      commandID: payload.commandID,
      arguments: JSON.stringify(attempted),
    }),
  );
  assert.deepEqual(prepared, replay);
  assert.deepEqual(reconciled, {
    ...prepared,
    commandID: payload.commandID,
    commandType: "prepareSupplierPlannedTimeAction",
    payloadMatched: true,
  });
  assert.equal((await SELECT.one.from("tide.cockpit.Actions").where({ ID: prepared.actionID })).preparedVia, "mcp");
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
  assert.equal((await SELECT.from("tide.cockpit.Actions")).length, 1);
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 2);
  const foreign = new cds.User({
    id: "buyerD07",
    roles: ["user"],
    attr: { Plant: "DE31", PurchasingGroup: "D07" },
  });
  await assert.rejects(
    cds.tx({ user: foreign }, () =>
      agent.send("prepare_case_action", {
        ...payload,
        commandID: "agent-denied",
      }),
    ),
    (error: any) => Number(error.status ?? error.code) === 404,
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
});

test("Cockpit MCP exposes only receipted workflow writes; receipts are read through the runtime", async () => {
  const definitions = cds.model?.definitions as any;
  assert.ok(definitions);
  const tools = Object.keys(definitions)
    .filter((name) => name.startsWith("CockpitMcpService.") && ["action", "function"].includes(definitions[name].kind))
    .map((name) => name.slice("CockpitMcpService.".length));
  for (const name of ["prepare_action", "recompute_case", "recompute_row", "workflow_command_result"])
    assert.equal(tools.includes(name), false, name);
  for (const name of ["prepare_case_action", "submit_review"]) {
    assert.equal(tools.includes(name), true, name);
    assert.equal(definitions[`CockpitMcpService.${name}`].params.commandID.notNull, true, name);
  }
  const lookup = definitions["AssistantRuntimeService.command_result"];
  assert.equal(lookup.params.tool.type, "cds.String");
  assert.equal(lookup.params.arguments.type, "cds.LargeString");
});

test("MCP transport reconciles a lost preparation response without replaying the write", async () => {
  const header = await seedPilot();
  const agent: any = await cds.connect.to("CockpitMcpService");
  const detail = await run(() => agent.send("get_case", { caseID: header.ID }));
  const payload = {
    caseID: header.ID,
    days: 14,
    commandID: "mcp-lost-response",
    expectedModifiedAt: detail.modifiedAt,
    expectedFingerprint: detail.sourceFingerprint,
  };
  const callTool = async (name: string, args: object, buyer = "buyerD01") => {
    const response = await fetch(`${app.axios.defaults.baseURL}/mcp/cockpit`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${buyer}:${buyer}`)}`,
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
    const json = text.startsWith("{") ? text : text.match(/^data: (.*)$/m)?.[1];
    return { status: response.status, data: json ? JSON.parse(json) : null };
  };
  const prepared = await callTool("prepare_case_action", payload);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  assert.notEqual(
    prepared.data.result.isError,
    true,
    JSON.stringify(prepared.data),
  );

  const commandResult = async (args: object, buyer = "buyerD01") => {
    const response = await fetch(
      `${app.axios.defaults.baseURL}/rest/assistant-runtime/command_result`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${buyer}:${buyer}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool: "prepare_case_action", ...args }),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  const { commandID, ...attemptedArguments } = payload;
  const exactLookup = {
    commandID,
    arguments: JSON.stringify(attemptedArguments),
  };
  const matched = await commandResult(exactLookup);
  assert.equal(matched.status, 200, JSON.stringify(matched.data));
  assert.deepEqual(matched.data, {
    ...prepared.data.result.structuredContent.result,
    commandID,
    commandType: "prepareSupplierPlannedTimeAction",
    payloadMatched: true,
  });
  const mismatched = await commandResult({
    ...exactLookup,
    arguments: JSON.stringify({ ...attemptedArguments, days: 15 }),
  });
  assert.equal(mismatched.status, 409, JSON.stringify(mismatched.data));
  const changed = await callTool("prepare_case_action", {
    ...payload,
    days: 15,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.result.isError, true, JSON.stringify(changed.data));
  assert.match(
    JSON.stringify(changed.data.result),
    /commandID was already used with different arguments/,
  );
  assert.equal((await SELECT.from(RECEIPTS)).length, 1);
  assert.equal((await SELECT.from("tide.cockpit.Actions")).length, 1);

  const foreign = await commandResult(exactLookup, "buyerD07");
  assert.notEqual(foreign.status, 200, JSON.stringify(foreign.data));
});

test(
  "Agent graph recovers a committed CAP MCP write after response loss",
  {
    skip: !process.env.CAP_AGENT_E2E,
  },
  async () => {
    const header = await seedPilot();
    const agent: any = await cds.connect.to("CockpitMcpService");
    const detail = await run(() =>
      agent.send("get_case", { caseID: header.ID }),
    );
    const agentDir = path.join(__dirname, "../../tide-agent");
    const child = spawn(
      "uv",
      [
        "run",
        "--project",
        agentDir,
        "python",
        "-m",
        "pytest",
        "-q",
        "tests/test_graph.py::test_committed_cap_mcp_write_recovers_through_real_transport",
      ],
      {
        cwd: agentDir,
        env: {
          ...process.env,
          CAP_MCP_TEST_URL: `${app.axios.defaults.baseURL}/mcp/cockpit`,
          CAP_MCP_TEST_AUTH: `Basic ${btoa("buyerD01:buyerD01")}`,
          CAP_MCP_TEST_PAYLOAD: JSON.stringify({
            caseID: header.ID,
            days: 14,
            commandID: "agent-mcp-lost-response",
            expectedModifiedAt: detail.modifiedAt,
            expectedFingerprint: detail.sourceFingerprint,
          }),
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
    assert.equal(exitCode, 0, output);
    assert.equal((await SELECT.from(RECEIPTS)).length, 1);
    assert.equal((await SELECT.from("tide.cockpit.Actions")).length, 1);
    assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 2);
  },
);

test("supplier acceptance survives estimate changes and incomplete source, but a maintained-setting change reopens once", async () => {
  const header = await seedPilot();
  const workflow: any = await cds.connect.to("WorkflowService");
  await run(() =>
    workflow.send("acceptSupplierPlannedTimeException", {
      caseID: header.ID,
      note: "Current setting is intentional",
      commandID: "recurrence-accept",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    }),
  );
  const previous = await SELECT.one
    .from(`${NS}.SupplierPlannedTimes`)
    .where({ header_ID: header.ID });
  const detail = JSON.parse(previous.detail);
  const refreshed: any = {
    list: "pdt",
    objectKey: header.ID.slice(4),
    Material: "PILOT-M1",
    Supplier: "PILOT-S1",
    Plant: "DE11",
    PurchasingGroup: "D01",
    source: "empirical",
    rank: 1,
    pdtDetail: {
      ...detail,
      proposalDays: 42,
      ownDeliveries: 99,
      p50: 35,
      p80: 42,
      currentDays: 2,
    },
  };
  await run(() => upsertDetectorCase(refreshed));
  let current = await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID });
  assert.equal(current.status, "closed");
  assert.equal(current.closure, "exception_accepted");
  assert.notEqual(current.sourceFingerprint, header.sourceFingerprint);
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: header.ID,
        event: "case_reopened",
      })
    ).length,
    0,
  );
  for (const incomplete of [null, "", false]) {
    await run(() =>
      upsertDetectorCase({
        ...refreshed,
        pdtDetail: { ...refreshed.pdtDetail, currentDays: incomplete },
      }),
    );
    assert.equal(
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID })).closure,
      "exception_accepted",
    );
  }
  await run(() =>
    upsertDetectorCase({
      ...refreshed,
      pdtDetail: { ...refreshed.pdtDetail, currentDays: 3 },
    }),
  );
  current = await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID });
  assert.equal(current.status, "open");
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: header.ID,
        event: "case_reopened",
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: header.ID,
        event: "exception_accepted",
      })
    ).length,
    1,
  );
  const accepted = await SELECT.one
    .from(`${NS}.CaseEvents`)
    .where({ header_ID: header.ID, event: "exception_accepted" });
  assert.equal(JSON.parse(accepted.sourceCondition).days, 2);
  assert.equal(JSON.parse(current.acceptedSourceCondition).days, 2);
});

test("typed supplier posting keeps partial work waiting and completes only exact reported instructions without source fulfillment", async () => {
  const header = await seedPilot();
  const workflow: any = await cds.connect.to("WorkflowService");
  const prepared = await run(() =>
    workflow.send("prepareSupplierPlannedTimeAction", {
      caseID: header.ID,
      days: 14,
      commandID: "posting-prepare",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    }),
  );
  const approved = await run(() =>
    workflow.send("approveAction", {
      actionID: prepared.actionID,
      commandID: "posting-approve",
      expectedModifiedAt: prepared.actionModifiedAt,
    }),
  );
  const item = await SELECT.one
    .from(`${NS}.ActionItems`)
    .where({ action_ID: prepared.actionID });
  const report = {
    actionID: prepared.actionID,
    completeness: "partial",
    target: item.objectKey,
    field: item.field,
    value: item.newValue,
    note: "Part of the external update is still pending",
    commandID: "posting-partial",
    expectedModifiedAt: approved.actionModifiedAt,
  };
  const partial = await run(() =>
    workflow.send("recordSupplierPosting", report),
  );
  assert.equal(partial.status, "waiting");
  assert.deepEqual(
    await run(() => workflow.send("recordSupplierPosting", report)),
    partial,
  );
  assert.equal(
    (await SELECT.from("tide.workflow.OutcomeObservations")).length,
    1,
  );
  assert.equal((await SELECT.from("tide.workflow.SubjectClaims")).length, 2);
  for (const invalid of [
    { target: "another-record" },
    { value: "99" },
    { note: " " },
    { completeness: "maybe" },
    { expectedModifiedAt: "2020-01-01T00:00:00Z" },
  ])
    await assert.rejects(
      run(() =>
        workflow.send("recordSupplierPosting", {
          ...report,
          ...invalid,
          commandID: `invalid-${Object.keys(invalid)[0]}`,
          expectedModifiedAt:
            invalid.expectedModifiedAt ?? partial.actionModifiedAt,
        }),
      ),
    );
  assert.equal(
    (await SELECT.from("tide.workflow.OutcomeObservations")).length,
    1,
  );
  const complete = await run(() =>
    workflow.send("recordSupplierPosting", {
      ...report,
      completeness: "complete",
      note: "Externally posted exact approved setting, reference LOCAL-1",
      commandID: "posting-complete",
      expectedModifiedAt: partial.actionModifiedAt,
    }),
  );
  assert.equal(complete.status, "resolved");
  assert.equal(
    (
      await SELECT.from("tide.workflow.SubjectClaims").where({
        claimType: "action",
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await SELECT.from("tide.workflow.SubjectClaims").where({
        claimType: "case",
        caseID: header.ID,
      })
    ).length,
    1,
  );
  const observations = await SELECT.from("tide.workflow.OutcomeObservations");
  assert.equal(observations.length, 2);
  assert.ok(
    observations.every(
      (row: any) =>
        row.origin === "user_report" && row.actor === user.id && row.command_ID,
    ),
  );
  assert.equal(
    (await SELECT.one.from(`${NS}.Cases`).where({ ID: header.ID })).status,
    "open",
  );
  assert.equal(
    (
      await SELECT.from(`${NS}.CaseEvents`).where({
        header_ID: header.ID,
        event: "source_resolved",
      })
    ).length,
    0,
  );
});

test("disk-backed committed receipt survives process loss and restart without repeated state or history", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tide-workflow-restart-"));
  const database = path.join(directory, "workflow.sqlite");
  const worker = `
    const cds = require('@sap/cds');
    const { executeWorkflowCommand, readWorkflowCommandResult } = require('./srv/cockpit/kernel/commands.ts');
    const { ensureCase } = require('./srv/cockpit/kernel/cases.ts');
    (async () => {
      const [database, mode] = process.argv.slice(1);
      cds.model = cds.linked(await cds.load('*'));
      const db = await cds.connect.to('db', {kind:'sqlite',credentials:{url:database}});
      cds.db = db;
      if (mode === 'commit-and-lose') await cds.deploy(cds.model).to(db);
      const user = new cds.User({id:'restart-buyer',roles:['user'],attr:{}});
      const command = {commandID:'restart-command',commandType:'restart-pilot',arguments:{days:14},subjects:[{kind:'case',ID:'pdt:RESTART'}]};
      const authorize = async () => {};
      const result = await cds.tx({user}, () => executeWorkflowCommand(command, {authorize, execute:async(receiptID) => {
        if (mode !== 'commit-and-lose') throw new Error('Replayed execution after process restart');
        await ensureCase({ID:'pdt:RESTART',kind:'supplier_planned_time',Plant:'DE11',PurchasingGroup:'D01'});
        await cds.ql.INSERT.into('tide.workflow.SubjectClaims').entries({tenant:'',sourceSystem:'tide.s4',kind:'PurchasingInfoRecordPlant',subjectKey:'restart-record',claimType:'action',slot:'pdt_change',actionID:cds.utils.uuid(),commandID:receiptID});
        return {caseID:'pdt:RESTART',days:14};
      }}));
      if (mode === 'commit-and-lose') process.exit(71);
      const reconciled = await cds.tx({user}, () => readWorkflowCommandResult('restart-command',authorize));
      const counts = {};
      for (const entity of ['tide.workflow.WorkflowCommands','tide.workflow.SubjectClaims','tide.cockpit.Cases','tide.cockpit.CaseEvents']) counts[entity] = (await db.run(cds.ql.SELECT.from(entity))).length;
      console.log('WORKFLOW_RESULT:' + JSON.stringify({result,reconciled,counts}));
      await db.disconnect();
    })().catch(error => {console.error(error);process.exit(1)});
  `;
  const execute = (mode: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", worker, database, mode],
      {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, CDS_ENV: "test", CDS_TYPESCRIPT: "true" },
        encoding: "utf8",
        timeout: 60000,
      },
    );
  try {
    const lost = execute("commit-and-lose");
    assert.equal(lost.status, 71, `${lost.stdout}\n${lost.stderr}`);
    for (const mode of ["restart-one", "restart-two"]) {
      const replay = execute(mode);
      assert.equal(replay.status, 0, `${replay.stdout}\n${replay.stderr}`);
      const line = replay.stdout
        .split("\n")
        .find((value) => value.startsWith("WORKFLOW_RESULT:"));
      assert.ok(line, replay.stdout);
      const saved = JSON.parse(line.slice("WORKFLOW_RESULT:".length));
      assert.deepEqual(saved.result, { caseID: "pdt:RESTART", days: 14 });
      assert.deepEqual(saved.reconciled, saved.result);
      assert.deepEqual(Object.values(saved.counts), [1, 1, 1, 1]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
