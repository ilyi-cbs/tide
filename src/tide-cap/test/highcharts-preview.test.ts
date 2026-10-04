import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type ChartOptions = {
  chart: {
    height: number;
    marginBottom: number;
    events: { render: (this: unknown) => void };
  };
  accessibility: { description: string };
  xAxis: {
    type: string;
    min?: number;
    max?: number;
    minTickInterval?: number;
    plotLines: Array<{ value: number }>;
    plotBands?: unknown[];
  };
  yAxis: { categories: string[]; reversed: boolean };
  series: Array<{
    type: string;
    pointWidth?: number;
    dataLabels?: {
      formatter?: (this: {
        x?: number;
        name?: string;
        custom?: { emphasized?: boolean; range?: string };
      }) => string;
    };
    data: Array<{
      x?: number;
      x2?: number;
      y: number;
      name?: string;
      custom?: { emphasized?: boolean; range?: string };
      marker?: { radius: number; fillColor?: string; lineWidth?: number };
    }>;
  }>;
};

let preview: {
  renderLanes: (
    host: unknown,
    config: Record<string, unknown>,
    labels?: Record<string, string>,
  ) => unknown;
  renderRange: (
    host: unknown,
    range: Record<string, unknown>,
    labels?: Record<string, string>,
  ) => unknown;
  render: (
    host: unknown,
    outlook: Record<string, unknown>,
    labels: Record<string, string>,
  ) => unknown;
};
let rendered: ChartOptions | undefined;

runInNewContext(
  readFileSync("app/purchasing-desk/webapp/ext/outlook/HighchartsPreview.js", "utf8"),
  {
    Date,
    Number,
    String,
    queueMicrotask,
    sap: {
      ui: {
        define: (
          _dependencies: string[],
          factory: (...modules: unknown[]) => typeof preview,
        ) => {
          preview = factory(
            { get: () => ({}) },
            {
              time: {
                dateFormat: (_format: string, value: number) =>
                  new Date(value).toISOString().slice(0, 10),
              },
              color: () => ({
                setOpacity: () => ({ get: () => "rgba(10,110,209,0.2)" }),
              }),
              chart: (_host: unknown, options: ChartOptions) => {
                rendered = options;
                return { destroy: () => {} };
              },
            },
          );
        },
      },
    },
  },
);

test("single-supplier arrival chart shows P95 on a visible date scale without inventing P99", () => {
  preview.renderLanes(
    {},
    {
      asOf: "2026-10-04",
      needDate: "2026-10-05",
      rows: [
        {
          name: "Supplier",
          points: [
            { quantile: 0.5, date: "2026-10-14" },
            { quantile: 0.8, date: "2026-10-18" },
            { quantile: 0.9, date: "2026-10-22" },
            { quantile: 0.95, date: "2026-10-28" },
          ],
        },
      ],
    },
  );
  assert.ok(rendered);
  assert.deepEqual(
    Array.from(rendered.series[1].data, (point) => point.name),
    ["P50", "P80", "P90", "P95"],
  );
  assert.equal(rendered.series[0].data[0].x2, Date.parse("2026-10-28"));
  assert.equal(
    (rendered.series[0].data[0].custom as { range?: string }).range,
    "P50-P95",
  );
  assert.equal(
    (rendered.xAxis as ChartOptions["xAxis"] & { labels: { enabled: boolean } })
      .labels.enabled,
    true,
  );
  assert.match(
    readFileSync("app/purchasing-desk/webapp/css/style.css", "utf8"),
    /\.tideSimulationArrivalChart\s*\{\s*width:\s*100%/,
  );
});

test("arrival chart spans P30-P95 on a calendar axis and retains exact dates in tooltips", () => {
  preview.renderLanes(
    {},
    {
      asOf: "2026-10-04",
      needDate: "2026-10-23",
      rows: [
        {
          name: "Supplier",
          points: [
            { quantile: 0.3, date: "2026-10-08" },
            { quantile: 0.5, date: "2026-10-11" },
            { quantile: 0.8, date: "2026-10-13" },
            { quantile: 0.95, date: "2026-10-19" },
          ],
        },
      ],
    },
  );
  assert.ok(rendered);
  assert.equal(rendered.series[0].data[0].x, Date.parse("2026-10-08"));
  assert.equal(rendered.series[0].data[0].x2, Date.parse("2026-10-19"));
  assert.equal(rendered.series[0].data[0].custom?.range, "P30-P95");
  const axis = rendered.xAxis as ChartOptions["xAxis"] & {
    labels: { formatter: (this: { value: number }) => string };
  };
  assert.equal(
    axis.labels.formatter.call({ value: Date.parse("2026-10-04") }),
    "2026-10-04",
  );
  assert.equal(
    axis.labels.formatter.call({ value: Date.parse("2026-10-11") }),
    "2026-10-11",
  );
  assert.equal(axis.min, Date.parse("2026-10-04"));
  assert.equal(axis.minTickInterval, 86400000);
  const marker = rendered.series[1].data[0];
  const caption = rendered.series[1].dataLabels?.formatter?.call(marker);
  assert.match(caption || "", /P30/);
  assert.doesNotMatch(caption || "", /2026|Oct/);
  const tooltip = (
    rendered as unknown as { tooltip: { formatter: (this: unknown) => string } }
  ).tooltip;
  assert.match(
    tooltip.formatter.call({
      ...marker,
      custom: { supplier: "Supplier", late: false },
    }),
    /2026-10-08/,
  );
});

test("simulation exposes comparison as a checkbox and a non-numeric AI loading bar", () => {
  const xml = readFileSync(
    "app/purchasing-desk/webapp/ext/planning/Planning.view.xml",
    "utf8",
  );
  assert.match(xml, /<CheckBox id="planCompareSuppliers"/);
  assert.match(xml, /selected="\{plan>\/compareSuppliers\}"/);
  assert.doesNotMatch(xml, /<Button id="planCompareSuppliers"/);
  assert.match(xml, /percentValue="\{plan>\/simulationProgress\}"/);
  assert.match(xml, /showValue="false"/);
  assert.match(xml, /scenarioP30/);
  assert.match(xml, /scenarioP40/);
  assert.match(xml, /<CheckBox id="planForcePrediction"/);
  assert.match(xml, /selected="\{plan>\/forcePrediction\}"/);
  assert.match(xml, /id="planPanelPrice"[^>]*expandable="false"/);
  const controller = readFileSync(
    "app/purchasing-desk/webapp/ext/planning/Planning.controller.js",
    "utf8",
  );
  assert.equal(
    (controller.match(/setParameter\(\s*"force",/g) || []).length,
    2,
  );
});

test("simulation comparison is opt-in and slowing progress cleans up on success, errors, and exit", async () => {
  let definition:
    Record<string, (...parameters: unknown[]) => unknown> | undefined;
  let tick: (() => void) | undefined;
  let cleared = 0;
  runInNewContext(
    readFileSync(
      "app/purchasing-desk/webapp/ext/planning/Planning.controller.js",
      "utf8",
    ),
    {
      setInterval: (callback: () => void, delay: number) => {
        assert.equal(delay, 250);
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        cleared += 1;
        tick = undefined;
      },
      sap: {
        ui: {
          define: (
            dependencies: string[],
            factory: (...modules: unknown[]) => typeof definition,
          ) => {
            definition = factory(
              ...dependencies.map((dependency) => {
                if (dependency === "sap/fe/core/PageController")
                  return {
                    prototype: {},
                    extend: (_name: string, methods: typeof definition) =>
                      methods,
                  };
                if (dependency === "sap/ui/core/format/DateFormat")
                  return { getDateInstance: () => ({ format: String }) };
                if (dependency === "sap/ui/core/format/NumberFormat")
                  return { getFloatInstance: () => ({ format: String }) };
                if (dependency === "sap/ui/core/library")
                  return { InvisibleMessageMode: {} };
                return {};
              }),
            );
          },
        },
      },
    },
  );
  assert.ok(definition);
  const onMatched = definition._onMatched;
  let detachedRoutes = 0;
  for (const [compare, fail] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const properties = new Map<string, unknown>([
      ["/input", { Material: "30000009", Plant: "DE11" }],
      ["/compareSuppliers", compare],
    ]);
    let comparisons = 0;
    let finishComparison: (() => void) | undefined;
    const operation = {
      setParameter: () => {},
      invoke: () =>
        fail ? Promise.reject(new Error("Unavailable")) : Promise.resolve(),
      getBoundContext: () => ({ getObject: () => ({ rows: [] }) }),
    };
    const controller: Record<string, any> = Object.assign({}, definition, {
      _model: {
        getProperty: (path: string) => properties.get(path),
        setProperty: (path: string, value: unknown) =>
          properties.set(path, value),
      },
      getView: () => ({ getModel: () => ({ bindContext: () => operation }) }),
      _invalidateComparison: () => {},
      _show: () => {},
      _text: () => "Unavailable",
      _invisibleMessage: { announce: () => {} },
      onCompareSuppliers: () => {
        comparisons += 1;
        return new Promise<void>((resolve) => {
          finishComparison = resolve;
        });
      },
    });
    const request = controller.onCalculate();
    assert.equal(properties.get("/busy"), true);
    assert.equal(controller.onCalculate(), undefined);
    const start = Number(properties.get("/simulationProgress"));
    assert.ok(tick);
    tick();
    const first = Number(properties.get("/simulationProgress"));
    tick();
    const second = Number(properties.get("/simulationProgress"));
    assert.ok(
      first > start && second > first && second - first < first - start,
    );
    for (let index = 0; index < 200; index++) tick();
    assert.ok(Number(properties.get("/simulationProgress")) < 93);
    await Promise.resolve();
    if (compare && !fail) {
      assert.equal(properties.get("/busy"), true);
      assert.ok(finishComparison);
      finishComparison();
    }
    await request;
    assert.equal(comparisons, compare && !fail ? 1 : 0);
    assert.equal(properties.get("/busy"), false);
    assert.equal(properties.get("/simulationProgress"), 100);
    assert.equal(tick, undefined);
    if (fail) assert.equal(properties.get("/error"), "Unavailable");
    controller._startSimulationProgress();
    controller._simulationRoutes = ["Simulation", "Planning"].map(() => ({
      detachPatternMatched: (handler: unknown, owner: unknown) => {
        assert.equal(handler, onMatched);
        assert.equal(owner, controller);
        detachedRoutes += 1;
      },
    }));
    controller.onExit();
    assert.equal(tick, undefined);
    assert.equal(controller._simulationRoutes, null);
  }
  assert.equal(detachedRoutes, 6);
  assert.equal(cleared, 6);
  const properties = new Map<string, unknown>([
    ["/input", { Material: "30000009", Plant: "DE11" }],
  ]);
  const pending: Array<() => void> = [];
  let applied = 0;
  const operation = {
    setParameter: () => {},
    invoke: () => new Promise<void>((resolve) => pending.push(resolve)),
    getBoundContext: () => ({ getObject: () => ({ rows: [] }) }),
  };
  const controller = Object.assign({}, definition, {
    _model: {
      getProperty: (path: string) => properties.get(path),
      setProperty: (path: string, value: unknown) =>
        properties.set(path, value),
    },
    getView: () => ({ getModel: () => ({ bindContext: () => operation }) }),
    _invalidateComparison: () => {},
    _show: () => {
      applied += 1;
    },
    _asOf: () => Promise.resolve("2026-10-04"),
    _checkNeedDate: () => {},
  });
  const first = controller.onCalculate();
  controller._onMatched({
    getParameter: () => ({ "?query": { Material: "20000329", Plant: "DE21" } }),
  });
  const second = controller.onCalculate();
  pending[0]();
  await first;
  assert.equal(applied, 0);
  assert.equal(properties.get("/busy"), true);
  assert.ok(tick);
  pending[1]();
  await second;
  assert.equal(applied, 1);
  assert.equal(properties.get("/busy"), false);
  assert.equal(tick, undefined);
  assert.equal(cleared, 8);
});

test("supplier comparison plots available prices without fabricating unavailable estimates", () => {
  const xml = readFileSync(
    "app/purchasing-desk/webapp/ext/planning/Planning.view.xml",
    "utf8",
  );
  assert.match(xml, /id="planPriceChart"/);
  assert.match(xml, /comparisonPriceLanes/);
  assert.doesNotMatch(xml, /id="planSupplierPriceChart"/);
  assert.match(xml, /id="planSupplierPriceUnavailable"/);
});

type RangeControl = {
  onBeforeRendering: () => void;
  onAfterRendering: () => void;
  exit: () => void;
};

function rangeControlFixture(width = 600) {
  const host = { clientWidth: width };
  const calls = {
    renders: 0,
    destroys: 0,
    reflows: 0,
    registrations: 0,
    deregistrations: 0,
  };
  const captures: Array<{
    range: Record<string, unknown>;
    labels: Record<string, unknown>;
  }> = [];
  let resize: () => void = () => {};
  let makeControl: (
    properties: Record<string, unknown>,
  ) => RangeControl = () => {
    throw new Error("Control not loaded");
  };
  runInNewContext(
    readFileSync("app/purchasing-desk/webapp/ext/rangeBar/RangeChart.js", "utf8"),
    {
      Date,
      sap: {
        ui: {
          define: (
            _dependencies: string[],
            factory: (...modules: unknown[]) => typeof makeControl,
          ) => {
            makeControl = factory(
              {
                extend:
                  (_name: string, definition: Record<string, unknown>) =>
                  (properties: Record<string, unknown>) => {
                    const control = Object.assign(
                      { getDomRef: () => host },
                      definition,
                    );
                    const metadata = definition.metadata as {
                      properties: Record<string, { defaultValue: unknown }>;
                    };
                    for (const [name, property] of Object.entries(
                      metadata.properties,
                    )) {
                      Object.assign(control, {
                        ["get" + name[0].toUpperCase() + name.slice(1)]: () =>
                          properties[name] ?? property.defaultValue,
                      });
                    }
                    return control as unknown as RangeControl;
                  },
              },
              {
                register: (_control: unknown, callback: () => void) => {
                  calls.registrations += 1;
                  resize = callback;
                  return "range-resize";
                },
                deregister: (id: string) => {
                  assert.equal(id, "range-resize");
                  calls.deregistrations += 1;
                },
              },
              {
                getDateInstance: () => ({
                  format: (value: Date) => value.toISOString().slice(0, 10),
                }),
              },
              {
                renderLanes: (
                  _host: unknown,
                  range: Record<string, unknown>,
                  labels: Record<string, unknown>,
                ) => {
                  calls.renders += 1;
                  captures.push({ range, labels });
                  return {
                    destroy: () => {
                      calls.destroys += 1;
                    },
                    reflow: () => {
                      calls.reflows += 1;
                    },
                  };
                },
                renderRange: (
                  _host: unknown,
                  range: Record<string, unknown>,
                  labels: Record<string, unknown>,
                ) => {
                  calls.renders += 1;
                  captures.push({ range, labels });
                  return {
                    destroy: () => {
                      calls.destroys += 1;
                    },
                    reflow: () => {
                      calls.reflows += 1;
                    },
                  };
                },
              },
              {
                getFloatInstance: (options: { maxFractionDigits: number }) => ({
                  format: (value: number) =>
                    value.toFixed(options.maxFractionDigits),
                }),
              },
            );
          },
        },
      },
    },
  );
  return { host, calls, captures, makeControl, resize: () => resize() };
}

test("price ranges fit small unit prices and retain padding for coincident values", () => {
  preview.renderRange(
    {},
    {
      axisType: "linear",
      p10: 0.12,
      p50: 0.15,
      p90: 0.18,
      planned: 0.14,
      includeZero: false,
      minimumPadding: 0.01,
    },
  );
  assert.ok(rendered);
  assert.ok(rendered.xAxis.min! > 0.1);
  assert.ok(rendered.xAxis.max! < 0.2);
  assert.equal(
    rendered.series.find((series) => series.type === "xrange")?.data[0].x,
    0.12,
  );
  preview.renderRange(
    {},
    { axisType: "linear", p50: 0, includeZero: false, minimumPadding: 0.01 },
  );
  assert.equal(rendered.xAxis.min, 0);
  assert.equal(rendered.xAxis.max, 0.01);
});

test("price chart preserves raw monetary values, currency, historical reference, and zero estimates", () => {
  const fixture = rangeControlFixture();
  const control = fixture.makeControl({
    p10: 0,
    p50: 1.234567,
    p90: 2.456789,
    planned: 1.1,
    unit: "EUR / PC",
    valueDecimals: 2,
    chartTitle: "Expected purchase price",
    rangeTitle: "Expected price P10-P90",
    plannedLabel: "Historical reference",
  });
  control.onAfterRendering();
  const { range, labels } = fixture.captures[0];
  assert.equal(range.p10, 0);
  assert.equal(range.p50, 1.234567);
  assert.equal(range.p90, 2.456789);
  assert.equal(range.planned, 1.1);
  assert.equal(labels.sapPlanned, "Historical reference");
  assert.equal(
    (labels.value as (value: number) => string)(range.p50 as number),
    "1.23 EUR / PC",
  );
  assert.equal((labels.value as (value: number) => string)(0), "0.00 EUR / PC");
  assert.equal((labels.chanceBy as (level: number) => string)(50), "P50");
});

test("bound range control preserves inputs and reflows without rebuilding on resize", () => {
  const fixture = rangeControlFixture();
  const control = fixture.makeControl({
    p10: 0,
    p50: 12.5,
    p90: 24,
    planned: 14,
    unit: "days",
    labels: "Fast|Slow|Requested|Planned|Duration",
  });
  control.onAfterRendering();
  assert.equal(fixture.captures[0].range.p10, 0);
  assert.equal(fixture.captures[0].range.p50, 12.5);
  assert.equal(fixture.captures[0].range.planned, 14);
  assert.equal(fixture.captures[0].labels.chartTitle, "Duration");
  assert.equal(
    (fixture.captures[0].labels.chanceBy as (level: number) => string)(10),
    "P10 - Fast",
  );
  fixture.resize();
  fixture.resize();
  assert.equal(fixture.calls.renders, 1);
  assert.equal(fixture.calls.reflows, 2);
  control.onBeforeRendering();
  control.onAfterRendering();
  assert.equal(fixture.calls.renders, 2);
  assert.equal(fixture.calls.registrations, 1);
  control.exit();
  assert.equal(fixture.calls.destroys, 2);
  assert.equal(fixture.calls.deregistrations, 1);
});

test("Simulation reuses the bound range control and forwards local scenario selection", () => {
  const fixture = rangeControlFixture();
  const lanes = [
    { name: "Supplier", points: [{ quantile: 0.9, date: "2026-11-15" }] },
  ];
  const control = fixture.makeControl({
    lanes,
    selectedQuantile: 0.9,
    requested: "2026-11-14",
  });
  let selected = 0;
  Object.assign(control, {
    hasListeners: () => true,
    fireScenarioSelect: (event: { quantile: number }) => {
      selected = event.quantile;
    },
  });
  control.onAfterRendering();
  assert.equal(fixture.captures[0].range.rows, lanes);
  assert.equal(fixture.captures[0].range.selectedQuantile, 0.9);
  assert.equal(fixture.captures[0].range.needDate, "2026-11-14");
  (fixture.captures[0].labels.onSelect as (quantile: number) => void)(0.7);
  assert.equal(selected, 0.7);
  control.exit();
  assert.equal(fixture.calls.destroys, 1);
});

test("Simulation's live view contains arrival and price charts and retains existing tables", () => {
  const xml = readFileSync(
    "app/purchasing-desk/webapp/ext/planning/Planning.view.xml",
    "utf8",
  );
  assert.equal((xml.match(/<charts:RangeChart/g) || []).length, 2);
  assert.match(xml, /id="planPriceChart"/);
  assert.match(xml, /p50="\{plan>\/result\/priceP50\}"/);
  assert.match(xml, /planned="\{plan>\/result\/historicalPriceReference\}"/);
  assert.match(
    xml,
    /lanes="\{= \$\{plan>\/hasSupplierOptions\} \? \$\{plan>\/comparisonLanes\} : \$\{plan>\/singleLanes\} \}"/,
  );
  assert.doesNotMatch(
    xml,
    /planSupplierArrivalChart|planPanelMaster|planSupplierPricePanel/,
  );
  assert.match(
    xml,
    /id="planSupplierPrices" visible="\{plan>\/hasSupplierOptions\}"/,
  );
  assert.match(
    xml,
    /lanes="\{= \$\{plan>\/hasSupplierOptions\} \? \$\{plan>\/comparisonPriceLanes\} : \$\{plan>\/singlePriceLanes\} \}"/,
  );
  assert.match(xml, /scenarioSelect="\.onChartScenarioSelect"/);
  assert.match(xml, /id="planLevelTable"/);
  assert.match(xml, /id="planSupplierComparisonTable"/);
  assert.doesNotMatch(xml, /GanttHost|hasSingleGantt|hasComparisonGantt/);
});

test("numeric supplier lanes retain prices and missing estimates on a shared price axis", () => {
  preview.renderLanes(
    {},
    {
      axisType: "linear",
      selectedQuantile: 0.5,
      rows: [
        {
          name: "Supplier A - EUR / PC",
          points: [
            { quantile: 0.1, value: 0 },
            { quantile: 0.5, value: 0.02 },
            { quantile: 0.9, value: 0.04 },
          ],
        },
        {
          name: "Supplier B - EUR / PC",
          points: [
            { quantile: 0.1, value: 0.01 },
            { quantile: 0.5, value: 0.03 },
            { quantile: 0.9, value: 0.05 },
          ],
        },
        { name: "Supplier C", points: [] },
      ],
    },
  );
  assert.ok(rendered);
  assert.equal(rendered.xAxis.type, "linear");
  assert.equal(rendered.series[0].data[0].x, 0);
  assert.equal(rendered.series[0].data[0].x2, 0.04);
  assert.equal(rendered.series[0].data.length, 2);
  assert.equal(rendered.series[1].data.length, 6);
  assert.equal(rendered.yAxis.categories.length, 3);
  assert.ok((rendered.xAxis.max ?? 0) < 1);
});

test("Simulation controller preserves every scenario and selects markers without service access", () => {
  type Controller = {
    _priceLanes: (options: Record<string, unknown>[]) => unknown[];
    _updateSingleChart: (
      this: unknown,
      result: Record<string, unknown>,
    ) => void;
    onChartScenarioSelect: (
      this: unknown,
      event: { getParameter: (name: string) => number },
    ) => void;
  };
  let controller: Controller | undefined;
  const source = readFileSync(
    "app/purchasing-desk/webapp/ext/planning/Planning.controller.js",
    "utf8",
  );
  assert.doesNotMatch(source, /Gantt|gantt/);
  runInNewContext(source, {
    sap: {
      ui: {
        define: (
          dependencies: string[],
          factory: (...modules: unknown[]) => Controller,
        ) => {
          controller = factory(
            ...dependencies.map((dependency) => {
              if (dependency === "sap/fe/core/PageController")
                return {
                  extend: (_name: string, definition: Controller) => definition,
                };
              if (dependency === "sap/ui/core/format/DateFormat")
                return {
                  getDateInstance: () => ({
                    format: (value: Date) => value.toISOString(),
                  }),
                };
              if (dependency === "sap/ui/core/format/NumberFormat")
                return { getFloatInstance: () => ({ format: String }) };
              if (dependency === "sap/ui/core/library")
                return { InvisibleMessageMode: {} };
              return {};
            }),
          );
        },
      },
    },
  });
  assert.ok(controller);
  const properties = new Map<string, unknown>();
  const rows = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map(
    (quantile) => ({
      quantile,
      earliestDelivery: "2026-11-15",
    }),
  );
  controller._updateSingleChart.call(
    {
      _priceLanes: controller._priceLanes,
      _model: {
        setProperty: (path: string, value: unknown) =>
          properties.set(path, value),
      },
    },
    {
      Supplier: "123",
      SupplierName: "Example",
      rows,
    },
  );
  const lanes = properties.get("/singleLanes") as Array<{
    name: string;
    points: unknown[];
  }>;
  assert.equal(lanes[0].name, "Example (123)");
  assert.equal(lanes[0].points.length, 9);
  assert.equal(properties.get("/hasSingleChart"), true);
  const selected: number[] = [];
  controller.onChartScenarioSelect.call(
    { _select: (index: number) => selected.push(index) },
    { getParameter: () => 0.7 },
  );
  controller.onChartScenarioSelect.call(
    { _select: (index: number) => selected.push(index) },
    { getParameter: () => 0.123 },
  );
  assert.deepEqual(selected, [4]);
});

test("hidden and empty range controls do not create blank charts", () => {
  const hidden = rangeControlFixture(0);
  const control = hidden.makeControl({ p10: 1, p50: 2, p90: 3 });
  control.onAfterRendering();
  assert.equal(hidden.calls.renders, 0);
  hidden.host.clientWidth = 390;
  hidden.resize();
  assert.equal(hidden.calls.renders, 1);
  control.exit();
  const empty = rangeControlFixture();
  empty.makeControl({}).onAfterRendering();
  assert.equal(empty.calls.renders, 0);
});

test("simulation lanes preserve P50-P90 spans, missing suppliers, and selected scenarios", () => {
  preview.renderLanes(
    {},
    {
      asOf: "2026-10-03",
      needDate: "2026-10-20",
      selectedQuantile: 0.7,
      rows: [
        {
          name: "Supplier A",
          points: [
            { quantile: 0.5, date: "2026-10-10" },
            { quantile: 0.7, date: "2026-10-14" },
            { quantile: 0.8, date: "2026-10-21" },
            { quantile: 0.9, date: "2026-10-24" },
          ],
        },
        { name: "Supplier B", points: [] },
      ],
    },
  );
  assert.ok(rendered);
  assert.equal(
    JSON.stringify(rendered.yAxis.categories),
    '["Supplier A","Supplier B"]',
  );
  const interval = rendered.series.find((series) => series.type === "xrange");
  assert.equal(interval?.data.length, 1);
  assert.equal(interval?.data[0].x, Date.parse("2026-10-10T00:00:00Z"));
  assert.equal(interval?.data[0].x2, Date.parse("2026-10-24T00:00:00Z"));
  const points =
    rendered.series.find((series) => series.type === "scatter")?.data || [];
  assert.equal(points.length, 4);
  assert.equal(points.filter((point) => point.custom?.emphasized).length, 1);
  assert.equal(points.find((point) => point.custom?.emphasized)?.name, "P70");
  assert.match(rendered.accessibility.description, /Supplier B: No estimate/);
  assert.match(rendered.accessibility.description, /P80.*After need date/);
  assert.doesNotMatch(
    rendered.accessibility.description,
    /P10|chance|guarantee/,
  );
});

test("simulation includes the larger P95 estimate and extends its range without inventing P99", () => {
  preview.renderLanes(
    {},
    {
      needDate: "2026-10-05",
      rows: [
        {
          name: "Supplier",
          points: [
            { quantile: 0.5, date: "2026-10-14" },
            { quantile: 0.8, date: "2026-10-18" },
            { quantile: 0.9, date: "2026-10-22" },
            { quantile: 0.95, date: "2026-10-29" },
          ],
        },
      ],
    },
  );
  assert.ok(rendered);
  assert.equal(rendered.series[0].data[0].x2, Date.parse("2026-10-29"));
  assert.deepEqual(
    Array.from(rendered.series[1].data, (point) => point.name),
    ["P50", "P80", "P90", "P95"],
  );
  assert.match(rendered.accessibility.description, /P95/);
  assert.doesNotMatch(rendered.accessibility.description, /P99/);
});

test("simulation intervals reject reversed and invalid date ranges", () => {
  preview.renderLanes(
    {},
    {
      rows: [
        {
          name: "Supplier",
          points: [
            { quantile: 0.5, date: "2026-10-24" },
            { quantile: 0.8, date: "2026-02-30" },
            { quantile: 0.9, date: "2026-10-10" },
          ],
        },
      ],
    },
  );
  assert.ok(rendered);
  assert.equal(
    rendered.series.find((series) => series.type === "xrange")?.data.length,
    0,
  );
  assert.equal(
    rendered.series.find((series) => series.type === "scatter")?.data.length,
    2,
  );
});

test("duration ranges keep numeric days, zero quantiles and source-neutral captions", () => {
  preview.renderRange(
    {},
    {
      axisType: "linear",
      p10: 0,
      p50: 12.5,
      p80: 18,
      p90: 24,
      requested: 10,
      planned: 14,
      today: "2026-10-03",
    },
  );
  assert.ok(rendered);
  assert.equal(rendered.xAxis.type, "linear");
  assert.equal(rendered.xAxis.plotLines.length, 0);
  const interval = rendered.series.find((series) => series.type === "xrange");
  assert.equal(interval?.data[0].x, 0);
  assert.equal(interval?.data[0].x2, 24);
  const quantiles = rendered.series.find((series) => series.type === "scatter");
  assert.equal(
    JSON.stringify(quantiles?.data.map((point) => point.x)),
    "[0,12.5,18,24]",
  );
  assert.match(rendered.accessibility.description, /P50: 12.5 days/);
  assert.doesNotMatch(rendered.accessibility.description, /AI|chance by/);
});

test("date ranges preserve source dates and reject invalid or missing duration values", () => {
  preview.renderRange(
    {},
    {
      ordered: new Date("2026-10-01T00:00:00Z"),
      requested: "2026-10-12",
      planned: 6,
      p10: "2026-10-08",
      p50: "2026-10-11",
      p90: "2026-10-19",
      today: "2026-10-03",
    },
  );
  assert.ok(rendered);
  assert.equal(rendered.xAxis.type, "datetime");
  assert.equal(
    rendered.series.find((series) => series.type === "xrange")?.data[0].x,
    Date.parse("2026-10-08T00:00:00Z"),
  );
  assert.equal(
    rendered.xAxis.plotLines[0].value,
    Date.parse("2026-10-03T00:00:00Z"),
  );
  for (const missing of [null, undefined, "", " ", NaN, Infinity, -1, false]) {
    preview.renderRange(
      {},
      {
        axisType: "linear",
        p10: missing,
        p50: missing,
        p90: 20,
        planned: missing,
      },
    );
    assert.ok(rendered);
    assert.equal(
      rendered.series.find((series) => series.type === "xrange")?.data.length,
      0,
    );
    assert.equal(
      JSON.stringify(
        rendered.series
          .find((series) => series.type === "scatter")
          ?.data.map((point) => point.name),
      ),
      '["P90"]',
    );
    assert.equal(
      rendered.series.filter((series) => series.type === "scatter")[1].data
        .length,
      0,
    );
  }
});

test("Highcharts preview uses separate reference rows and a thin forecast-only interval", () => {
  preview.render(
    {},
    {
      forecastKind: "tabpfn",
      markers: [{ kind: "ordered", date: "2026-10-04" }],
      requiredDate: "2026-10-05",
      plannedDays: 3,
      asOf: "2026-10-05",
      earliestCredibleDate: "2026-10-13",
      mostLikelyDate: "2026-10-17",
      lateRiskDate: "2026-11-06",
      scenarios: [
        { level: 50, arrivalDate: "2026-10-17" },
        { level: 80, arrivalDate: "2026-10-24" },
        { level: 90, arrivalDate: "2026-11-06" },
      ],
    },
    {
      description: "Delivery forecast",
      forecast: "Forecast quantiles",
      referenceDates: "Reference dates",
      predictionWindow: "Prediction window",
      likelyWindow: "Likely window",
      quantiles: "Quantiles",
      purchaseOrder: "Purchase order",
      requestedDate: "Requested date",
      sapPlanned: "SAP planned",
      today: "Today",
    },
  );

  assert.ok(rendered);
  assert.equal(
    JSON.stringify(
      rendered.series
        .filter((series) => series.type === "scatter")
        .map((series) => series.data.map((point) => point.y)),
    ),
    "[[3,3,3,3],[0,1,2]]",
  );
  assert.equal(rendered.yAxis.reversed, true);
  assert.equal(
    JSON.stringify(rendered.yAxis.categories),
    '["Purchase order","Requested date","SAP planned","Prediction window"]',
  );
  assert.equal(rendered.xAxis.plotBands, undefined);
  assert.equal(
    rendered.xAxis.plotLines[0].value,
    Date.parse("2026-10-05T00:00:00Z"),
  );
  const range = rendered.series.find((series) => series.type === "xrange");
  assert.ok(range);
  assert.equal(range.pointWidth, 12);
  assert.equal(range.data[0].x, Date.parse("2026-10-13T00:00:00Z"));
  assert.equal(range.data[0].x2, Date.parse("2026-11-06T00:00:00Z"));
  assert.equal(range.data[0].y, 3);
  assert.equal(
    JSON.stringify(
      rendered.series
        .filter((series) => series.type === "line")
        .map((series) => series.data.map((point) => point.y)),
    ),
    "[[0,3],[1,3],[2,3]]",
  );
});

test("invalid dates, missing durations and reversed intervals do not invent markers", () => {
  for (const plannedDays of [null, "", -1, NaN, Infinity, 1e100]) {
    preview.render(
      {},
      {
        forecastKind: "tabpfn",
        markers: [{ kind: "ordered", date: "2026-10-04" }],
        requiredDate: "2026-02-30",
        plannedDays,
        today: "invalid",
        earliestCredibleDate: "2026-11-06",
        lateRiskDate: "2026-10-13",
      },
      { purchaseOrder: "Purchase order", predictionWindow: "Forecast window" },
    );
    assert.ok(rendered);
    assert.equal(
      rendered.series.find((series) => series.type === "xrange")?.data.length,
      0,
    );
    assert.equal(
      rendered.series.filter((series) => series.type === "scatter")[1].data
        .length,
      1,
    );
    assert.equal(rendered.xAxis.plotLines.length, 0);
  }
});

test("non-AI arrivals retain their source label instead of claiming quantile probabilities", () => {
  preview.render(
    {},
    {
      forecastKind: "confirmation",
      mostLikelyDate: "2026-10-17",
      earliestCredibleDate: "2026-10-13",
      lateRiskDate: "2026-11-06",
    },
    {
      supplierConfirmed: "Supplier confirmed",
      arrivalWindow: "Arrival window",
    },
  );
  assert.ok(rendered);
  const forecast = rendered.series.find((series) => series.type === "scatter");
  assert.equal(forecast?.data.length, 1);
  assert.equal(forecast?.data[0].name, "Supplier confirmed");
  assert.doesNotMatch(
    rendered.accessibility.description,
    /chance by|P10|P50|P90/,
  );
});

test("coincident quantiles keep their dates and only the median receives emphasis", () => {
  preview.render(
    {},
    {
      forecastKind: "tabpfn",
      mostLikelyDate: "2026-10-17",
      earliestCredibleDate: "2026-10-17",
      lateRiskDate: "2026-10-17",
      scenarios: [{ level: 80, arrivalDate: "2026-10-17" }],
    },
    { predictionWindow: "Forecast window" },
  );
  assert.ok(rendered);
  const forecast = rendered.series.find((series) => series.type === "scatter");
  assert.equal(
    JSON.stringify(forecast?.data.map((point) => point.marker?.radius)),
    "[4,7,4,4]",
  );
  assert.equal(new Set(forecast?.data.map((point) => point.x)).size, 1);
});

test("crowded quantile captions stack below the bar and increase the chart height", async () => {
  preview.render({}, { forecastKind: "tabpfn" }, {});
  assert.ok(rendered);
  const positions: Array<{ x: number; y: number; opacity: number }> = [];
  const points = Array.from({ length: 4 }, () => ({
    plotX: 80,
    plotY: 200,
    dataLabel: {
      css: () => {},
      getBBox: () => ({ width: 150, height: 36 }),
      attr: (position: { x: number; y: number; opacity: number }) => {
        positions.push(position);
      },
    },
  }));
  let updated: { chart: { height: number; marginBottom: number } } | undefined;
  const path = { attr: () => path, add: () => path };
  const chart = {
    get: () => ({ points }),
    plotWidth: 160,
    plotHeight: 224,
    plotLeft: 120,
    plotTop: 40,
    options: { chart: { marginBottom: 100 } },
    renderer: { path: () => path },
    update: (options: typeof updated) => {
      updated = options;
    },
  };
  rendered.chart.events.render.call(chart);
  await Promise.resolve();
  assert.equal(positions.length, 4);
  assert.equal(new Set(positions.map((position) => position.y)).size, 4);
  assert.ok(
    positions.every(
      (position) =>
        position.x >= 0 &&
        position.x + 150 <= 160 &&
        position.y > 200 &&
        position.opacity === 1,
    ),
  );
  assert.ok(points.every((point) => point.plotX === 80 && point.plotY === 200));
  assert.ok(updated && updated.chart.marginBottom > 100);
});

test("production captions put the arrival date first and distinguish the median", () => {
  preview.render(
    {},
    {
      forecastKind: "tabpfn",
      earliestCredibleDate: "2026-10-13",
      mostLikelyDate: "2026-10-17",
      lateRiskDate: "2026-11-06",
      scenarios: [{ level: 80, arrivalDate: "2026-10-24" }],
    },
    { predictionWindow: "AI forecast window" },
  );
  assert.ok(rendered);
  const forecast = rendered.series.find((series) => series.type === "scatter");
  assert.ok(forecast?.dataLabels?.formatter);
  const median = forecast.data[1];
  const caption = forecast.dataLabels.formatter.call(median);
  assert.ok(
    caption.indexOf("2026-10-17") < caption.indexOf("P50 - 50% chance by"),
  );
  assert.match(caption, /font-size:16px/);
  assert.equal(median.marker?.fillColor, "#5b3fc4");
  assert.equal(forecast.data[0].marker?.fillColor, "#ffffff");
  assert.equal(median.marker?.lineWidth, 2);
});
