// Rules (P-13) on the database: the step writes the four rule lists from
// tide.s4 rows, missing optional data gives empty lists, enterConfirmation
// validates, records, prepares post_confirmation and runs the confirmation
// hooks; feeder hooks close rows without an action.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { before, beforeEach, describe, test } from "node:test";
import { registerHook, runHooks } from "../srv/cockpit/kernel/hooks";
import type { StepContext } from "../srv/cockpit/kernel/types";
import { prepareAction } from "../srv/cockpit/kernel/actions";
import { decide as kernelDecide } from "../srv/cockpit/kernel/action-state";
import { asWorkflowCommand } from "./fixtures/workflow";
import { ensureCase } from "../srv/cockpit/kernel/cases";
import { step } from "../srv/cockpit/rules";
import {
  FIXTURE_AS_OF,
  FIXTURE_SNAPSHOT,
  finding,
  seedFixtures,
} from "./fixtures/cockpit";

const { INSERT, SELECT, DELETE } = cds.ql;
const decide = (...args: Parameters<typeof kernelDecide>) =>
  asWorkflowCommand(() => kernelDecide(...args));

// Waiting interventions reconcile only from S4 confirmations created after approval.
async function seedSourceConfirmation(po: string, quantity: number) {
  const SupplierConfirmation = `SC${po}`;
  for (const e of [
    "SupplierConfirmation",
    "SupplierConfirmationItem",
    "SupplierConfirmationLine",
  ])
    await DELETE.from(`${S4}.${e}`).where({ SupplierConfirmation });
  await cds.ql.UPDATE.entity(`${S4}.PurchaseOrderItem`)
    .set({ PurchaseOrderQuantityUnit: "PC" })
    .where({ PurchaseOrder: po, PurchaseOrderItem: "10" });
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await INSERT.into(`${S4}.SupplierConfirmation`).entries({
    SupplierConfirmation,
    SuplrConfRefPurchaseOrder: po,
    CreationDate: tomorrow,
  });
  await INSERT.into(`${S4}.SupplierConfirmationItem`).entries({
    SupplierConfirmation,
    SupplierConfirmationItem: "1",
    SuplrConfRefPurchaseOrder: po,
    SuplrConfRefPurchaseOrderItem: "10",
    ItemIsRejectedBySupplier: false,
  });
  await INSERT.into(`${S4}.SupplierConfirmationLine`).entries({
    SupplierConfirmation,
    SupplierConfirmationItem: "1",
    SupplierConfirmationLine: "1",
    DeliveryDate: "2026-10-15",
    ConfirmedQuantity: quantity,
    PurchaseOrderQuantityUnit: "PC",
  });
}
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const S4 = "tide.s4";
const AS_OF = FIXTURE_AS_OF; // Monday 2026-10-05
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
  validateStatus: () => true,
};

const ctx = (): StepContext => ({
  user: new (cds as any).User.Privileged("test"),
  snapshotId: FIXTURE_SNAPSHOT,
  asOf: AS_OF,
  dryRun: false,
  meter: {
    user: null as any,
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  },
});

interface Item {
  po: string;
  item?: string;
  date: string;
  req?: string;
  material?: string;
  plant?: string;
  price?: number;
  per?: number;
  qty?: number;
  open?: number;
  received?: string;
}

async function seedS4(items: Item[]) {
  for (const e of [
    "PurchaseOrder",
    "PurchaseOrderItem",
    "PurchaseOrderScheduleLine",
    "MaterialDocumentItem",
    "Product",
    "ProductDescription",
    "ProductPlantSupplyPlanning",
    "ProductPlantProcurement",
    "Supplier",
  ])
    await DELETE.from(`${S4}.${e}`);
  const pos = [...new Map(items.map((i) => [i.po, i])).values()];
  await INSERT.into(`${S4}.PurchaseOrder`).entries(
    pos.map((i) => ({
      PurchaseOrder: i.po,
      PurchaseOrderDate: i.date,
      Supplier: "S1",
      PurchasingGroup: "001",
      DocumentCurrency: "EUR",
    })),
  );
  await INSERT.into(`${S4}.Supplier`).entries({
    Supplier: "S1",
    SupplierName: "Supplier One GmbH",
    Country: "DE",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries(
    items.map((i) => ({
      PurchaseOrder: i.po,
      PurchaseOrderItem: i.item ?? "10",
      Material: i.material ?? "M1",
      Plant: i.plant ?? "P1",
      OrderQuantity: i.qty ?? 10,
      NetPriceAmount: i.price ?? 10,
      NetPriceQuantity: i.per ?? 1,
      NetAmount: ((i.price ?? 10) / (i.per ?? 1)) * (i.qty ?? 10),
      DocumentCurrency: "EUR",
    })),
  );
  await INSERT.into(`${S4}.PurchaseOrderScheduleLine`).entries(
    items.map((i) => ({
      PurchaseOrder: i.po,
      PurchaseOrderItem: i.item ?? "10",
      ScheduleLine: "1",
      ScheduleLineDeliveryDate: i.req ?? i.date,
      ScheduleLineOrderQuantity: i.qty ?? 10,
      OpenPurchaseOrderQuantity: i.open ?? (i.received ? 0 : (i.qty ?? 10)),
    })),
  );
  const docs = items.filter((i) => i.received);
  if (docs.length)
    await INSERT.into(`${S4}.MaterialDocumentItem`).entries(
      docs.map((i, n) => ({
        MaterialDocumentYear: "2026",
        MaterialDocument: `50${n}`,
        MaterialDocumentItem: "1",
        PostingDate: i.received,
        GoodsMovementType: "101",
        GoodsMovementIsCancelled: false,
        PurchaseOrder: i.po,
        PurchaseOrderItem: i.item ?? "10",
        Material: i.material ?? "M1",
        Plant: i.plant ?? "P1",
        QuantityInEntryUnit:
          i.open != null ? (i.qty ?? 10) - i.open : (i.qty ?? 10),
      })),
    );
}

const findings = async (list: string) =>
  (await SELECT.from(`${NS}.Finding`)
    .where([{ ref: ["list"] }, "=", { val: list }] as any)
    .orderBy("rank", "ID")) as any[];

before(async () => {
  await app;
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
    "Confirmation",
    "RuleLine",
  ])
    await DELETE.from(`${NS}.${e}`);
  await seedFixtures(cds.db);
});

describe("rules step", () => {
  test("overdue: visible after due date, partial receipts retained, sorted by days then value", async () => {
    await seedS4([
      { po: "A1", date: "2026-07-01", req: "2026-09-04", price: 5 }, // 31 days
      { po: "A2", date: "2026-07-01", req: "2026-09-05" }, // 30 days: not overdue
      { po: "A3", date: "2026-06-01", req: "2026-08-01" }, // 65 days
      { po: "A4", date: "2026-07-01", req: "2026-09-04", price: 50 }, // 31 days, higher value
      {
        po: "A5",
        date: "2026-06-01",
        req: "2026-08-01",
        qty: 10,
        open: 4,
        received: "2026-08-10",
      }, // partly received
    ]);
    await step.run(ctx());
    const rows = await findings("overdue");
    assert.deepEqual(
      rows.map((r) => r.PurchaseOrder),
      ["A3", "A5", "A4", "A1", "A2"],
    );
    assert.equal(rows[2].dueDate, "2026-09-04");
    const overdueDetail = await SELECT.one
      .from(`${NS}.OverdueDetail`)
      .where({ finding_ID: rows[2].ID });
    assert.equal(overdueDetail.daysOverdue, 31);
    assert.equal(rows[2].deliveryPriority, "Medium");
    const report = await app.get(
      "/odata/v4/desk/FulfillmentRisks?$select=ID,deliveryPriority&$expand=overdueDetail($select=daysOverdue)&$filter=list eq 'overdue'",
      AUTH,
    );
    assert.equal(report.status, 200, JSON.stringify(report.data));
    assert.equal(
      report.data.value.find((r: any) => r.ID === "overdue:A4/10")
        ?.overdueDetail?.daysOverdue,
      31,
    );
    assert.equal(rows[2].nextStep, "Escalate overdue delivery");
    assert.equal(rows[2].nextActionKind, "reminder");
    assert.equal(rows[2].sourceText, "Check");
    assert.equal(rows[2].itemSubtitle, "Supplier One GmbH · Plant P1");
    assert.match(
      rows[0].chain,
      /^Checked this morning: No goods receipt, requested date 65 days ago\. Next: prepare a reminder\.$/,
    );
  });

  test("price: empirical factor slips alone do not create cases without calibrated TabPFN evidence", async () => {
    await seedS4([
      { po: "C1", date: "2026-01-10", price: 10, received: "2026-01-20" },
      {
        po: "C2",
        date: "2026-02-10",
        price: 1100,
        per: 100,
        received: "2026-02-20",
      }, // 11 per unit
      { po: "C3", date: "2026-03-10", price: 9, received: "2026-03-20" },
      { po: "C4", date: "2026-09-20", price: 1000, received: "2026-09-25" }, // 100 × 10
      { po: "C5", date: "2026-09-21", price: 20, material: "M2" }, // no history
    ]);
    await step.run(ctx());
    const rows = await findings("price");
    assert.equal(rows.length, 0);
  });

  test("duplicates and rare combinations from material master data", async () => {
    await seedS4([
      { po: "D1", date: "2026-09-01", material: "MA", req: "2026-12-01" },
      { po: "D2", date: "2026-09-01", material: "MB", req: "2026-12-01" },
      { po: "D3", date: "2026-09-01", material: "MC", req: "2026-12-01" },
    ]);
    await INSERT.into(`${S4}.Product`).entries(
      ["MA", "MB", "MC", "MD"].map((p) => ({ Product: p, ProductType: "ROH" })),
    );
    await INSERT.into(`${S4}.ProductDescription`).entries([
      { Product: "MA", Language: "EN", ProductDescription: "Bearing 6204-ZZ" },
      { Product: "MB", Language: "EN", ProductDescription: "bearing 6204 zz" },
      { Product: "MC", Language: "EN", ProductDescription: "Screw M8" },
      { Product: "MD", Language: "EN", ProductDescription: "Bearing 6204 ZZ" }, // inactive
    ]);
    const plan = (Product: string, MRPType: string) => ({
      Product,
      Plant: "P1",
      MRPType,
      MRPResponsible: "001",
      ProcurementType: "F",
      ProcurementSubType: null,
      LotSizingProcedure: "EX",
    });
    await INSERT.into(`${S4}.ProductPlantSupplyPlanning`).entries([
      plan("MA", "PD"),
      plan("MB", "PD"),
      plan("MC", "PD"),
      plan("MD", "VB"),
    ]);
    await step.run(ctx());
    const dup = await findings("duplicate");
    assert.equal(dup.length, 1);
    assert.equal(dup[0].itemSubtitle, "MA, MB");
    assert.equal(dup[0].rank, 1);
    const members = await SELECT.from(`${NS}.RuleLine`).where({
      findingID: dup[0].ID,
    });
    assert.equal(members.length, 2);
    const duplicateDetail = await SELECT.one
      .from(`${NS}.DuplicateDetail`)
      .where({ finding_ID: dup[0].ID });
    assert.deepEqual(
      [
        duplicateDetail.candidateCount,
        duplicateDetail.materialType,
        duplicateDetail.materialNumbers,
      ],
      [2, "ROH", "MA, MB"],
    );
    const rare = await findings("rare");
    assert.deepEqual(
      rare.map((r) => r.Material),
      ["MD"],
    );
    assert.match(rare[0].issue, /^Only material in this plant with /);
    const pairs = await SELECT.from(`${NS}.RuleLine`).where({
      findingID: rare[0].ID,
      kind: "pair",
    });
    assert.ok(pairs.length >= 1 && pairs.every((p: any) => p.n3 === 1));
    const rareDetail = await SELECT.one
      .from(`${NS}.RareDetail`)
      .where({ finding_ID: rare[0].ID });
    assert.ok(rareDetail.unusualPairCount >= 1);
    assert.equal(rareDetail.materialType, "ROH");
  });

  test("dry run writes nothing", async () => {
    await seedS4([{ po: "A3", date: "2026-06-01", req: "2026-08-01" }]);
    await step.run({ ...ctx(), dryRun: true });
    assert.equal((await findings("overdue")).length, 0);
  });
});

describe("enterConfirmation", () => {
  const call = (data: object) =>
    app.axios.post("/odata/v4/desk/enterConfirmation", data, AUTH);

  test("validation: unknown item 404, closed item, quantity and date refused", async () => {
    await seedS4([
      { po: "E1", date: "2026-09-01", req: "2026-10-20", qty: 10 },
      {
        po: "E2",
        date: "2026-09-01",
        req: "2026-10-20",
        received: "2026-09-20",
      },
    ]);
    const base = {
      PurchaseOrder: "E1",
      PurchaseOrderItem: "10",
      date: "2026-10-15",
      quantity: 5,
    };
    assert.equal((await call({ ...base, PurchaseOrder: "NOPE" })).status, 404);
    const closed = await call({ ...base, PurchaseOrder: "E2" });
    assert.equal(closed.status, 400);
    assert.match(closed.data.error.message, /no longer open/);
    assert.match(
      (await call({ ...base, quantity: 0 })).data.error.message,
      /greater than 0/,
    );
    assert.match(
      (await call({ ...base, quantity: 11 })).data.error.message,
      /more than the open quantity/,
    );
    assert.match(
      (await call({ ...base, date: "2026-08-31" })).data.error.message,
      /before the PO date/,
    );
    assert.equal((await SELECT.from(`${NS}.Confirmation`)).length, 0);
  });

  test("records origin app without creating a retroactive approval, runs hooks, returns the at_risk row", async () => {
    await seedS4([
      { po: "E1", date: "2026-09-01", req: "2026-10-20", qty: 10 },
    ]);
    await seedFixtures(cds.db, {
      findings: [
        finding({
          list: "at_risk",
          objectKey: "E1/10",
          PurchaseOrder: "E1",
          PurchaseOrderItem: "10",
        }),
      ],
    });
    const seen: any[] = [];
    registerHook("confirmation", "zz-test.confirmation", async (ev) => {
      seen.push(ev);
      return {
        events: [
          {
            kind: "confirmation",
            title: "impact recomputed",
            objectKey: "E1/10",
          },
        ],
      };
    });
    const res = await call({
      PurchaseOrder: "E1",
      PurchaseOrderItem: "10",
      date: "2026-10-15",
      quantity: 10,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ID, "at_risk:E1/10");
    const conf = await SELECT.from(`${NS}.Confirmation`);
    assert.deepEqual(
      conf.map((c: any) => [c.origin, c.date, c.quantity, c.enteredBy]),
      [["app", "2026-10-15", 10, "ilyesse.hettenbach@cbs-consulting.de"]],
    );
    assert.equal(
      (await SELECT.from(`${NS}.Actions`).where({ kind: "post_confirmation" }))
        .length,
      0,
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].rows.Confirmation[0].origin, "app");
    const events = await SELECT.from(`${NS}.Event`).where({
      title: "impact recomputed",
    });
    assert.equal(events.length, 1);
    // a second line for the same item is its own posting
    assert.equal(
      (
        await call({
          PurchaseOrder: "E1",
          PurchaseOrderItem: "10",
          date: "2026-10-16",
          quantity: 2,
        })
      ).status,
      200,
    );
    assert.equal((await SELECT.from(`${NS}.Confirmation`)).length, 2);
    registerHook("confirmation", "zz-test.confirmation", async () => {});
  });

  test("workflow confirmation is receipted: replay records once, reuse and foreign callers are refused", async () => {
    await seedS4([
      { po: "W1", date: "2026-09-01", req: "2026-10-20", qty: 10 },
    ]);
    const post = (data: object, auth = AUTH) =>
      app.axios.post("/odata/v4/workflow/enterConfirmation", data, auth);
    const payload = {
      PurchaseOrder: "W1",
      PurchaseOrderItem: "10",
      date: "2026-10-15",
      quantity: 4,
      commandID: "confirm-W1-once",
    };
    const first = await post(payload);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.caseID, "delivery:W1/10");
    const replay = await post(payload);
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.deepEqual(replay.data, first.data);
    assert.equal((await SELECT.from(`${NS}.Confirmation`)).length, 1);
    assert.equal((await post({ ...payload, quantity: 5 })).status, 409);
    const foreign = await post(
      { ...payload, commandID: "confirm-W1-foreign" },
      { ...AUTH, auth: { username: "buyerD07", password: "buyerD07" } },
    );
    assert.equal(foreign.status, 404);
    assert.equal((await SELECT.from(`${NS}.Confirmation`)).length, 1);
  });

  test("confirmation resolves a waiting intervention but leaves escalation and delivery case open", async () => {
    await seedS4([
      { po: "E2", date: "2026-09-01", req: "2026-10-20", qty: 10 },
    ]);
    await seedFixtures(cds.db, {
      findings: [
        finding({
          list: "at_risk",
          objectKey: "E2/10",
          PurchaseOrder: "E2",
          PurchaseOrderItem: "10",
        }),
      ],
    });
    const problemKey = "delivery:E2/10";
    await ensureCase({ ID: problemKey, kind: "delivery", title: "E2/10" });
    const intervention = await prepareAction({
      kind: "reminder",
      objectKey: "E2/10",
      problemKey,
      operationKey: "delivery_intervention",
      title: "Request confirmation",
      via: "app",
      items: [{ objectKey: "E2/10", text: "Confirm." }],
    });
    const escalation = await prepareAction({
      kind: "reminder",
      objectKey: "E2/10",
      problemKey,
      operationKey: "delivery_escalation",
      title: "Escalate",
      via: "app",
      items: [{ objectKey: "E2/10", text: "Escalate." }],
    });
    await decide(intervention.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: AS_OF,
    });
    await decide(escalation.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: AS_OF,
    });
    await seedSourceConfirmation("E2", 10);
    const response = await app.axios.post(
      "/odata/v4/desk/enterConfirmation",
      {
        PurchaseOrder: "E2",
        PurchaseOrderItem: "10",
        date: "2026-10-15",
        quantity: 10,
      },
      AUTH,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(
      (await SELECT.one.from(`${NS}.Actions`).where({ ID: intervention.ID }))
        .status,
      "resolved",
    );
    assert.equal(
      (await SELECT.one.from(`${NS}.Actions`).where({ ID: escalation.ID }))
        .status,
      "waiting",
    );
    assert.equal(
      (await SELECT.one.from(`${NS}.Cases`).where({ ID: problemKey })).status,
      "open",
    );
  });

  test("feeder confirmation reconciles a waiting intervention", async () => {
    await seedS4([
      { po: "E3", date: "2026-09-01", req: "2026-10-20", qty: 10 },
    ]);
    await ensureCase({
      ID: "delivery:E3/10",
      kind: "delivery",
      title: "E3/10",
    });
    const approval = await prepareAction({
      kind: "reminder",
      objectKey: "E3/10",
      problemKey: "delivery:E3/10",
      operationKey: "delivery_intervention",
      title: "Request confirmation",
      via: "app",
      items: [{ objectKey: "E3/10", text: "Confirm." }],
    });
    await decide(approval.ID, {
      decidedBy: "ilyesse.hettenbach@cbs-consulting.de",
      asOf: AS_OF,
    });
    await seedSourceConfirmation("E3", 10);
    await cds.tx({ user: cds.User.privileged }, () =>
      runHooks(
        {
          kind: "confirmation",
          at: "2026-10-05T12:00:00Z",
          rows: {
            Confirmation: [
              {
                PurchaseOrder: "E3",
                PurchaseOrderItem: "10",
                date: "2026-10-17",
                quantity: 10,
                origin: "feeder",
              },
            ],
          },
        },
        ctx(),
      ),
    );
    assert.equal(
      (await SELECT.one.from(`${NS}.Actions`).where({ ID: approval.ID }))
        .status,
      "resolved",
    );
  });

  test("a supplier confirmation cannot be used to close the delivery obligation", async () => {
    await seedFixtures(cds.db, {
      findings: [
        finding({
          list: "at_risk",
          objectKey: "C1/10",
          PurchaseOrder: "C1",
          PurchaseOrderItem: "10",
        }),
        finding({
          list: "at_risk",
          objectKey: "C2/10",
          PurchaseOrder: "C2",
          PurchaseOrderItem: "10",
        }),
      ],
      confirmations: [
        {
          PurchaseOrder: "C1",
          PurchaseOrderItem: "10",
          line: 1,
          date: "2026-10-05",
          quantity: 1,
          enteredBy: "SAP",
          enteredAt: "2026-10-05T06:00:00Z",
          origin: "sap",
        },
      ],
    });
    const closed = await app.axios.post(
      "/odata/v4/desk/FulfillmentRisks('at_risk%3AC1%2F10')/PurchasingDeskService.ignoreConfirmed",
      { note: "Supplier acknowledgement recorded" },
      AUTH,
    );
    assert.equal(closed.status, 409, JSON.stringify(closed.data));
    assert.equal(
      (await SELECT.one.from(`${NS}.Finding`).where({ ID: "at_risk:C1/10" }))
        .status,
      "open",
    );
    const blocked = await app.axios.post(
      "/odata/v4/desk/FulfillmentRisks('at_risk%3AC2%2F10')/PurchasingDeskService.ignoreConfirmed",
      {},
      { ...AUTH, validateStatus: () => true },
    );
    assert.equal(blocked.status, 409);
  });
});

describe("feeder hooks", () => {
  test("confirmation from the feeder: origin feeder recorded, no action", async () => {
    const events = await runHooks(
      {
        kind: "confirmation",
        at: "2026-10-05T10:00:00Z",
        rows: {
          SupplierConfirmationItem: [
            {
              SupplierConfirmation: "C9",
              SupplierConfirmationItem: "1",
              SuplrConfRefPurchaseOrder: "F1",
              SuplrConfRefPurchaseOrderItem: "00010",
            },
          ],
          SupplierConfirmationLine: [
            {
              SupplierConfirmation: "C9",
              SupplierConfirmationItem: "1",
              DeliveryDate: "2026-10-20",
              ConfirmedQuantity: 3,
            },
          ],
        },
      },
      ctx(),
    );
    const conf = await SELECT.from(`${NS}.Confirmation`);
    assert.deepEqual(
      conf.map((c: any) => [
        c.PurchaseOrder,
        c.PurchaseOrderItem,
        c.origin,
        c.date,
      ]),
      [["F1", "10", "feeder", "2026-10-20"]],
    );
    assert.equal((await SELECT.from(`${NS}.Actions`)).length, 0);
    assert.ok(events.some((e) => e.objectKey === "F1/10"));
  });

  test("a goods-receipt notification without source evidence cannot close overdue obligations", async () => {
    await seedFixtures(cds.db, {
      findings: [
        finding({
          list: "overdue",
          objectKey: "G1/10",
          PurchaseOrder: "G1",
          PurchaseOrderItem: "10",
          source: "rule",
        }),
        finding({
          list: "overdue",
          objectKey: "G2/10",
          PurchaseOrder: "G2",
          PurchaseOrderItem: "10",
          source: "rule",
        }),
      ],
    });
    await runHooks(
      {
        kind: "goods_receipt",
        at: "2026-10-05T09:00:00Z",
        rows: {
          MaterialDocumentItem: [
            { PurchaseOrder: "G1", PurchaseOrderItem: "10" },
          ],
        },
      },
      ctx(),
    );
    const st = Object.fromEntries(
      (await SELECT.from(`${NS}.Finding`).columns("ID", "status")).map(
        (r: any) => [r.ID, r.status],
      ),
    );
    assert.equal(st["overdue:G1/10"], "open");
    assert.equal(st["overdue:G2/10"], "open");
    assert.equal(
      (
        await SELECT.from(`${NS}.CaseEvents`).where({
          event: "source_resolved",
        })
      ).length,
      0,
    );
  });

  test("new PO item: an empirical factor slip alone does not create an arrived price case", async () => {
    await seedS4([
      { po: "H1", date: "2026-05-01", price: 10, received: "2026-05-10" },
      { po: "H2", date: "2026-06-01", price: 10, received: "2026-06-10" },
      { po: "H3", date: "2026-07-01", price: 10, received: "2026-07-10" },
      { po: "H4", date: AS_OF, price: 0.1 }, // arrives today, 100 × lower
    ]);
    const events = await runHooks(
      {
        kind: "po_item",
        at: "2026-10-05T11:00:00Z",
        rows: {
          PurchaseOrderItem: [
            {
              PurchaseOrder: "H4",
              PurchaseOrderItem: "10",
              Material: "M1",
              Plant: "P1",
            },
          ],
        },
      },
      ctx(),
    );
    const rows = await findings("price");
    assert.equal(rows.length, 0);
    assert.ok(!events.some((e) => e.findingID === "price:H4/10"));
  });
});
