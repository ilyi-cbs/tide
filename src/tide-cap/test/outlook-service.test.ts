// The typed delivery worklist exposes delivery operations at its object-page
// route.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import path from "node:path";
import { before, test } from "node:test";
import { finding, itemImpact, seedFixtures } from "./fixtures/cockpit";
import { readOutlook } from "../srv/cockpit/outlook/read";
import { upsertDeliveryRisk } from "../srv/cockpit/kernel/delivery-risks";

const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const { INSERT, SELECT } = cds.ql;
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
};
const API = "/odata/v4/desk";
const WORKFLOW = "/odata/v4/workflow";
let caseID: string;

before(async () => {
  await app;
  const row = finding();
  await seedFixtures(cds.db, { findings: [row], itemImpacts: [itemImpact()] });
  caseID = await upsertDeliveryRisk(row, "at_risk");
});

test("typed delivery entity exposes and serves the delivery outlook", async () => {
  const direct = await readOutlook(caseID);
  assert.ok(direct);
  const metadata = await app.axios.get(`${API}/$metadata`, AUTH);
  assert.match(
    metadata.data,
    /<Parameter Name="in" Type="PurchasingDeskService.DeliveryRisks"\/>/,
  );
  assert.match(
    metadata.data,
    /Property Name="onTimeProbability" Type="Edm.Double"/,
  );
  assert.match(
    metadata.data,
    /Property Name="requestedDateMissed" Type="Edm.Boolean"/,
  );
  const key = encodeURIComponent(caseID);
  const result = await app.axios.get(
    `${API}/DeliveryRisks(header_ID='${key}')/PurchasingDeskService.outlook()`,
    { ...AUTH, validateStatus: () => true },
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.asOf, "2026-10-05");
  assert.ok(
    result.data.markers.some(
      (marker: { kind: string }) => marker.kind === "today",
    ),
  );
  assert.match(result.data.situation, /No reliable arrival estimate/);
});

test("typed delivery entity returns an empty delivery history when no receipts exist", async () => {
  const key = encodeURIComponent(caseID);
  const result = await app.axios.get(
    `${API}/DeliveryRisks(header_ID='${key}')/PurchasingDeskService.deliveryHistory()`,
    AUTH,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.observedReceipts, 0);
  assert.deepEqual(result.data.deliveries, []);
});

test("typed delivery entity returns its business impact through one bound operation", async () => {
  await INSERT.into("tide.cockpit.SalesOrderImpact").entries({
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    SalesOrder: "M900000048",
    SalesOrderItem: "10",
    Customer: "C900000048",
    CustomerName: "Horizon Technik s.r.o.",
    RequiredDate: "2026-10-15",
    PredictedDelayDays: 5,
    RevenueAtRisk: 12400,
    Currency: "EUR",
  });
  const key = encodeURIComponent(caseID);
  const result = await app.axios.get(
    `${API}/DeliveryRisks(header_ID='${key}')/PurchasingDeskService.businessImpact()`,
    AUTH,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.impactLevelText, "Customer order at risk");
  assert.deepEqual(result.data.salesOrders, [
    {
      SalesOrder: "M900000048",
      SalesOrderItem: "10",
      Customer: "C900000048",
      CustomerName: "Horizon Technik s.r.o.",
      RequiredDate: "2026-10-15",
      PredictedDelayDays: 5,
      RevenueAtRisk: 12400,
      Currency: "EUR",
    },
  ]);
  assert.deepEqual(result.data.productionOrders, []);
});

test("delivery outlook reads stored model probability and suppresses it for missed requests", async () => {
  const purchaseOrder = "4500000999";
  await INSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder: purchaseOrder,
    PurchaseOrderDate: "2026-09-01",
  });
  for (const [purchaseOrderItem, requested, missed] of [
    ["10", "2026-10-15", false],
    ["20", "2026-09-04", true],
  ] as const) {
    await INSERT.into("tide.s4.PurchaseOrderItem").entries({
      PurchaseOrder: purchaseOrder,
      PurchaseOrderItem: purchaseOrderItem,
      Material: "M1",
      Plant: "P1",
      PlannedDeliveryDurationInDays: 2,
    });
    await INSERT.into("tide.s4.PurchaseOrderScheduleLine").entries({
      PurchaseOrder: purchaseOrder,
      PurchaseOrderItem: purchaseOrderItem,
      ScheduleLine: "1",
      ScheduleLineDeliveryDate: requested,
      OpenPurchaseOrderQuantity: 1,
    });
    const findingRow = finding({
      PurchaseOrder: purchaseOrder,
      PurchaseOrderItem: purchaseOrderItem,
      objectKey: `${purchaseOrder}/${purchaseOrderItem}`,
      list: missed ? "overdue" : "at_risk",
    });
    await seedFixtures(cds.db, {
      findings: [findingRow],
      lineGrids: [
        {
          PurchaseOrder: purchaseOrder,
          PurchaseOrderItem: purchaseOrderItem,
          source: "tabpfn",
          openSource: "tabpfn",
          openBasis: "grid",
          arrivalAsOf: "2026-10-05",
          arrivalP10: "2026-10-06",
          arrivalP50: "2026-10-15",
          arrivalP80: "2026-10-20",
          arrivalP90: "2026-10-25",
          chanceLate: 0.27,
        },
      ],
    });
    const deliveryCaseID = await upsertDeliveryRisk(
      findingRow,
      missed ? "overdue" : "at_risk",
    );
    const response = await app.axios.get(
      `${API}/DeliveryRisks(header_ID='${encodeURIComponent(deliveryCaseID)}')/PurchasingDeskService.outlook()`,
      AUTH,
    );
    assert.equal(response.data.forecastKind, "tabpfn");
    assert.equal(response.data.plannedDays, 2);
    assert.equal(response.data.onTimeProbability, missed ? null : 0.73);
    assert.equal(response.data.requestedDateMissed, missed);
  }
});

test("typed delivery entity exposes its buyer-facing case contract", async () => {
  const metadata = await app.axios.get(`${API}/$metadata`, AUTH);
  assert.match(metadata.data, /Property Name="caseTitle" Type="Edm.String"/);
  assert.match(
    metadata.data,
    /NavigationProperty Name="caseEvents" Type="Collection\(PurchasingDeskService.CaseEvents\)"/,
  );
  assert.match(
    metadata.data,
    /Term="UI.SelectionPresentationVariant" Qualifier="ActionRequired"/,
  );
  const key = encodeURIComponent(caseID);
  const result = await app.axios.get(
    `${API}/DeliveryRisks(header_ID='${key}')?$select=caseTitle,casePriority,caseStatus,caseAttention&$expand=caseEvents($top=5)`,
    AUTH,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.data.caseTitle, /^4500000001\/10/);
  assert.equal(result.data.caseStatus, "open");
  assert.ok(Array.isArray(result.data.caseEvents));
});

test("typed delivery entity prepares and approves through workflow commands", async () => {
  const header = await SELECT.one
    .from("tide.cockpit.Cases")
    .where({ ID: caseID });
  const payload = {
    caseID,
    commandID: "outlook-prepare",
    expectedModifiedAt: header.modifiedAt,
    expectedFingerprint: header.sourceFingerprint,
  };
  const result = await app.axios.post(
    `${WORKFLOW}/prepareCaseAction`,
    payload,
    {
      ...AUTH,
      validateStatus: () => true,
    },
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.status, "needs_decision");
  const action = await SELECT.one
    .from("tide.cockpit.Actions")
    .where({ ID: result.data.actionID });
  assert.ok(action.summary);
  assert.equal(action.decisionReady, true);
  const repeated = await app.axios.post(
    `${WORKFLOW}/prepareCaseAction`,
    payload,
    AUTH,
  );
  assert.equal(repeated.data.actionID, result.data.actionID);
  const approved = await app.axios.post(
    `${WORKFLOW}/approveAction`,
    {
      actionID: result.data.actionID,
      commandID: "outlook-approve",
      expectedModifiedAt: result.data.actionModifiedAt,
    },
    { ...AUTH, validateStatus: () => true },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.status, "waiting");
});

test("typed overdue delivery prepares an escalation without a legacy finding", async () => {
  const overdueCaseID = await upsertDeliveryRisk(
    finding({
      PurchaseOrder: "4500000998",
      PurchaseOrderItem: "10",
      objectKey: "4500000998/10",
      list: "overdue",
      dueDate: "2026-10-01",
      revenueAtRisk: 12400,
      overdueDetail: { daysOverdue: 4 } as any,
    }),
    "overdue",
  );
  const header = await SELECT.one
    .from("tide.cockpit.Cases")
    .where({ ID: overdueCaseID });
  const prepared = await app.axios.post(
    `${WORKFLOW}/prepareCaseAction`,
    {
      caseID: overdueCaseID,
      commandID: "outlook-escalation",
      expectedModifiedAt: header.modifiedAt,
      expectedFingerprint: header.sourceFingerprint,
    },
    { ...AUTH, validateStatus: () => true },
  );
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const result = await app.axios.get(
    `${API}/Actions('${prepared.data.actionID}')`,
    AUTH,
  );
  assert.equal(result.data.operationKey, "delivery_escalation");
  assert.equal(result.data.requestType, "Delivery Risk - Overdue");
  assert.equal(result.data.decisionReady, true);
  assert.match(result.data.summary, /4 days ago/);
  assert.match(result.data.summary, /12,400 EUR/);
  const saved = await app.axios.get(
    `${API}/Actions('${result.data.ID}')?$expand=items,caseActions`,
    AUTH,
  );
  assert.equal(saved.data.caseActions[0].header_ID, overdueCaseID);
  assert.equal(saved.data.items[0].oldValue, "2026-10-01");
  assert.doesNotMatch(saved.data.items[0].text, /12,400|revenue|customer/i);
});

test("fulfillment risks exposes the canonical sales-order revenue rows and PO context", async () => {
  const impactRow = itemImpact({
    revenueAtRisk: 180,
    salesOrderKeys: JSON.stringify([
      { key: "5000000001/10", netAmount: 100 },
      { key: "5000000002/20", netAmount: 80 },
    ]),
  });
  const findingRow = finding({
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
  });
  await seedFixtures(cds.db, {
    findings: [findingRow],
    itemImpacts: [impactRow],
  });
  const key = encodeURIComponent(findingRow.ID!);
  const response = await app.axios.get(
    `${API}/FulfillmentRisks('${key}')?$expand=impact($select=revenueAtRisk,salesOrderKeys)&$select=ID,PurchaseOrder,PurchaseOrderItem`,
    AUTH,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.impact.revenueAtRisk, 180);
  assert.deepEqual(JSON.parse(response.data.impact.salesOrderKeys), [
    { key: "5000000001/10", netAmount: 100 },
    { key: "5000000002/20", netAmount: 80 },
  ]);
  assert.equal(response.data.PurchaseOrder, "4500000001");
  assert.equal(response.data.PurchaseOrderItem, "10");
});

test("prevention findings expose and serve purchase-order context", async () => {
  const findingRow = finding({
    list: "price",
    objectKey: "4500000001/10",
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
  });
  await seedFixtures(cds.db, { findings: [findingRow] });
  await INSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder: "4500000001",
    PurchasingOrganization: "1000",
    PaymentTerms: "0001",
  });

  const metadata = await app.axios.get(`${API}/$metadata`, AUTH);
  assert.match(
    metadata.data,
    /<NavigationProperty Name="order" Type="PurchasingDeskService\.PurchaseOrderContext"/,
  );

  const key = encodeURIComponent(findingRow.ID!);
  const response = await app.axios.get(
    `${API}/PriceFindings('${key}')?$expand=order($select=PurchasingOrganization,PaymentTerms,originText)`,
    AUTH,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.order.PurchasingOrganization, "1000");
  assert.equal(response.data.order.PaymentTerms, "0001");
  assert.equal(response.data.order.originText, "Manually created");
});
