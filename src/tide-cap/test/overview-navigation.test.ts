import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const WEBAPP = path.join(
  __dirname,
  "..",
  "app",
  "purchasing-desk",
  "webapp",
  "ext",
);

function loadRefreshController(relativePath: string) {
  let controller: any;
  vm.runInNewContext(readFileSync(path.join(WEBAPP, relativePath), "utf8"), {
    clearInterval: () => {},
    clearTimeout: () => {},
    sap: {
      ui: {
        define: (dependencies: string[], factory: Function) => {
          controller = factory(
            ...dependencies.map((name) => {
              if (
                name === "sap/fe/core/PageController" ||
                name === "sap/ui/core/mvc/ControllerExtension"
              )
                return {
                  extend: (_name: string, definition: unknown) => definition,
                };
              if (name.endsWith("/NumberFormat"))
                return { getFloatInstance: () => ({ format: String }) };
              return {};
            }),
          );
        },
      },
    },
  });
  return controller;
}

for (const [name, relativePath, expectedPaths] of [
  [
    "Morning Brief",
    "overview/Overview.controller.js",
    ["/overview(...)", "/me(...)"],
  ],
  ["hub", "finding/FindingsHub.controller.js", ["/overview(...)"]],
] as const) {
  for (const failed of [false, true]) {
    test(`${name} disposes refresh bindings after ${failed ? "failure" : "success"}`, async () => {
      const controller = loadRefreshController(relativePath);
      const requested: string[] = [];
      const destroyed: string[] = [];
      const values = new Map<string, unknown>();
      const serviceModel = {
        bindContext: (bindingPath: string) => {
          requested.push(bindingPath);
          return {
            invoke: async () => {},
            getBoundContext: () => ({
              requestObject: async () => {
                if (failed) throw new Error("Refresh unavailable");
                return { kpis: { atRisk: 7 }, userId: "buyerD01" };
              },
            }),
            destroy: () => destroyed.push(bindingPath),
          };
        },
      };
      const view = {
        getModel: (modelName?: string) =>
          modelName === "ov" || modelName === "hub"
            ? {
                setProperty: (key: string, value: unknown) =>
                  values.set(key, value),
              }
            : serviceModel,
        getDomRef: () => null,
      };
      const context = {
        ...controller,
        getView: () => view,
        base: { getView: () => view },
        _bundle: async () => ({}),
        _apply: (overview: unknown, me: unknown) => {
          values.set("overview", overview);
          values.set("me", me);
        },
      };

      await context.refresh();

      assert.deepEqual(requested, expectedPaths);
      assert.deepEqual([...destroyed].sort(), [...expectedPaths].sort());
      assert.equal(context._busy, false);
      if (!failed && name === "Morning Brief") {
        assert.equal((values.get("overview") as any).kpis.atRisk, 7);
        assert.equal((values.get("me") as any).userId, "buyerD01");
      } else if (!failed) assert.equal(values.get("/atRisk"), 7);
      else if (name === "Morning Brief")
        assert.equal(values.get("/refreshFailed"), true);
      else assert.equal(values.size, 0);
    });
  }

  for (const failed of [false, true]) {
    test(`${name} ignores a pending refresh ${failed ? "failure" : "success"} after exit`, async () => {
      const controller = loadRefreshController(relativePath);
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const requested: string[] = [];
      const destroyed: string[] = [];
      let viewAccesses = 0;
      let applied = 0;
      const serviceModel = {
        bindContext: (bindingPath: string) => {
          requested.push(bindingPath);
          return {
            invoke: () => promise,
            getBoundContext: () => ({ requestObject: async () => ({}) }),
            destroy: () => destroyed.push(bindingPath),
          };
        },
      };
      const view = {
        getModel: (modelName?: string) =>
          modelName === "ov" || modelName === "hub"
            ? { setProperty: () => applied++ }
            : serviceModel,
        getDomRef: () => null,
      };
      const getView = () => {
        viewAccesses++;
        return view;
      };
      const context = {
        ...controller,
        getView,
        base: { getView },
        _bundle: async () => ({}),
        _apply: () => applied++,
      };
      const refresh = context.refresh();
      const accessesBeforeExit = viewAccesses;
      (controller.override?.onExit || controller.onExit).call(context);
      if (failed) reject(new Error("Refresh unavailable"));
      else resolve();
      await refresh;
      await context.refresh();

      assert.equal(applied, 0);
      assert.equal(viewAccesses, accessesBeforeExit);
      assert.deepEqual(requested, expectedPaths);
      assert.deepEqual([...destroyed].sort(), [...expectedPaths].sort());
      assert.equal(context._busy, false);
    });
  }
}

test("Morning Brief preserves an unfinished identity read when the overview fails", async () => {
  const controller = loadRefreshController("overview/Overview.controller.js");
  const overview = Promise.withResolvers<object>();
  const identity = Promise.withResolvers<object>();
  const destroyed: string[] = [];
  const values = new Map<string, unknown>();
  const serviceModel = {
    bindContext: (bindingPath: string) => ({
      invoke: async () => {},
      getBoundContext: () => ({
        requestObject: () =>
          bindingPath === "/overview(...)"
            ? overview.promise
            : identity.promise,
      }),
      destroy: () => destroyed.push(bindingPath),
    }),
  };
  const view = {
    getModel: (modelName?: string) =>
      modelName === "ov"
        ? {
            setProperty: (key: string, value: unknown) =>
              values.set(key, value),
          }
        : serviceModel,
    getDomRef: () => null,
  };
  const context = {
    ...controller,
    getView: () => view,
    _apply: () => assert.fail("A failed overview must not be displayed"),
  };
  const refresh = context.refresh();
  overview.reject(new Error("Overview unavailable"));
  await refresh;

  assert.deepEqual([...destroyed].sort(), ["/overview(...)"]);
  assert.equal(values.get("/refreshFailed"), true);
  assert.equal(context._busy, false);
  identity.resolve({ userId: "buyerD01" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...destroyed].sort(), ["/me(...)", "/overview(...)"]);
});

test("Morning Brief has one DynamicPage content control containing loading and body", async () => {
  const { parseStringPromise } = require("xml2js");
  const view = await parseStringPromise(
    readFileSync(path.join(WEBAPP, "overview/Overview.view.xml"), "utf8"),
  );
  const content = view["mvc:View"]["f:DynamicPage"][0]["f:content"][0];
  assert.deepEqual(Object.keys(content), ["VBox"]);
  assert.equal(content.VBox.length, 1);
  assert.equal(content.VBox[0].$.id, "overviewContainer");
  assert.deepEqual(
    content.VBox[0].VBox.map((control: any) => control.$.id),
    ["overviewLoading", "overviewBody"],
  );
});

test("Morning Brief displays the authenticated identity rather than a demo user", () => {
  let controller: any;
  const values = new Map<string, unknown>();
  const format = { format: String };
  vm.runInNewContext(
    readFileSync(path.join(WEBAPP, "overview/Overview.controller.js"), "utf8"),
    {
      sap: {
        ui: {
          define: (dependencies: string[], factory: Function) => {
            controller = factory(
              ...dependencies.map((name) => {
                if (name === "sap/fe/core/PageController")
                  return {
                    extend: (_name: string, definition: unknown) => definition,
                  };
                if (name.endsWith("/NumberFormat"))
                  return { getFloatInstance: () => format };
                if (name.endsWith("/DateFormat"))
                  return {
                    getDateInstance: () => format,
                    getDateTimeInstance: () => format,
                  };
                return {};
              }),
            );
          },
        },
      },
    },
  );
  const context = {
    getView: () => ({
      getModel: () => ({
        setProperty: (key: string, value: unknown) => values.set(key, value),
      }),
    }),
  };
  for (const me of [
    { userId: "buyerD01", name: "Buyer D01" },
    { userId: "buyerD07" },
    {},
  ]) {
    controller._apply.call(context, {}, me, { getText: String });
    const header = values.get("/header") as {
      userName: string;
      userId: string;
    };
    assert.equal(
      header.userName,
      "name" in me ? me.name : "userId" in me ? me.userId : "",
    );
    assert.equal(header.userId, "userId" in me ? me.userId : "");
  }
  const view = readFileSync(
    path.join(WEBAPP, "overview/Overview.view.xml"),
    "utf8",
  );
  assert.match(
    view,
    /id="briefUser" text="\{ov>\/header\/userName\}".*tooltip="\{ov>\/header\/userId\}"/,
  );
  assert.doesNotMatch(view, /ilyesse\.hettenbach/);
});

test("priority trend preserves date spacing, original totals and local visibility across refreshes", () => {
  let chart: any;
  const modules: Record<string, any> = {
    "sap/ui/core/Control": { extend: () => function () {} },
    "sap/ui/core/theming/Parameters": { get: () => ({}) },
    "sap/ui/core/format/DateFormat": {
      getDateInstance: () => ({
        format: (date: Date) => date.toISOString().slice(0, 10),
      }),
    },
  };
  vm.runInNewContext(
    readFileSync(path.join(WEBAPP, "overview/PriorityTrendChart.js"), "utf8"),
    {
      sap: {
        ui: {
          define: (dependencies: string[], factory: Function) => {
            chart = factory(...dependencies.map((name) => modules[name] || {}));
          },
        },
      },
    },
  );
  const visibility = {};
  const labels = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    total: "Total",
  };
  const rows = [
    { day: "2026-10-03", critical: 1, high: 2, medium: 3, low: 4, total: 10 },
    { day: "2026-10-01", critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    { day: "2026-02-30", critical: 1, high: 0, medium: 0, low: 0, total: 1 },
  ];
  const options = chart.options(
    rows,
    visibility,
    labels,
    "Priorities",
    "2026-10-03",
  );
  assert.equal(options.xAxis.type, "datetime");
  assert.equal(options.plotOptions.column.stacking, "normal");
  assert.equal(options.series[0].data.length, 2);
  assert.equal(options.series[0].data[0].y, 0);
  assert.equal(
    options.series[0].data[1].x - options.series[0].data[0].x,
    2 * 86400000,
  );
  options.series[1].events.hide();
  const refreshed = chart.options(
    rows,
    visibility,
    labels,
    "Priorities",
    "2026-10-03",
  );
  assert.equal(refreshed.series[1].visible, false);
  const point = refreshed.series[0].data[1];
  const tooltip = refreshed.tooltip.formatter.call({
    x: point.x,
    points: [{ point }],
  });
  assert.match(tooltip, /High: 2/);
  assert.match(tooltip, /Total: 10/);
  refreshed.series[1].events.show();
  assert.equal(
    chart.options(rows, visibility, labels, "Priorities", "2026-10-03")
      .series[1].visible,
    true,
  );
});

function loadUi5Module<T>(relativePath: string): T {
  let exported: T | undefined;
  vm.runInNewContext(readFileSync(path.join(WEBAPP, relativePath), "utf8"), {
    sap: {
      ui: {
        define: (dependencies: string[], factory: (...args: any[]) => T) => {
          exported = factory(
            ...dependencies.map((name) =>
              loadUi5Module(name.replace("tide/cockpit/ext/", "") + ".js"),
            ),
          );
        },
      },
    },
  });
  if (!exported) throw new Error(`Module ${relativePath} did not export`);
  return exported;
}

test("Morning Brief tile navigation opens the intended worklist tab", () => {
  const openList = loadUi5Module<
    (router: { navTo: Function }, list: string) => void
  >("overview/openList.js");
  const calls: Array<[string, unknown]> = [];
  const router = {
    navTo: (route: string, parameters: unknown) =>
      calls.push([route, parameters]),
  };

  for (const [list, route, tab] of [
    ["at_risk", "DeliveryRisksList", "actionRequired"],
    ["delivery_risks", "DeliveryRisksList", "actionRequired"],
    ["overdue", "DeliveryRisksList", "actionRequired"],
    ["freetext", "RequestsList", "toReview"],
    ["prevention", "PreventionList", "price"],
    ["pdt", "PreventionList", "supplierPlannedTime"],
    ["mm_pdt", "PreventionList", "materialMasterPlannedTime"],
  ])
    openList(router, list);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["DeliveryRisksList", { "?query": { tab: "actionRequired" } }],
    ["DeliveryRisksList", { "?query": { tab: "actionRequired" } }],
    ["DeliveryRisksList", { "?query": { tab: "actionRequired" } }],
    ["RequestsList", { "?query": { tab: "toReview" } }],
    ["PreventionList", { "?query": { tab: "price" } }],
    ["PreventionList", { "?query": { tab: "supplierPlannedTime" } }],
    ["PreventionList", { "?query": { tab: "materialMasterPlannedTime" } }],
  ]);
});

test("case attention maps exhaustively to the four shared UI states", () => {
  const attention = loadUi5Module<{
    bucket: (attention: string) => string;
    state: (attention: string) => string;
    icon: (attention: string) => string;
    text: (
      attention: string,
      action: string,
      progress: string,
      waiting: string,
      done: string,
    ) => string;
    states: Record<string, readonly string[]>;
  }>("shared/Attention.js");
  const expected = {
    needs_attention: ["actionRequired", "Warning", "sap-icon://alert"],
    source_changed: ["actionRequired", "Warning", "sap-icon://alert"],
    needs_review: ["actionRequired", "Warning", "sap-icon://alert"],
    follow_up_overdue: ["actionRequired", "Warning", "sap-icon://alert"],
    in_progress: ["inProgress", "Information", "sap-icon://status-in-process"],
    awaiting_decision: ["waiting", "Information", "sap-icon://pending"],
    waiting_external: ["waiting", "Information", "sap-icon://pending"],
    awaiting_source: ["waiting", "Information", "sap-icon://pending"],
    done: ["done", "Success", "sap-icon://status-positive"],
  } as const;

  assert.deepEqual(
    Object.keys(expected).sort(),
    Object.values(attention.states).flat().sort(),
    "every backend attention state must be classified exactly once",
  );
  for (const [attentionValue, [bucket, state, icon]] of Object.entries(
    expected,
  )) {
    assert.equal(attention.bucket(attentionValue), bucket, attentionValue);
    assert.equal(attention.state(attentionValue), state, attentionValue);
    assert.equal(attention.icon(attentionValue), icon, attentionValue);
    assert.equal(
      attention.text(
        attentionValue,
        "Action required",
        "In progress",
        "Waiting",
        "Done",
      ),
      {
        actionRequired: "Action required",
        inProgress: "In progress",
        waiting: "Waiting",
        done: "Done",
      }[bucket],
      attentionValue,
    );
  }
  assert.equal(attention.bucket("unrecognized"), "actionRequired");
});

test("Morning Brief priority rows resolve supported object pages and reject unknown prefixes", () => {
  const findingLink = loadUi5Module<{ findingHash: (id: string) => string }>(
    "findingLink.js",
  );
  assert.match(
    findingLink.findingHash("at_risk:4500000001/10"),
    /^#DeliveryRisks\('delivery%253A4500000001%252F10'\)$/,
  );
  assert.match(
    findingLink.findingHash("delivery:4500000001/10"),
    /^#DeliveryRisks\('delivery%253A4500000001%252F10'\)$/,
  );
  assert.match(
    findingLink.findingHash("pdt:M1|S1|P1"),
    /^#SupplierPlannedTimes\('/,
  );
  assert.match(
    findingLink.findingHash("mm_pdt:M1|P1"),
    /^#MaterialPlannedTimes\('/,
  );
  assert.match(
    findingLink.findingHash("freetext:1000000001/00010"),
    /^#PurchaseRequisitionReviews\(/,
  );
  const manifest = JSON.parse(
    readFileSync(path.join(WEBAPP, "../manifest.json"), "utf8"),
  );
  const patterns = manifest["sap.ui5"].routing.routes.map(
    (route: { pattern: string }) => route.pattern,
  );
  for (const id of [
    "delivery:4500000069/50",
    "at_risk:4500000001/10",
    "price:M1|S1|P1",
    "duplicate:M1|M2",
    "unusual_setting:M1|P1",
    "pdt:M1|S1|P1",
    "mm_pdt:M1|P1",
    "freetext:1000000001/00010",
  ]) {
    const hash = findingLink.findingHash(id);
    const entity = hash.slice(1, hash.indexOf("("));
    assert.ok(patterns.includes(entity + "({key}):?query:"), hash);
  }
  assert.equal(findingLink.findingHash("unknown:1"), "");
});
