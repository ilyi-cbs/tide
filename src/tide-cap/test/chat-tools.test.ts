// Chat assistant MCP endpoints against the kernel fixtures: one catalog per app
// with native instructions, the cockpit tools, and the runtime REST service.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { before, describe, test } from "node:test";
import { finding, seedFixtures } from "./fixtures/cockpit";
import { upsertDetectorCase } from "../srv/cockpit/kernel/detector-writers";
import { MAX_LATE_DAYS, MIN_LATE_DAYS } from "../srv/cockpit/predict-logic";

const { SELECT, INSERT } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";

const BUYER = "ilyesse.hettenbach@cbs-consulting.de";
const auth = (user: string) =>
  "Basic " + btoa(`${user}:${user === BUYER ? "alice" : user}`);

async function mcp(
  method: string,
  params: object,
  user = BUYER,
  endpoint = "cockpit",
) {
  const res = await fetch(`${app.url}/mcp/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: auth(user),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.match(/^data: (.*)$/m)?.[1];
  return { status: res.status, data: json ? JSON.parse(json) : null };
}

async function runtime(action: string, body: object, user = BUYER) {
  const res = await fetch(`${app.url}/rest/assistant-runtime/${action}`, {
    method: "POST",
    headers: { authorization: auth(user), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function tool(name: string, args: object = {}, user = BUYER) {
  const { status, data } = await mcp(
    "tools/call",
    { name, arguments: args },
    user,
  );
  assert.equal(status, 200, JSON.stringify(data));
  return data.result;
}

const ok = async (name: string, args: object = {}) => {
  const r = await tool(name, args);
  assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
  return r.structuredContent.result;
};

const errorText = async (name: string, args: object = {}) => {
  const r = await tool(name, args);
  assert.equal(r.isError, true, `${name} should fail: ${JSON.stringify(r)}`);
  return String(r.content[0].text);
};

const COCKPIT_TOOLS = [
  "get_case",
  "get_lead_time_range",
  "get_review_summary",
  "get_today",
  "list_cases",
  "list_pending_actions",
  "list_priorities",
  "plan_order",
  "predict_orders",
  "prepare_case_action",
  "propose_freetext_codes",
  "simulate_planned_delivery_time",
  "simulate_thresholds",
  "submit_review",
];

before(async () => {
  await app;
  await seedFixtures(cds.db, {
    findings: [
      {
        list: "at_risk",
        objectKey: "4500000001/10",
        rank: 1,
        impactLevel: "stock_uncovered",
        impactText: "Stock runs short",
        revenueAtRisk: null,
        expert: '{"p_late":0.8}',
      },
      {
        list: "at_risk",
        objectKey: "4500000002/10",
        PurchaseOrder: "4500000002",
        rank: 2,
        impactLevel: "customer_order_late",
        impactText: "Customer order at risk · 12,400 EUR",
        revenueAtRisk: 12400,
        source: "tabpfn",
      },
      {
        list: "at_risk",
        objectKey: "4500000003/10",
        PurchaseOrder: "4500000003",
        rank: 3,
        Plant: "P2",
        PurchasingGroup: "002",
      },
      {
        list: "overdue",
        objectKey: "4500000004/10",
        PurchaseOrder: "4500000004",
        issue: "The requested date has passed",
        source: "rule",
      },
    ],
    itemImpacts: [
      {
        PurchaseOrder: "4500000001",
        level: "stock_uncovered",
        revenueAtRisk: 0,
        shortageDays: 4,
      },
      {
        PurchaseOrder: "4500000002",
        level: "customer_order_late",
        revenueAtRisk: 12400,
        delayDays: 6,
      },
    ],
    lineGrids: [{ PurchaseOrder: "4500000001" }],
  });
  await INSERT.into(`${NS}.CustomerImpact`).entries({
    PurchaseOrder: "4500000002",
    PurchaseOrderItem: "10",
    SalesOrder: "SO1",
    SalesOrderItem: "10",
    Customer: "C1",
    CustomerName: "Acme",
    promisedDate: "2026-10-10",
    openAmount: 12400,
    atRiskP50: true,
    atRiskP80: true,
  });
});

describe("chat assistant MCP", () => {
  test("each app has its own catalog and native instructions; no approve, reject or send tool", async () => {
    const init = await mcp("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const instructions: string = init.data.result.instructions;
    for (const rule of [
      "You are TIDE, the buyer's purchasing desk",
      "Every number, code and date comes from a tool result or the user's message",
      '"AI estimate" (tabpfn)',
      "give no percentages for it",
      "Markdown table",
      "begin with realityCheck word for word",
      '"Source: calculated from the stock and requirements list"',
    ])
      assert.ok(instructions.includes(rule), rule);
    assert.ok(!instructions.includes("For a simple social greeting"));
    assert.ok(
      instructions.includes(`lateDays ${MIN_LATE_DAYS} to ${MAX_LATE_DAYS}`),
      "gate constants match the domain",
    );
    assert.doesNotMatch(instructions, /commandID|row_detail|list_rows/);

    const { data } = await mcp("tools/list", {});
    const tools = new Map<string, any>(
      data.result.tools.map((t: any) => [t.name, t]),
    );
    assert.deepEqual([...tools.keys()].sort(), COCKPIT_TOOLS);
    for (const name of [
      "predict_orders",
      "prepare_case_action",
      "submit_review",
    ])
      assert.equal(tools.get(name).annotations.readOnlyHint, false, name);
    for (const name of [
      "get_today",
      "list_cases",
      "get_case",
      "list_priorities",
    ])
      assert.equal(tools.get(name).annotations.readOnlyHint, true, name);
    for (const name of tools.keys())
      assert.doesNotMatch(name, /approve|reject|send/i);

    for (const endpoint of ["lead-time", "playground", "agent"])
      assert.equal(
        (await mcp("tools/list", {}, BUYER, endpoint)).status,
        404,
        endpoint,
      );
  });

  test("the runtime profile names action tools and checks", async () => {
    const { status, data } = await runtime("profile", { app: "cockpit" });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.checked, true);
    assert.deepEqual(data.actionTools, [
      "predict_orders",
      "prepare_case_action",
      "submit_review",
    ]);
    // The agent applies these end-of-turn checks; its tests use the same file.
    const agentFixture = path.join(
      __dirname,
      "../../tide-agent/tests/fixtures/cockpit_turn_checks.json",
    );
    assert.deepEqual(
      JSON.parse(data.checks),
      JSON.parse(readFileSync(agentFixture, "utf8")),
    );
    for (const app of ["lead-time", "tabpfn-playground", "nope"])
      assert.equal((await runtime("profile", { app })).status, 404, app);
  });

  test("context resolution validates and scopes business identifiers", async () => {
    const caseID = "delivery:4500000001/10";
    await INSERT.into(`${NS}.Cases`).entries({
      ID: caseID,
      kind: "delivery",
      status: "open",
      listing: "listed",
      title: "PO 4500000001/10",
      Plant: "P1",
      PurchasingGroup: "001",
    });
    const resolve = async (context: object) =>
      (
        await runtime("resolve_context", {
          app: "cockpit",
          context: JSON.stringify({ version: 1, app: "cockpit", ...context }),
        })
      ).data;
    const okContext = await resolve({
      surface: "cockpit.delivery-risk-detail",
      entity: { kind: "case", id: caseID },
    });
    assert.equal(okContext.valid, true);
    assert.equal(okContext.profile, "delivery-risk-detail");
    assert.equal(JSON.parse(okContext.canonicalContext).entity.id, caseID);
    assert.match(okContext.instructions, /Read the current authorized case/);
    assert.equal("allowedTools" in okContext, false);
    assert.equal((await resolve({ surface: "cockpit.unknown" })).valid, false);
    const inaccessible = await resolve({
      surface: "cockpit.delivery-risk-detail",
      entity: { kind: "case", id: "not-a-visible-case" },
    });
    assert.equal(inaccessible.valid, true);
    assert.doesNotMatch(inaccessible.canonicalContext, /not-a-visible-case/);
  });

  test("get_today counts the lists and the pending actions", async () => {
    const b = await ok("get_today");
    assert.equal(b.asOf, "2026-10-05");
    const counts = Object.fromEntries(
      b.lists.map((l: any) => [l.list, l.count]),
    );
    assert.equal(counts.at_risk, 3);
    assert.equal(counts.overdue, 1);
    assert.equal(counts.freetext, 0);
  });

  test("list_cases filters by kind and search; get_case explains why", async () => {
    await upsertDetectorCase(
      finding({ list: "at_risk", objectKey: "4500000001/10", rank: 1 }),
    );
    const all = await ok("list_cases", { kind: "delivery" });
    assert.ok(
      all.cases.some((c: any) => c.caseID === "delivery:4500000001/10"),
    );
    const found = await ok("list_cases", { search: "4500000001" });
    assert.ok(found.cases.every((c: any) => c.caseID.includes("4500000001")));
    assert.equal((await ok("list_cases", { kind: "price" })).total, 0);
    const detail = await ok("get_case", { caseID: "delivery:4500000001/10" });
    assert.deepEqual(detail.steps, [
      "Checked this morning",
      "may arrive late",
      "Next: prepare a reminder",
    ]);
    assert.equal(detail.nextStep, "Prepare a reminder");
    const text = (await tool("get_case", { caseID: "delivery:4500000001/10" }))
      .content[0].text;
    assert.doesNotMatch(text, /p_late|probability|confidence/);
  });

  test("list_priorities keeps the impact order and names the calculation source", async () => {
    const p = await ok("list_priorities", { limit: 2 });
    assert.equal(p.source, "calculation");
    assert.equal(
      p.note,
      "Source: calculated from the stock and requirements list",
    );
    assert.deepEqual(
      p.rows.map((r: any) => [r.rank, r.PurchaseOrder]),
      [
        [1, "4500000002"],
        [2, "4500000001"],
      ],
    );
    assert.deepEqual(p.rows[0].customers, ["Acme"]);
    assert.equal(p.rows[0].revenueAtRisk, 12400);
    assert.equal(p.atRiskTotal, 3);
    assert.match(
      await errorText("list_priorities", { limit: 11 }),
      /limit must be between 1 and 10/,
    );
  });

  test("operations whose owner has not landed are a clean tool error (501)", async () => {
    const cases: [string, object, string][] = [
      ["get_lead_time_range", { Material: "M1", Plant: "P1" }, "leadTimeRange"],
      [
        "plan_order",
        { Material: "M1", Plant: "P1", needDate: "2026-11-02" },
        "planOrder",
      ],
      [
        "propose_freetext_codes",
        { text: "bolts M8", Plant: "P1" },
        "proposeCodes",
      ],
      ["simulate_thresholds", { field: "MaterialGroup" }, "thresholdSimulator"],
      [
        "simulate_planned_delivery_time",
        { Material: "M1", Supplier: "S1", Plant: "P1" },
        "bufferSimulator",
      ],
    ];
    const cockpit = await cds.connect.to("PurchasingDeskService");
    for (const [name, args, op] of cases) {
      const implemented = await cockpit
        .send(op, args)
        .then(() => true)
        .catch((e: any) => e.status !== 501);
      if (implemented) continue; // the owner has landed: covered by its own tests
      const text = await errorText(name, args);
      assert.equal(
        text,
        `Error calling ${name}: ${op} is not available yet in this cockpit (not implemented yet)`,
      );
    }
  });

  test("prepare_case_action prepares the case's next step once and the receipt reconciles", async () => {
    const caseID = "delivery:4500000004/10";
    await upsertDetectorCase(
      finding({
        list: "overdue",
        objectKey: "4500000004/10",
        PurchaseOrder: "4500000004",
        issue: "The requested date has passed",
        source: "rule",
      }),
    );
    const detail = await ok("get_case", { caseID });
    const payload = {
      caseID,
      commandID: "chat-delivery-preparation",
      expectedModifiedAt: detail.modifiedAt,
      expectedFingerprint: detail.sourceFingerprint,
    };
    assert.match(
      await errorText("prepare_case_action", { ...payload, days: 5 }),
      /days applies to supplier_planned_time cases only/,
    );
    const result = await ok("prepare_case_action", payload);
    const a = await SELECT.one
      .from(`${NS}.Actions`)
      .where({ ID: result.actionID });
    assert.equal(a.kind, "reminder");
    assert.equal(a.status, "needs_decision");
    assert.equal(a.preparedVia, "mcp");
    const link = await SELECT.one
      .from(`${NS}.CaseActions`)
      .where({ action_ID: a.ID });
    assert.equal(link.header_ID, caseID);
    const item = await SELECT.one
      .from(`${NS}.ActionItems`)
      .where({ action_ID: a.ID });
    assert.match(item.text, /The requested date passed/);
    assert.doesNotMatch(item.text, /EUR|%|probab/i);
    assert.deepEqual(await ok("prepare_case_action", payload), result);
    const { commandID, ...args } = payload;
    const receipt = await runtime("command_result", {
      tool: "prepare_case_action",
      commandID,
      arguments: JSON.stringify(args),
    });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.data));
    assert.equal(receipt.data.payloadMatched, true);
    assert.equal(receipt.data.actionID, result.actionID);
    const changed = await runtime("command_result", {
      tool: "prepare_case_action",
      commandID,
      arguments: JSON.stringify({ ...args, expectedFingerprint: "x" }),
    });
    assert.equal(changed.status, 409);
    const pending = await ok("list_pending_actions");
    assert.ok(pending.pending.some((x: any) => x.ID === a.ID));
    assert.match(pending.note, /Nothing is sent to suppliers/);
    const stored = await SELECT.one.from(`${NS}.Actions`).where({ ID: a.ID });
    assert.equal(stored.status, "needs_decision", "never approved over MCP");
  });
});
