// Deliveries at risk (P-1) on the database: morning step with a fake tabular
// (window, ranks, sort, top 20, rule rate, empirical P, grids, dry run) and
// the feed hooks po_item / goods_receipt.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { materializeFacts } from "../srv/cockpit/prepare";
import { step, register } from "../srv/cockpit/atrisk";
import { runMorning } from "../srv/cockpit/atrisk/morning";
import { onGoodsReceipt, onPoItem } from "../srv/cockpit/atrisk/feed";
import { LEVELS } from "../srv/cockpit/atrisk/domain/rules";
import type { Meter } from "../srv/cockpit/kernel/model-calls";
import type { StepContext } from "../srv/cockpit/kernel/types";
import {
  FIXTURE_AS_OF,
  FIXTURE_SNAPSHOT,
  seedFixtures,
} from "./fixtures/cockpit";

const { INSERT, SELECT, DELETE } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const S4 = "tide.s4";
const AS_OF = FIXTURE_AS_OF; // Monday 2026-10-05; window ends 2026-10-19
const requests: any[] = [];
let fake: Server;

const user = new (cds as any).User({
  id: "ilyesse.hettenbach@cbs-consulting.de",
  roles: ["user", "admin"],
});
const meter = (): Meter => ({
  user,
  calls: 0,
  cost: 0,
  runs: [],
  planned: [],
  backend: null,
  failed: [],
});
const ctx = (dryRun: boolean, m = meter()): StepContext => ({
  user,
  snapshotId: FIXTURE_SNAPSHOT,
  asOf: AS_OF,
  dryRun,
  meter: m,
});

let seq = 0;
async function po(o: {
  po: string;
  material: string;
  planned: number | null;
  poDate: string;
  requested: string;
  receipt?: string | null;
  group?: string;
  net?: number;
  plant?: string;
}) {
  await INSERT.into(`${S4}.PurchaseOrder`).entries({
    PurchaseOrder: o.po,
    PurchaseOrderDate: o.poDate,
    Supplier: "S1",
    PurchasingGroup: o.group ?? "001",
    DocumentCurrency: "EUR",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder: o.po,
    PurchaseOrderItem: "10",
    Material: o.material,
    MaterialGroup: "MG1",
    MaterialType: "ROH",
    Plant: o.plant ?? "P1",
    OrderQuantity: 5,
    NetAmount: o.net ?? 100,
    DocumentCurrency: "EUR",
    PlannedDeliveryDurationInDays: o.planned,
  });
  await INSERT.into(`${S4}.PurchaseOrderScheduleLine`).entries({
    PurchaseOrder: o.po,
    PurchaseOrderItem: "10",
    ScheduleLine: "1",
    ScheduleLineDeliveryDate: o.requested,
    OpenPurchaseOrderQuantity: o.receipt ? 0 : 5,
  });
  if (o.receipt) await receipt(o.po, o.receipt);
}

async function receipt(poNo: string, posted: string) {
  await INSERT.into(`${S4}.MaterialDocumentItem`).entries({
    MaterialDocumentYear: "2026",
    MaterialDocument: String(5000000000 + ++seq),
    MaterialDocumentItem: "1",
    PostingDate: posted,
    GoodsMovementType: "101",
    GoodsMovementIsCancelled: false,
    PurchaseOrder: poNo,
    PurchaseOrderItem: "10",
    QuantityInEntryUnit: 5,
  });
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

before(async () => {
  fake = createServer(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health")
      return res.end(JSON.stringify({ status: "ok", backend: "priorlabs" }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const r = JSON.parse(raw);
    requests.push(r);
    res.end(
      JSON.stringify({
        task: r.task,
        output_type: r.output.type,
        classes: null,
        levels: r.output.levels,
        // F(x) = x / 20 on [1, 19]: p50 = 10 days.
        predictions: r.keys.map((k: string) => ({
          row_key: k,
          value:
            (Math.min(...r.y_train) > 20 ? Math.min(...r.y_train) : 0) + 10,
          quantiles: r.output.levels.map(
            (l: number) =>
              (Math.min(...r.y_train) > 20 ? Math.min(...r.y_train) : 0) +
              l * 20,
          ),
        })),
        fallback: null,
        dropped_columns: [],
        placeholder: r.mode === "dry_run",
        usage: {
          backend: "priorlabs",
          calls: 1,
          context_cells: 10,
          predicted_cells: 1,
          cost_units: 0.5,
          effective_feature_count: r.columns.length,
        },
        train_rows: r.x_train.length,
        elapsed_ms: 1,
      }),
    );
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  (cds.env.requires as any).tabular.credentials = {
    url: `http://127.0.0.1:${(fake.address() as any).port}`,
  };
  await app;
  await seedFixtures(cds.db, {});
  await INSERT.into(`${S4}.Supplier`).entries({
    Supplier: "S1",
    SupplierName: "Acme Bearings GmbH",
    Country: "DE",
  });
  await INSERT.into(`${S4}.ProductDescription`).entries([
    { Product: "MH", Language: "EN", ProductDescription: "Bearing 6204" },
    { Product: "MR", Language: "EN", ProductDescription: "Shaft" },
  ]);

  // History of MH|S1|P1: 25 receipts, lead times 5 … 29 days; planned 10,
  // requested 7 days after the order: the rule fires, 22 of 25 late.
  for (let k = 0; k < 25; k++) {
    const d = addDays("2026-01-05", 5 * k);
    await po({
      po: `41${String(k).padStart(8, "0")}`,
      material: "MH",
      planned: 10,
      poDate: d,
      requested: addDays(d, 7),
      receipt: addDays(d, 5 + k),
    });
  }
  const open = "2026-10-01";
  // A1 own history, planned time not maintained, needed in 5 days → share above 5 = 24/25.
  await po({
    po: "4500000001",
    material: "MH",
    planned: 0,
    poDate: open,
    requested: "2026-10-06",
    net: 100,
  });
  // A1b same key, outside the window (sibling for the receipt hook).
  await po({
    po: "4500000011",
    material: "MH",
    planned: 2,
    poDate: open,
    requested: "2026-11-30",
  });
  // A2 rule fires (planned 10, needed in 5 days).
  await po({
    po: "4500000002",
    material: "MR",
    planned: 10,
    poDate: open,
    requested: "2026-10-06",
    net: 50,
  });
  // A3 rule does not fire (planned 3, needed in 7).
  await po({
    po: "4500000003",
    material: "MR",
    planned: 3,
    poDate: open,
    requested: "2026-10-08",
    net: 9000,
  });
  // A5 model, default 2 days, needed in 8 → P = 1 − 8.5/20 = 0.575.
  await po({
    po: "4500000005",
    material: "MT",
    planned: 2,
    poDate: open,
    requested: "2026-10-09",
    net: 70,
  });
  // A6 model, needed in 18 → P = 0.075: not at risk.
  await po({
    po: "4500000006",
    material: "MT",
    planned: 999,
    poDate: open,
    requested: "2026-10-19",
    net: 70,
  });
  // Outside the window: after the horizon and before today.
  await po({
    po: "4500000007",
    material: "MT",
    planned: 0,
    poDate: open,
    requested: "2026-10-20",
  });
  await po({
    po: "4500000008",
    material: "MT",
    planned: 0,
    poDate: "2026-09-01",
    requested: "2026-10-02",
  });
  // 22 firing rule items in group 002 → top 20.
  for (let k = 0; k < 22; k++)
    await po({
      po: `46${String(k).padStart(8, "0")}`,
      material: "MR",
      planned: 10,
      poDate: open,
      requested: "2026-10-06",
      group: "002",
      net: 10 + k,
    });
  await cds.tx(() => materializeFacts());
});

after(() => new Promise<void>((r) => fake.close(() => r())));

test("dry run counts one call per plant and writes nothing", async () => {
  const m = meter();
  await step.run(ctx(true, m));
  assert.deepEqual(
    requests.map((r) => r.mode),
    ["dry_run", "dry_run"],
  );
  assert.equal(m.calls, 2);
  assert.equal(m.planned.length, 2);
  assert.equal(
    (await SELECT.from(`${NS}.Finding`).where`list = ${"at_risk"}`).length,
    0,
  );
  assert.equal((await SELECT.from(`${NS}.LineGrid`)).length, 0);
  assert.equal((await SELECT.from("tide.core.PredictionRun")).length, 0);
});

test("morning: one quantile call, window, ranks, sort, top 20, rates, grids", async () => {
  requests.length = 0;
  const m = meter();
  await step.run(ctx(false, m));
  assert.deepEqual(m.failed, []);
  // Dense and sparse lines are both modelled; overdue age groups run separately.
  assert.equal(requests.length, 2);
  const r = requests.find((request) => request.keys.includes("4500000001/10"))!;
  assert.deepEqual(r.output.levels, LEVELS);
  assert.deepEqual(r.columns.map((c: any) => c.name).sort(), [
    "Material",
    "MaterialGroup",
    "MaterialType",
    "OrderQuantity",
    "PlannedDays",
    "Supplier",
  ]);
  assert.ok(
    r.keys.includes("4500000001/10"),
    "dense own-history lines also receive model evidence",
  );
  assert.ok(
    r.keys.includes("4500000007/10") && r.keys.includes("4500000002/10"),
  );
  assert.ok(r.x_train.length > 0);

  const grids = await SELECT.from(`${NS}.LineGrid`);
  const open = await SELECT.from(`${NS}.ItemFact`).where({ IsOpen: true });
  assert.equal(grids.length, open.length, "every open line has a grid");
  const g1 = grids.find((g: any) => g.PurchaseOrder === "4500000001");
  assert.equal(g1.source, "tabpfn");
  assert.equal(g1.nOwn, 25);
  assert.equal(Object.keys(JSON.parse(g1.levels)).length, 19);
  assert.equal(g1.p50, 10);
  assert.equal(g1.nOwn, 25);
  const g5 = grids.find((g: any) => g.PurchaseOrder === "4500000005");
  assert.equal(g5.source, "tabpfn");
  assert.equal(g5.p50, 10);
  assert.equal(g5.atriskTrigger, "morning");
  assert.equal(g5.atriskNote, "Estimated this morning.");
  assert.match(
    g5.atriskSentence,
    /^AI estimate from similar deliveries: about 10 days.*not a promise\.$/,
  );
  assert.equal(
    g5.atriskWords,
    "Fast 2 days · typical 10 days · slow 18 days. Requested 8 days after the order, planned 2 days.",
  );
  assert.match(g1.atriskSentence, /^AI estimate from similar deliveries/);

  const rows: any[] = await SELECT.from(`${NS}.Finding`)
    .where`list = ${"at_risk"}`.orderBy("rank");
  const keys = rows.map((f) => f.objectKey);
  for (const out of [
    "4500000003/10",
    "4500000006/10",
    "4500000007/10",
    "4500000008/10",
    "4500000011/10",
  ])
    assert.ok(!keys.includes(out), `${out} not listed`);
  // Group 001 first: rule fires (rank 1), then probability rows by net amount desc.
  assert.deepEqual(keys.slice(0, 3), [
    "4500000002/10",
    "4500000001/10",
    "4500000005/10",
  ]);
  const g2 = rows.filter((f) => f.PurchasingGroup === "002");
  assert.equal(g2.length, 20);
  assert.equal(g2[0].objectKey, "4600000021/10", "net amount desc");
  assert.deepEqual(
    rows.map((f) => f.rank),
    rows.map((_, i) => i + 1),
  );

  const a1 = rows.find((f) => f.objectKey === "4500000001/10");
  const x1 = await SELECT.one
    .from(`${NS}.AtRiskDetail`)
    .where({ finding_ID: a1.ID });
  assert.equal(a1.source, "tabpfn");
  assert.equal(a1.sourceText, "AI estimate");
  assert.equal(x1.lateShare, 0.725);
  assert.equal(x1.ownDeliveries, 25);
  assert.equal(a1.itemTitle, "4500000001/10 · Bearing 6204");
  assert.equal(a1.itemSubtitle, "Acme Bearings GmbH · Plant P1");
  assert.equal(a1.dueDate, "2026-10-06");
  assert.equal(a1.nextStep, "Prepare a reminder");
  assert.equal(a1.nextActionKind, "reminder");
  assert.equal(a1.impactLevel, null);
  assert.match(
    a1.chain,
    /^Checked this morning: .* → Next: prepare a reminder\.$/,
  );
  assert.match(
    a1.technicalChain,
    /^morning run at 06:00 → .* → .* → prepare a reminder$/,
  );

  const a2 = rows.find((f) => f.objectKey === "4500000002/10");
  const x2 = await SELECT.one
    .from(`${NS}.AtRiskDetail`)
    .where({ finding_ID: a2.ID });
  assert.equal(a2.source, "rule");
  assert.equal(
    a2.issue,
    "Needed in 5 days, the planned time is 10 days; expected 5 days late",
  );
  // Rule fires in P1: 25 history rows (< 50) → overall rate 22/25.
  assert.equal(x2.lateShare, 0.88);

  const a5 = rows.find((f) => f.objectKey === "4500000005/10");
  assert.equal(a5.source, "tabpfn");
  assert.equal(a5.sourceText, "AI estimate");
  assert.equal(
    (await SELECT.one.from(`${NS}.AtRiskDetail`).where({ finding_ID: a5.ID }))
      .lateShare,
    0.575,
  );
  for (const f of rows)
    for (const t of [f.issue, f.chain, f.itemTitle])
      assert.doesNotMatch(t, /%|TabPFN|p50|quantile|empirical/);
});

test("hook po_item: new item at risk → arrived finding and event", async () => {
  register({} as cds.Service);
  await po({
    po: "4700000001",
    material: "MR",
    planned: 10,
    poDate: "2026-10-05",
    requested: "2026-10-08",
  });
  const out = await onPoItem(
    {
      kind: "po_item",
      at: "2026-10-05T09:00:00Z",
      rows: {
        PurchaseOrderItem: [
          { PurchaseOrder: "4700000001", PurchaseOrderItem: "10" },
        ],
      },
    },
    ctx(false),
  );
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].status, "at risk");
  const f = await SELECT.one
    .from(`${NS}.Finding`)
    .where({ ID: "at_risk:4700000001/10" });
  assert.equal(f.trigger, "arrived");
  assert.ok(f.arrivedAt);
  assert.match(f.chain, /^Checked as it arrived: /);
  const arrivalGrid = await SELECT.one.from(`${NS}.LineGrid`).where({
    PurchaseOrder: "4700000001",
    PurchaseOrderItem: "10",
  });
  assert.ok(arrivalGrid.modelRun_ID);
  assert.ok(arrivalGrid.modelInputFingerprint);
  assert.equal(arrivalGrid.modelBackend, "priorlabs");

  // On time by the rule → event, no finding.
  await po({
    po: "4700000002",
    material: "MR",
    planned: 3,
    poDate: "2026-10-05",
    requested: "2026-10-15",
  });
  const quiet = await onPoItem(
    {
      kind: "po_item",
      at: "2026-10-05T10:00:00Z",
      rows: {
        PurchaseOrderItem: [
          { PurchaseOrder: "4700000002", PurchaseOrderItem: "10" },
        ],
      },
    },
    ctx(false),
  );
  assert.equal(quiet.events[0].status, "on time");
  assert.equal(
    await SELECT.one
      .from(`${NS}.Finding`)
      .where({ ID: "at_risk:4700000002/10" }),
    undefined,
  );
});

test("hook goods_receipt: only source-confirmed completion closes the row and re-estimates open lines", async () => {
  await receipt("4500000001", "2026-10-05");
  const out = await onGoodsReceipt(
    {
      kind: "goods_receipt",
      at: "2026-10-05T11:00:00Z",
      rows: {
        MaterialDocumentItem: [
          { PurchaseOrder: "4500000001", PurchaseOrderItem: "10" },
        ],
      },
    },
    ctx(false),
  );
  assert.equal(out.events[0].status, "received");
  const f = await SELECT.one
    .from(`${NS}.Finding`)
    .where({ ID: "at_risk:4500000001/10" });
  assert.equal(
    f.status,
    "open",
    "a receipt event alone cannot close an obligation while source facts still report it open",
  );
  const sib = await SELECT.one
    .from(`${NS}.LineGrid`)
    .where({ PurchaseOrder: "4500000011", PurchaseOrderItem: "10" });
  assert.equal(sib.atriskTrigger, "receipt");
  assert.equal(sib.source, "tabpfn");
  assert.equal(sib.nOwn, 26);
});

test("findings expose their line grid", async () => {
  const { data } = await app.axios.get(
    "/odata/v4/desk/Findings?$filter=ID eq 'at_risk:4500000005/10'&$expand=lineGrid($select=p10,p50,p90,source)",
    {
      auth: {
        username: "ilyesse.hettenbach@cbs-consulting.de",
        password: "alice",
      },
    },
  );
  assert.equal(data.value[0].lineGrid.p50, 10);
  await DELETE.from(`${NS}.Event`);
});

test("overdue items get age-conditioned TabPFN arrival forecasts beyond the original tail", async () => {
  const plant = "POD";
  for (let index = 0; index < 4; index++) {
    await po({
      po: `490000010${index}`,
      material: "MOD",
      plant,
      planned: 2,
      poDate: "2026-05-01",
      requested: "2026-06-01",
      receipt: addDays("2026-05-01", 75 + index),
    });
  }
  await po({
    po: "4900000200",
    material: "MOD",
    plant,
    planned: 2,
    poDate: "2026-09-01",
    requested: "2026-09-05",
  });
  await materializeFacts();
  requests.length = 0;
  await runMorning(ctx(false));
  const grid = await SELECT.one
    .from(`${NS}.LineGrid`)
    .where({ PurchaseOrder: "4900000200", PurchaseOrderItem: "10" });
  assert.equal(grid.openSource, "tabpfn");
  assert.equal(grid.openBasis, "grid");
  assert.ok(grid.arrivalP10 > AS_OF);
  assert.ok(
    grid.arrivalP90 >= grid.arrivalP80 && grid.arrivalP80 >= grid.arrivalP50,
  );
  assert.equal(grid.chanceLate, null);
  const request = requests.find((entry) =>
    entry.keys.includes("4900000200/10"),
  );
  assert.ok(request);
  assert.equal(request.y_train.length, 4);
  assert.ok(request.y_train.every((leadTime: number) => leadTime > 34));
});
