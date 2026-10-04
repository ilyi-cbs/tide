import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type ImpactSection = {
  _buildState: (
    impact: Record<string, unknown>,
    salesOrders: unknown,
    productionOrders: unknown,
  ) => Record<string, unknown>;
};

let section: ImpactSection;
runInNewContext(
  readFileSync(
    "app/purchasing-desk/webapp/ext/finding/BusinessImpactSection.js",
    "utf8",
  ),
  {
    sap: {
      ui: {
        define: (
          _dependencies: unknown,
          factory: (
            _JSONModel: unknown,
            DateFormat: {
              getDateInstance: () => { format: (date: Date) => string };
            },
          ) => ImpactSection,
        ) => {
          section = factory(undefined, {
            getDateInstance: () => ({
              format: (date: Date) => date.toISOString().slice(0, 10),
            }),
          });
        },
      },
    },
  },
);

test("impact rankings separate calendar and working days, retaining raw evidence and excluding zero", () => {
  const sales = Array.from({ length: 7 }, (_, index) => ({
    SalesOrder: "SO" + index,
    PredictedDelayDays: index,
    RequiredDate: "2026-10-01",
    CustomerName: "Customer",
    RevenueAtRisk: 0,
    Currency: "USD",
  }));
  const state = section._buildState({}, sales, [
    {
      ProductionOrder: "PR1",
      PredictedShortageDays: 2,
      AffectedQuantity: 0,
      Unit: "EA",
    },
    { ProductionOrder: "PR2", PredictedShortageDays: null },
  ]) as any;
  assert.equal(state.salesDelayChart.unit, "calendar days");
  assert.equal(state.productionShortageChart.unit, "working days");
  assert.equal(state.salesDelayChart.rows.length, 5);
  assert.equal(state.salesDelayChart.rows[0].value, 6);
  assert.equal(state.salesDelayChart.rows[0].requiredDate, "2026-10-01");
  assert.equal(state.salesDelayChart.rows[0].revenue, 0);
  assert.equal(state.salesDelayChart.rows[0].currency, "USD");
  assert.equal(state.productionShortageChart.rows.length, 1);
  assert.equal(state.productionShortageChart.rows[0].quantity, 0);
  assert.equal(state.salesOrders.length, 7);
  assert.equal(section._buildState({}, [], []).hasSalesDelayChart, false);
});

test("Business Impact renders the delivery-risk response even with null unit and malformed list contexts", () => {
  const state = section._buildState(
    {
      impactLevelText: "Customer order at risk",
      shortageFrom: "2026-09-04",
      shortageDays: 36,
    },
    [
      {
        getObject: () => ({
          SalesOrder: "M900000048",
          SalesOrderItem: "10",
          CustomerName: "Horizon Technik s.r.o.",
          RequiredDate: "2026-09-04",
          PredictedDelayDays: 50,
          RevenueAtRisk: 51000,
          Currency: "EUR",
        }),
      },
      null,
      {
        getObject: () => {
          throw new Error("stale context");
        },
      },
    ],
    [
      {
        getObject: () => ({
          ProductionOrder: "P700000048",
          FinishedProduct: "FG-30000009",
          RequiredDate: "2026-09-04",
          PredictedShortageDays: 36,
          AffectedQuantity: 10,
          Unit: null,
        }),
      },
    ],
  );

  assert.equal(state.state, "loaded");
  assert.equal(state.hasSalesOrders, true);
  assert.equal(state.hasProductionOrders, true);
  assert.equal(state.hasSalesDelayChart, true);
  const delayChart = state.salesDelayChart as { rows: Array<{ value: number; revenue: number }> };
  assert.equal(delayChart.rows.length, 1);
  assert.equal(delayChart.rows[0].value, 50);
  assert.equal(delayChart.rows[0].revenue, 51000);
  assert.equal(state.outcome, "Customer order at risk");
  assert.deepEqual(JSON.parse(JSON.stringify(state.salesOrders)), [
    {
      salesOrderLabel: "M900000048 / 10",
      customer: "Horizon Technik s.r.o.",
      requiredDate: "2026-09-04",
      delayDays: 50,
      revenue: 51000,
      currency: "EUR",
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.productionOrders)), [
    {
      productionOrder: "P700000048",
      finishedProduct: "FG-30000009",
      requiredDate: "2026-09-04",
      shortageDays: 36,
      affectedQuantity: 10,
      unit: "",
    },
  ]);
});

test("Business Impact renders an empty response when a delivery case has no persisted impact", () => {
  const state = section._buildState(
    null as unknown as Record<string, unknown>,
    undefined,
    undefined,
  );

  assert.equal(state.state, "loaded");
  assert.equal(state.hasImpact, false);
  assert.equal(state.hasSalesOrders, false);
  assert.equal(state.hasProductionOrders, false);
  assert.equal(
    state.outcome,
    "No affected customer or production order is calculated for the current forecast.",
  );
});

test("Business Impact visibility stays boolean when stock is missing but a shortage date exists", () => {
  for (const stock of [null, undefined]) {
    const state = section._buildState(
      { stock, shortageFrom: "2026-10-05" },
      [],
      [],
    );

    assert.equal(state.state, "loaded");
    assert.equal(state.hasStock, true);
    assert.equal(state.hasImpact, true);
    assert.equal(state.status, "Warning");
    assert.equal(
      state.outcome,
      "Stock is projected to run short for the current forecast.",
    );
    assert.equal(
      state.stockSummary,
      "Stock: not available · short from 2026-10-05",
    );
  }
});

test("Business Impact treats zero stock as available stock data", () => {
  const state = section._buildState({ stock: 0 }, [], []);

  assert.equal(state.hasStock, true);
  assert.equal(state.hasImpact, true);
  assert.equal(state.stockSummary, "Stock: 0");
});

test("Business Impact exposes forecast details, per-order delay visualization and planning rows", () => {
  const state = section._buildState(
    {
      PurchaseOrder: "4500000069",
      PurchaseOrderItem: "50",
      materialKind: "make_to_order",
      expectedDate: "2026-10-23",
      cautiousDate: "2026-11-22",
      arrivalSource: "grid",
      needDate: "2026-10-05",
      stock: null,
      shortageFrom: "2026-10-05",
      shortageDays: 14,
      revenueAtRisk: 153750,
      scenarios: [
        {
          level: 0.5,
          arrival: "2026-10-23",
          revenue: 153750,
          customerDelayDays: 19,
        },
      ],
      planningRows: [
        {
          date: "2026-10-05",
          elementText: "Reservation",
          id: "R1/10",
          qty: -10,
          available: -10,
          own: false,
          affected: true,
        },
      ],
    },
    [
      {
        SalesOrder: "SO1",
        SalesOrderItem: "10",
        RequiredDate: "2026-12-01",
        PredictedDelayDays: 19,
        RevenueAtRisk: 153750,
      },
    ],
    [
      {
        ProductionOrder: "P1",
        RequiredDate: "2026-09-03",
        PredictedShortageDays: 35,
      },
    ],
  );

  assert.equal(state.purchaseOrder, "4500000069 / 50");
  assert.equal(state.needDate, "2026-09-03");
  assert.equal(state.expectedDate, "2026-10-23");
  assert.equal(state.revenueAtRisk, 153750);
  assert.equal(state.stockSummary, "");
  assert.equal(state.stockLabel, "Not applicable: sales-order-specific supply");
  assert.equal(state.hasForecastChart, true);
  assert.equal(
    (state.forecastChart as { points: Array<{ y: number }> }).points[0].y,
    19,
  );
  assert.equal(state.hasScenarios, true);
  assert.equal(
    (state.scenarios as Array<Record<string, unknown>>)[0].quantile,
    "P50",
  );
  assert.equal(state.hasPlanningRows, false);
  assert.equal(
    (state.planningRows as Array<Record<string, unknown>>)[0].status,
    "Affected demand",
  );
});

test("Business Impact form fields do not interrupt rendering of downstream tables", () => {
  const fragment = readFileSync(
    "app/purchasing-desk/webapp/ext/finding/BusinessImpactSection.fragment.xml",
    "utf8",
  );
  assert.doesNotMatch(fragment, /<form:fields>\s*<VBox/);
  assert.match(fragment, /id="businessImpactSales"/);
  assert.match(fragment, /id="businessImpactProduction"/);
  assert.match(
    fragment,
    /id="businessImpactSalesPair"[^\n]*tideImpactOrderPair/,
  );
  assert.match(
    fragment,
    /id="businessImpactProductionPair"[^\n]*tideImpactOrderPair/,
  );
  assert.match(fragment, /id="businessImpactSalesPanel"[^\n]*height="20rem"/);
  assert.match(
    fragment,
    /id="businessImpactProductionPanel"[^\n]*height="20rem"/,
  );
  assert.match(
    fragment,
    /id="businessImpactForecastVisual"[^\n]*tideImpactForecastVisual/,
  );
  assert.doesNotMatch(fragment, /zoomLevel=/);
  assert.match(
    readFileSync(
      "app/purchasing-desk/webapp/ext/finding/BusinessImpactSection.js",
      "utf8",
    ),
    /flow\.setZoomLevel\("One"\)/,
  );
  assert.match(
    fragment,
    /id="businessImpactContext" headerText="Supply and forecast context"/,
  );
  assert.match(
    fragment,
    /id="businessImpactSalesPanel"[^\n]*expandable="true"[^\n]*expanded="true"/,
  );
  assert.match(
    fragment,
    /id="businessImpactProductionPanel"[^\n]*expandable="true"[^\n]*expanded="true"/,
  );
});

test("Forecast chart uses scenario customer delays only, retaining zero and skipping missing data", () => {
  const state = section._buildState(
    {
      scenarios: [
        { level: 0.9, arrival: "2026-10-23", customerDelayDays: 50 },
        { level: 0.1, arrival: "2026-09-03", customerDelayDays: 0 },
        { level: 0.5, arrival: "2026-10-01", customerDelayDays: null },
        { level: 0.8, arrival: "invalid", customerDelayDays: 10 },
      ],
    },
    [
      { SalesOrder: "SO1", PredictedDelayDays: 50 },
      { SalesOrder: "SO2", PredictedDelayDays: 0 },
      { SalesOrder: "SO3", PredictedDelayDays: null },
    ],
    [{ ProductionOrder: "P1", PredictedShortageDays: 36 }],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(state.forecastChart)).points.map(
      (row: { y: number }) => row.y,
    ),
    [0, 50],
  );
  assert.equal(state.hasForecastChart, true);
  assert.equal(section._buildState({}, [], []).hasForecastChart, false);
});

test("ProcessFlow exposes aggregate demand dependencies without inventing missing production links", () => {
  const state = section._buildState({}, [{ SalesOrder: "SO1" }], []);
  const nodes = JSON.parse(JSON.stringify(state.flowNodes));
  assert.deepEqual(nodes[0].children, ["customer"]);
  assert.deepEqual(nodes[1].children, []);
  assert.equal(nodes[1].state, "Neutral");
  assert.equal(nodes[1].title, "0 production orders");
  assert.equal(nodes[2].title, "1 sales orders");
  assert.equal(nodes[2].stateText, "Delivery at risk");
});
