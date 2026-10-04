// Impact feature (P-2) against the database: ItemImpact for every open item,
// impact fields and at_risk re-ranking on findings, the confirmation hook and
// the goods-receipt hook. Uses the kernel fixtures (lineGrid, confirmation,
// finding) as the atrisk and rules streams write them in production.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import {
  onConfirmation,
  onSupplyChange,
  runImpact,
} from "../srv/cockpit/impact";
import { readBusinessImpact } from "../srv/cockpit/impact/read";
import { productionOrderImpactRows } from "../srv/cockpit/impact/day";
import {
  makeToOrder,
  type Impact,
  type ImpactItem,
} from "../srv/cockpit/impact/domain/impact";
import {
  FIXTURE_AS_OF,
  FIXTURE_SNAPSHOT,
  confirmation,
  finding,
  lineGrid,
  seedFixtures,
} from "./fixtures/cockpit";

const { SELECT, DELETE, INSERT, UPSERT } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const S4 = "tide.s4";
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
  validateStatus: () => true,
};
const AS_OF = FIXTURE_AS_OF; // 2026-10-05, Monday
const d = (n: number) =>
  new Date(Date.parse(`${AS_OF}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
const has = (e: string) => !!(cds.model?.definitions as any)?.[e];
const ctx = {
  asOf: AS_OF,
  snapshotId: FIXTURE_SNAPSHOT,
  dryRun: false,
  user: undefined as any,
  meter: undefined as any,
};

type Row = Record<string, any>;

function open(po: string, o: Row = {}): Row {
  return {
    PurchaseOrder: po,
    PurchaseOrderItem: "10",
    snapshot_ID: FIXTURE_SNAPSHOT,
    Material: "M1",
    Supplier: "S1",
    Plant: "P1",
    PurchaseOrderDate: d(-20),
    RequestedDate: d(3),
    OpenQuantity: 10,
    NetAmount: 100,
    Currency: "EUR",
    ...o,
  };
}

function poItem(po: string, o: Row = {}): Row {
  return {
    PurchaseOrder: po,
    PurchaseOrderItem: "10",
    Material: "M1",
    Plant: "P1",
    MaterialType: "ROH",
    AccountAssignmentCategory: "",
    PurchaseOrderItemCategory: "0",
    IsCompletelyDelivered: false,
    PurchasingDocumentDeletionCode: "",
    ...o,
  };
}

function salesItem(so: string, o: Row = {}): Row {
  return {
    SalesOrder: so,
    SalesOrderItem: "10",
    Product: "M1",
    Plant: "P1",
    RequestedDeliveryDate: d(5),
    RequestedQuantity: 5,
    NetAmount: 800,
    TransactionCurrency: "EUR",
    DeliveryStatus: "A",
    SalesOrderItemCategory: "TAN",
    ...o,
  };
}

// grid 0.05 → 10 days … 0.95 → 40 days: p50 ≈ 25 → arrival d(5) from a PO on d(-20)
const GRID = { lo: 10, hi: 40 };

async function seed(
  extra: {
    open?: Row[];
    po?: Row[];
    so?: Row[];
    aa?: Row[];
    stock?: Row[];
    prod?: Row[];
    comp?: Row[];
  } = {},
) {
  for (const e of [
    "ItemImpact",
    "Finding",
    "LineGrid",
    "Confirmation",
    "Event",
    "OpenItem",
    "Snapshot",
  ])
    await DELETE.from(`${NS}.${e}`);
  for (const e of [
    "PurchaseOrderItem",
    "PurchaseOrderAccountAssignment",
    "SalesOrderItem",
    "SalesOrder",
    "Customer",
    "MatlStkInAcctMod",
    "ProductionOrder",
    "ProductionOrderComponent",
  ])
    if (has(`${S4}.${e}`)) await DELETE.from(`${S4}.${e}`);
  const put = async (e: string, rows?: Row[]) => {
    if (rows?.length && has(`${S4}.${e}`))
      await UPSERT.into(`${S4}.${e}`).entries(rows);
  };
  if (extra.open?.length)
    await INSERT.into(`${NS}.OpenItem`).entries(extra.open);
  await put("PurchaseOrderItem", extra.po);
  await put("SalesOrderItem", extra.so);
  await put(
    "SalesOrder",
    (extra.so ?? []).map((s) => ({
      SalesOrder: s.SalesOrder,
      SoldToParty: `C${s.SalesOrder}`,
      SalesOrderDate: d(-30),
    })),
  );
  await put(
    "Customer",
    (extra.so ?? []).map((s) => ({
      Customer: `C${s.SalesOrder}`,
      CustomerName: `Customer ${s.SalesOrder}`,
    })),
  );
  await put("PurchaseOrderAccountAssignment", extra.aa);
  await put("MatlStkInAcctMod", extra.stock);
  await put("ProductionOrder", extra.prod);
  await put("ProductionOrderComponent", extra.comp);
}

async function impactOf(po: string): Promise<Row> {
  return SELECT.one
    .from(`${NS}.ItemImpact`)
    .where({ PurchaseOrder: po, PurchaseOrderItem: "10" });
}

before(async () => {
  await app;
});

beforeEach(async () => {
  await seed();
});

test("make-to-order (third party with sales order): revenue at risk once the customer is late, chain stored", async () => {
  await seed({
    open: [open("4500000001", { Material: "H1" })],
    po: [
      poItem("4500000001", {
        Material: "H1",
        MaterialType: "HAWA",
        AccountAssignmentCategory: "X",
        PurchaseOrderItemCategory: "5",
      }),
    ],
    aa: [
      {
        PurchaseOrder: "4500000001",
        PurchaseOrderItem: "10",
        AccountAssignmentNumber: "01",
        SalesOrder: "1000001",
        SalesOrderItem: "000010",
      },
    ],
    so: [
      salesItem("1000001", {
        Product: "H1",
        SalesOrderItemCategory: "TAS",
        RequestedDeliveryDate: d(2),
        NetAmount: 7000,
      }),
    ],
  });
  await seedFixtures(cds.db, {
    lineGrids: [lineGrid({ PurchaseOrder: "4500000001", ...GRID })],
  });
  assert.equal(await runImpact(ctx), 1);
  const i = await impactOf("4500000001");
  assert.equal(i.materialKind, "make_to_order");
  assert.equal(i.level, "customer_order_late");
  assert.equal(i.revenueAtRisk, 7000);
  assert.equal(i.needDate, d(2));
  assert.ok(i.customerDelayDays > 0);
  assert.equal(JSON.parse(i.chain).salesOrder, "1000001/10");
  assert.equal(JSON.parse(i.scenarios).length, 9);
  assert.equal(i.source, "calculation");
  assert.equal(i.impactLevelText, "Customer order at risk");
  assert.equal(i.impactKindText, "Bought for a sales order");
  const snap = await SELECT.one
    .from(`${NS}.Snapshot`)
    .where({ ID: FIXTURE_SNAPSHOT });
  assert.equal(snap.impactRevenueAtRisk, 7000);
});

test("impact uses stored forecast arrival dates after a purchase order date correction", async () => {
  await seed({
    open: [open("4500000007", { Material: "H1" })],
    po: [
      poItem("4500000007", {
        Material: "H1",
        MaterialType: "HAWA",
        AccountAssignmentCategory: "X",
        PurchaseOrderItemCategory: "5",
      }),
    ],
    aa: [
      {
        PurchaseOrder: "4500000007",
        PurchaseOrderItem: "10",
        AccountAssignmentNumber: "01",
        SalesOrder: "1000007",
        SalesOrderItem: "000010",
      },
    ],
    so: [
      salesItem("1000007", {
        Product: "H1",
        SalesOrderItemCategory: "TAS",
        RequestedDeliveryDate: d(2),
        NetAmount: 7000,
      }),
    ],
  });
  await seedFixtures(cds.db, {
    lineGrids: [
      lineGrid({
        PurchaseOrder: "4500000007",
        ...GRID,
        arrivalP10: d(5),
        arrivalP50: d(10),
        arrivalP80: d(12),
        arrivalP90: d(15),
      }),
    ],
  });
  await runImpact(ctx);
  const impact = await impactOf("4500000007");
  assert.equal(impact.expectedDate, d(10));
  assert.equal(impact.level, "customer_order_late");
  assert.equal(
    (
      await SELECT.from(`${NS}.SalesOrderImpact`).where({
        PurchaseOrder: "4500000007",
      })
    ).length,
    1,
  );
});

test("business impact returns order details, forecast scenarios and planning evidence", async () => {
  await seed({
    open: [open("4500000008", { Material: "H1" })],
    po: [
      poItem("4500000008", {
        Material: "H1",
        MaterialType: "HAWA",
        AccountAssignmentCategory: "X",
        PurchaseOrderItemCategory: "5",
      }),
    ],
    aa: [
      {
        PurchaseOrder: "4500000008",
        PurchaseOrderItem: "10",
        AccountAssignmentNumber: "01",
        SalesOrder: "1000008",
        SalesOrderItem: "000010",
      },
    ],
    so: [
      salesItem("1000008", {
        Product: "H1",
        RequestedDeliveryDate: d(2),
        NetAmount: 7000,
      }),
    ],
  });
  await seedFixtures(cds.db, {
    lineGrids: [lineGrid({ PurchaseOrder: "4500000008", ...GRID })],
  });
  const caseID = "delivery:4500000008/10";
  await UPSERT.into(`${NS}.Cases`).entries({
    ID: caseID,
    kind: "delivery_risk",
    status: "open",
  });
  await UPSERT.into(`${NS}.DeliveryRisks`).entries({
    header_ID: caseID,
    PurchaseOrder: "4500000008",
    PurchaseOrderItem: "10",
  });
  await runImpact(ctx);

  const detail = await readBusinessImpact(caseID);
  assert.ok(detail);
  assert.equal(detail.PurchaseOrder, "4500000008");
  assert.equal(detail.materialKind, "make_to_order");
  assert.equal(detail.stock, null);
  assert.equal(detail.revenueAtRisk, 7000);
  assert.equal(detail.salesOrders.length, 1);
  assert.equal(detail.salesOrders[0].SalesOrder, "1000008");
  assert.ok(detail.salesOrders[0].PredictedDelayDays > 0);
  assert.ok(detail.salesOrders[0].RevenueAtRisk > 0);
  assert.equal(detail.scenarios.length, 9);
  assert.ok(detail.planningRows.some((row) => row.affected));
  assert.equal(
    detail.expectedDate,
    (await impactOf("4500000008")).expectedDate,
  );
});

test("production impact rows retain each linked requirement rather than the primary order's values", () => {
  const item = open("4500000009", { OrderQuantityUnit: "PC" });
  const outcome = makeToOrder(
    item as ImpactItem,
    [1, 2].map((index) => ({
      assignment: "E" as const,
      order: {
        salesOrder: `100000${index}`,
        salesOrderItem: "10",
        customer: null,
        customerName: null,
        netAmount: 100,
        currency: "EUR",
        customerDate: d(index + 2),
      },
      productionOrder: {
        order: `P${index}`,
        product: `FG${index}`,
        end: d(index + 2),
      },
      component: {
        reservation: `R${index}`,
        item: "10",
        date: d(index),
        qty: index * 3,
      },
    })),
    d(10),
    AS_OF,
  );
  const rows = productionOrderImpactRows(item, outcome as Impact);

  assert.equal(rows[0].RequiredDate, d(1));
  assert.equal(rows[1].RequiredDate, d(2));
  assert.equal(rows[0].FinishedProduct, "FG1");
  assert.equal(rows[1].FinishedProduct, "FG2");
  assert.equal(rows[0].AffectedQuantity, 3);
  assert.equal(rows[1].AffectedQuantity, 6);
  assert.equal(rows[1].Unit, "PC");
});

test("make-to-stock severities from sales orders: customer order late, covered by stock, no impact; confirmed date wins", async () => {
  await seed({
    open: [
      open("4500000011", { Material: "A", RequestedDate: d(1) }), // sales order short
      open("4500000012", { Material: "B", RequestedDate: d(1) }), // covered by the confirmed earlier receipt 4500000014
      open("4500000013", { Material: "C", RequestedDate: d(8) }), // no requirement in window
      open("4500000014", {
        Material: "B",
        RequestedDate: d(0),
        OpenQuantity: 50,
      }),
    ],
    po: ["4500000011", "4500000012", "4500000013", "4500000014"].map((p, n) =>
      poItem(p, { Material: ["A", "B", "C", "B"][n] }),
    ),
    so: [
      salesItem("2000001", {
        Product: "A",
        RequestedDeliveryDate: d(3),
        NetAmount: 800,
      }),
      salesItem("2000002", {
        Product: "B",
        RequestedDeliveryDate: d(3),
        NetAmount: 500,
      }),
    ],
  });
  await seedFixtures(cds.db, {
    lineGrids: ["4500000011", "4500000012", "4500000013"].map((p) =>
      lineGrid({ PurchaseOrder: p, ...GRID }),
    ),
    confirmations: [confirmation({ PurchaseOrder: "4500000014", date: d(0) })],
  });
  await runImpact(ctx);
  const a = await impactOf("4500000011");
  assert.equal(a.level, "customer_order_late");
  assert.equal(a.revenueAtRisk, 800);
  assert.equal(a.shortageFrom, d(3));
  const md04 = JSON.parse(a.md04);
  assert.ok(md04.some((r: Row) => r.own && r.date === a.expectedDate));
  assert.ok(md04.some((r: Row) => r.affected && r.id === "2000001/10"));
  assert.equal((await impactOf("4500000012")).level, "covered_by_stock");
  assert.equal((await impactOf("4500000013")).level, "no_impact");
  assert.equal((await impactOf("4500000014")).confirmedDate, d(0));
});

test(
  "stock and production orders: production affected; spare part covered",
  {
    skip:
      !has(`${S4}.ProductionOrderComponent`) &&
      "loader tables not in the model yet",
  },
  async () => {
    await seed({
      open: [
        open("4500000021", { Material: "R", RequestedDate: d(1) }),
        open("4500000022", { Material: "S", RequestedDate: d(1) }),
      ],
      po: [
        poItem("4500000021", { Material: "R" }),
        poItem("4500000022", { Material: "S", MaterialType: "ERSA" }),
      ],
      stock: [
        {
          Material: "R",
          Plant: "P1",
          StorageLocation: "0001",
          Batch: "",
          Supplier: "",
          Customer: "",
          WBSElementInternalID: "",
          SDDocument: "",
          SDDocumentItem: "",
          InventorySpecialStockType: "",
          InventoryStockType: "01",
          MatlWrhsStkQtyInMatlBaseUnit: 2,
        },
        {
          Material: "S",
          Plant: "P1",
          StorageLocation: "0001",
          Batch: "",
          Supplier: "",
          Customer: "",
          WBSElementInternalID: "",
          SDDocument: "",
          SDDocumentItem: "",
          InventorySpecialStockType: "",
          InventoryStockType: "01",
          MatlWrhsStkQtyInMatlBaseUnit: 100,
        },
      ],
      prod: [
        {
          ManufacturingOrder: "100000001",
          Material: "FP",
          ProductionPlant: "P1",
          TotalQuantity: 1,
          MfgOrderPlannedStartDate: d(2),
          MfgOrderPlannedEndDate: d(9),
          OrderIsReleased: "X",
          SalesOrder: "",
          SalesOrderItem: "",
        },
      ],
      comp: [
        {
          Reservation: "9001",
          ReservationItem: "1",
          ManufacturingOrder: "100000001",
          Material: "R",
          Plant: "P1",
          MatlCompRequirementDate: d(2),
          RequiredQuantity: 5,
          WithdrawnQuantity: 0,
        },
      ],
    });
    await seedFixtures(cds.db, {
      lineGrids: ["4500000021", "4500000022"].map((p) =>
        lineGrid({ PurchaseOrder: p, ...GRID }),
      ),
    });
    await runImpact(ctx);
    const r = await impactOf("4500000021");
    assert.equal(r.level, "production_affected");
    assert.equal(r.productionOrders, 1);
    assert.equal(r.stock, 2);
    const s = await impactOf("4500000022");
    assert.equal(s.materialKind, "spare_part");
    assert.equal(s.level, "no_impact");
  },
);

test("findings of the impact lists get impact fields; at_risk is re-ranked by impact", async () => {
  await seed({
    open: [
      open("4500000031", { Material: "A", RequestedDate: d(1) }),
      open("4500000032", { Material: "C", RequestedDate: d(8) }),
    ],
    po: [
      poItem("4500000031", { Material: "A" }),
      poItem("4500000032", { Material: "C" }),
    ],
    so: [
      salesItem("3000001", {
        Product: "A",
        RequestedDeliveryDate: d(3),
        NetAmount: 12400,
      }),
    ],
  });
  await seedFixtures(cds.db, {
    lineGrids: ["4500000031", "4500000032"].map((p) =>
      lineGrid({ PurchaseOrder: p, ...GRID }),
    ),
    findings: [
      finding({
        objectKey: "4500000032/10",
        PurchaseOrder: "4500000032",
        rank: 1,
      }),
      finding({
        objectKey: "4500000031/10",
        PurchaseOrder: "4500000031",
        rank: 2,
      }),
      finding({
        list: "overdue",
        objectKey: "4500000031/10",
        PurchaseOrder: "4500000031",
        rank: 1,
        source: "rule",
      }),
      finding({
        list: "price",
        objectKey: "4500000031/10",
        PurchaseOrder: "4500000031",
        rank: 1,
        source: "rule",
      }),
    ],
  });
  await runImpact(ctx);
  const rows: Row[] = await SELECT.from(`${NS}.Finding`).orderBy("ID");
  const by = Object.fromEntries(rows.map((r) => [r.ID, r]));
  assert.equal(by["at_risk:4500000031/10"].rank, 1);
  assert.equal(by["at_risk:4500000032/10"].rank, 2);
  assert.equal(
    by["at_risk:4500000031/10"].impactText,
    "Customer order at risk · 12,400 EUR",
  );
  assert.equal(by["at_risk:4500000031/10"].impactCriticality, 1);
  assert.equal(by["at_risk:4500000031/10"].revenueAtRisk, 12400);
  assert.equal(by["at_risk:4500000031/10"].deliveryPriority, "Critical");
  assert.equal(by["at_risk:4500000031/10"].deliveryPriorityOrder, 0);
  assert.ok(by["at_risk:4500000031/10"].predictedArrival);
  assert.equal(by["at_risk:4500000031/10"].arrivalSource, "grid");
  assert.equal(by["at_risk:4500000032/10"].impactLevel, "no_impact");
  assert.equal(by["at_risk:4500000032/10"].impactCriticality, 0);
  assert.equal(by["at_risk:4500000032/10"].deliveryPriority, "Low");
  assert.equal(by["overdue:4500000031/10"].impactLevel, "customer_order_late");
  assert.equal(by["price:4500000031/10"].impactLevel, null);
  const res = await app.get(
    "/odata/v4/desk/Findings('at_risk:4500000031%2F10')?$expand=impact($select=level,md04)",
    AUTH,
  );
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.impact.level, "customer_order_late");
});

test("a confirmation replaces the estimate; the hook returns an event with impact before → after", async () => {
  await seed({
    open: [open("4500000041", { Material: "A", RequestedDate: d(1) })],
    po: [poItem("4500000041", { Material: "A" })],
    so: [
      salesItem("4000001", {
        Product: "A",
        RequestedDeliveryDate: d(3),
        NetAmount: 900,
      }),
    ],
  });
  await seedFixtures(cds.db, {
    lineGrids: [lineGrid({ PurchaseOrder: "4500000041", ...GRID })],
    findings: [
      finding({ objectKey: "4500000041/10", PurchaseOrder: "4500000041" }),
    ],
  });
  await runImpact(ctx);
  const before = await impactOf("4500000041");
  assert.equal(before.level, "customer_order_late");
  assert.ok(before.cautiousDate);
  await seedFixtures(cds.db, {
    snapshots: [],
    confirmations: [confirmation({ PurchaseOrder: "4500000041", date: d(2) })],
  });
  const out = await onConfirmation(
    {
      kind: "confirmation",
      at: `${AS_OF}T10:00:00Z`,
      rows: {
        Confirmations: [
          { PurchaseOrder: "4500000041", PurchaseOrderItem: "10" },
        ],
      },
    },
    ctx,
  );
  const after = await impactOf("4500000041");
  assert.equal(after.expectedDate, d(2));
  assert.equal(after.confirmedDate, d(2));
  assert.equal(after.cautiousDate, null);
  assert.equal(after.level, "no_impact");
  assert.equal(out.events.length, 1);
  assert.match(
    out.events[0].title!,
    /Confirmation for PO 4500000041 item 10: delivery on 2026-10-07/,
  );
  assert.match(out.events[0].title!, /Customer order at risk → No impact/);
  assert.equal(out.events[0].findingID, "at_risk:4500000041/10");
  const f = await SELECT.one
    .from(`${NS}.Finding`)
    .where({ ID: "at_risk:4500000041/10" });
  assert.equal(f.impactLevel, "no_impact");
});

test("goods receipt: the delivered item drops out, others of the material are recomputed", async () => {
  await seed({
    open: [
      open("4500000051", {
        Material: "A",
        RequestedDate: d(1),
        OpenQuantity: 10,
      }),
      open("4500000052", {
        Material: "A",
        RequestedDate: d(1),
        OpenQuantity: 10,
      }),
    ],
    po: [
      poItem("4500000051", { Material: "A" }),
      poItem("4500000052", { Material: "A" }),
    ],
    so: [
      salesItem("5000001", {
        Product: "A",
        RequestedDeliveryDate: d(3),
        RequestedQuantity: 5,
      }),
    ],
  });
  await seedFixtures(cds.db, {
    lineGrids: [lineGrid({ PurchaseOrder: "4500000052", ...GRID })],
    confirmations: [confirmation({ PurchaseOrder: "4500000051", date: d(1) })],
  });
  await runImpact(ctx);
  assert.equal((await impactOf("4500000052")).level, "covered_by_stock");
  await UPSERT.into(`${S4}.PurchaseOrderItem`).entries(
    poItem("4500000051", { Material: "A", IsCompletelyDelivered: true }),
  );
  await onSupplyChange(
    {
      kind: "goods_receipt",
      at: `${AS_OF}T09:00:00Z`,
      rows: {
        MaterialDocumentItems: [
          {
            PurchaseOrder: "4500000051",
            PurchaseOrderItem: "10",
            Material: "A",
            Plant: "P1",
          },
        ],
      },
    },
    ctx,
  );
  assert.equal(await impactOf("4500000051"), undefined);
  // the stock row is not updated by the receipt here, so the other item's delay now hits the sales order
  assert.equal((await impactOf("4500000052")).level, "customer_order_late");
});

test("dry run writes nothing", async () => {
  await seed({ open: [open("4500000061")], po: [poItem("4500000061")] });
  assert.equal(await runImpact({ ...ctx, dryRun: true }), 0);
  assert.equal((await SELECT.from(`${NS}.ItemImpact`)).length, 0);
});
