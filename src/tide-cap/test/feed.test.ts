// SourceService upserts feed rows by key, refreshes facts, runs ordered hooks, and emits sequenced events.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { registerHook, resetHooks } from "../srv/cockpit/kernel/hooks";
import type { IngestEvent, StepContext } from "../srv/cockpit/kernel/types";
import { seedFixtures } from "./fixtures/cockpit";
import { useFakeTabular } from "./fixtures/tabular";

useFakeTabular();

const { SELECT, DELETE, INSERT } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const S4 = "tide.s4";
const ADMIN_USER = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
  validateStatus: () => true,
};
const CAROL = {
  auth: { username: "carol", password: "carol" },
  validateStatus: () => true,
};
const DATE = "2026-10-06"; // a Tuesday after the fixture as-of date
/** Requisitions (free text) arrive with the loader's full S/4 model; without them the fixture has no free-text entry. */
const hasPR = () => !!(cds.model as any)?.definitions[`${S4}.PurchaseReqnItem`];
const calls: string[] = [];

const post = (op: string, body: object, auth = ADMIN_USER) =>
  app.axios.post(`/odata/v4/source/${op}`, body, auth);

/** One old open PO item (4500000001/10) with a schedule line: the snapshot state. */
async function seedS4() {
  for (const e of [
    "PurchaseOrder",
    "PurchaseOrderItem",
    "PurchaseOrderScheduleLine",
    "MaterialDocumentItem",
    ...(hasPR() ? ["PurchaseReqnItem"] : []),
  ])
    await DELETE.from(`${S4}.${e}`);
  await INSERT.into(`${S4}.PurchaseOrder`).entries({
    PurchaseOrder: "4500000001",
    PurchaseOrderDate: "2026-09-20",
    Supplier: "S1",
    PurchasingGroup: "001",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    Material: "M1",
    Plant: "P1",
    OrderQuantity: 10,
    NetAmount: 100,
    DocumentCurrency: "EUR",
    PlannedDeliveryDurationInDays: 14,
  });
  await INSERT.into(`${S4}.PurchaseOrderScheduleLine`).entries({
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    ScheduleLine: "1",
    ScheduleLineDeliveryDate: "2026-10-10",
    ScheduleLineOrderQuantity: 10,
    OpenPurchaseOrderQuantity: 10,
  });
}

const newItem = (item = "10", pdt = 2) => ({
  PurchaseOrder: [
    {
      PurchaseOrder: "4500000900",
      PurchaseOrderDate: DATE,
      Supplier: "S1",
      PurchasingGroup: "001",
    },
  ],
  PurchaseOrderItem: [
    {
      PurchaseOrder: "4500000900",
      PurchaseOrderItem: item,
      Material: "M1",
      Plant: "P1",
      OrderQuantity: 5,
      NetAmount: 50,
      DocumentCurrency: "EUR",
      PlannedDeliveryDurationInDays: pdt,
    },
  ],
  PurchaseOrderScheduleLine: [
    {
      PurchaseOrder: "4500000900",
      PurchaseOrderItem: item,
      ScheduleLine: "1",
      ScheduleLineDeliveryDate: "2026-10-20",
      ScheduleLineOrderQuantity: 5,
      OpenPurchaseOrderQuantity: 5,
    },
  ],
});

before(async () => {
  await app;
});

after(() => {
  resetHooks();
});

beforeEach(async () => {
  for (const e of [
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
    "FeedJournal",
    "FeedRun",
    "ItemFact",
  ])
    await DELETE.from(`${NS}.${e}`);
  await seedFixtures(cds.db, {
    events: [{ kind: "morning", title: "Morning run" }],
  });
  await seedS4();
  calls.length = 0;
  resetHooks();
  // Registered in reverse step order: runHooks must still run atrisk before rules before impact.
  const hook =
    (name: string, events = 1) =>
    async (ev: IngestEvent, ctx: StepContext) => {
      calls.push(`${name}:${ev.kind}`);
      if (name === "atrisk") ctx.meter.calls += 1;
      return {
        events: Array.from({ length: events }, (_, i) => ({
          title: `${name} step ${i + 1}`,
          source: "rule" as const,
          status: "done",
        })),
      };
    };
  registerHook("po_item", "impact.recompute", hook("impact"));
  registerHook("po_item", "rules.price", hook("rules"));
  registerHook("po_item", "atrisk.verdict", hook("atrisk", 2));
  registerHook("goods_receipt", "atrisk.close", hook("atrisk"));
});

test("ingest records source arrivals without business refresh or model hooks", async () => {
  const identity = await SELECT.one
    .from(`${S4}.DatasetInfo`)
    .where({ ID: "current" });
  const res = await post("ingest", {
    kind: "po_item",
    payload: JSON.stringify({ at: `${DATE}T10:00:00Z`, rows: newItem() }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const events = res.data.value;
  assert.deepEqual(calls, []);
  assert.deepEqual(
    events.map((e: any) => [e.seq, e.kind, e.title]),
    [[2, "po_item", "New PO 4500000900 item 10 in plant P1"]],
  );
  assert.equal(events[0].modelCalls, 0);
  const arrived = await SELECT.one
    .from(`${S4}.DatasetInfo`)
    .where({ ID: "current" });
  assert.notEqual(arrived.loadId, identity.loadId);
  assert.equal(arrived.asOf, identity.asOf);
  assert.equal(events[0].simTime.slice(0, 19), `${DATE}T10:00:00`);
  assert.equal(events[0].objectKey, "4500000900/10");

  const fact = await SELECT.one
    .from(`${NS}.ItemFact`)
    .where({ PurchaseOrder: "4500000900", PurchaseOrderItem: "10" });
  assert.equal(
    fact,
    undefined,
    "source intake does not publish current business facts",
  );

  // Same key again with a changed field: one row, merged, not duplicated.
  const again = newItem();
  again.PurchaseOrderItem[0].OrderQuantity = 7;
  const res2 = await post("ingest", {
    kind: "po_item",
    payload: JSON.stringify({
      at: `${DATE}T11:00:00Z`,
      rows: {
        PurchaseOrderItem: [
          {
            PurchaseOrder: "4500000900",
            PurchaseOrderItem: "010",
            OrderQuantity: 7,
          },
        ],
      },
    }),
  });
  assert.equal(res2.status, 200, JSON.stringify(res2.data));
  const items = await SELECT.from(`${S4}.PurchaseOrderItem`).where({
    PurchaseOrder: "4500000900",
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].OrderQuantity, 7);
  assert.equal(items[0].Material, "M1", "fields not in the payload stay");
  const polled = await app.axios.get(
    `/odata/v4/desk/Events?$filter=seq gt 2&$orderby=seq`,
    ADMIN_USER,
  );
  assert.equal(polled.data.value[0].seq, 3, "delta polling by sequence");
});

test("ingest refuses bad input and non-admins", async () => {
  const bad = await post("ingest", {
    kind: "po_item",
    payload: JSON.stringify({ rows: { NoSuchTable: [{}] } }),
  });
  assert.equal(bad.status, 400);
  const nokey = await post("ingest", {
    kind: "po_item",
    payload: JSON.stringify({
      rows: { PurchaseOrderItem: [{ PurchaseOrder: "1" }] },
    }),
  });
  assert.equal(nokey.status, 400);
  assert.match(nokey.data.error.message, /PurchaseOrderItem/);
  const kind = await post("ingest", {
    kind: "nonsense",
    payload: JSON.stringify({ rows: {} }),
  });
  assert.equal(kind.status, 400);
  const carol = await post(
    "ingest",
    { kind: "po_item", payload: JSON.stringify({ rows: newItem() }) },
    CAROL,
  );
  assert.equal(carol.status, 403);
  assert.equal(
    (
      await SELECT.from(`${S4}.PurchaseOrderItem`).where({
        PurchaseOrder: "4500000900",
      })
    ).length,
    0,
    "nothing written",
  );
});
