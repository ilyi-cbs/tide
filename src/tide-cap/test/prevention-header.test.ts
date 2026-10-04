import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const WEBAPP = path.join(__dirname, "..", "app", "purchasing-desk", "webapp");
const KEYS = ["price", "duplicates", "unusual", "supplier", "material"];

function setup() {
  let definition: any;
  let response: Record<string, unknown> = Object.fromEntries(
    KEYS.map((key) => [key, 6123]),
  );
  let failed = false;
  let invoked = 0;
  class JSONModel {
    constructor(public data: any) {}
    setProperty(key: string, value: any) {
      this.data[key.slice(1)] = value;
    }
    getProperty(key: string) {
      return key
        .slice(1)
        .split("/")
        .reduce((value: any, segment: string) => value[segment], this.data);
    }
  }
  const model = {
    bindContext: (path: string) => {
      assert.equal(path, "/PurchasingDeskService.preventionSummary(...)");
      return {
        invoke: async () => {
          invoked += 1;
          if (failed) throw new Error("offline");
        },
        getBoundContext: () => ({ requestObject: async () => response }),
      };
    },
  };
  let presentation: JSONModel;
  const location = { hash: "" };
  const navigation = require(path.join(WEBAPP, "ext/CaseNavigation.js"));
  const view = {
    getModel: (name?: string) => (name === "prevention" ? presentation : model),
    setModel: (value: JSONModel, name: string) => {
      assert.equal(name, "prevention");
      presentation = value;
    },
  };
  vm.runInNewContext(
    readFileSync(
      path.join(WEBAPP, "ext/prevention/PreventionHeader.controller.js"),
      "utf8",
    ),
    {
      window: { location },
      sap: {
        ui: {
          define: (_dependencies: string[], factory: Function) => {
            definition = factory(
              {
                extend: (_name: string, implementation: any) => implementation,
              },
              JSONModel,
              navigation,
            );
          },
        },
      },
    },
  );
  const controller = { ...definition, base: { getView: () => view } };
  definition.override.onInit.call(controller);
  return {
    controller,
    data: () => presentation.data,
    setResponse: (value: Record<string, unknown>) => {
      response = value;
    },
    fail: (value: boolean) => {
      failed = value;
    },
    calls: () => invoked,
    start: () => definition.override.onBeforeRendering.call(controller),
    exit: () => definition.override.onExit.call(controller),
    navigate: (bindingContext: any) =>
      definition.override.routing.onBeforeNavigation.call(controller, {
        bindingContext,
      }),
    hash: () => location.hash,
  };
}

test("planned-time rows use native navigation and route both record types to their typed pages", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(WEBAPP, "manifest.json"), "utf8"),
  );
  assert.ok(
    manifest["sap.ui5"].routing.targets.PreventionList.options.settings
      .navigation.PlannedTimes.detail.route,
  );
  for (const [kind, id, entity] of [
    ["supplier_planned_time", "pdt:M|S|P", "SupplierPlannedTimes"],
    ["material_planned_time", "mm_pdt:M|P", "MaterialPlannedTimes"],
  ]) {
    const fixture = setup();
    assert.equal(
      fixture.navigate({
        getPath: () => "/PlannedTimes('case')",
        getObject: () => ({ caseID: id, caseKind: kind }),
      }),
      true,
    );
    assert.ok(fixture.hash().startsWith("#" + entity + "("));
    assert.ok(fixture.hash().includes("%253A"));
  }
  const fixture = setup();
  assert.equal(
    fixture.navigate({ getPath: () => "/PriceDeviations('case')" }),
    false,
  );
  assert.equal(fixture.hash(), "");
});

test("PreventionList registers the summary controller without replacing other extensions", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(WEBAPP, "manifest.json"), "utf8"),
  );
  const extensions =
    manifest["sap.ui5"].extends.extensions["sap.ui.controllerExtensions"];
  assert.equal(
    extensions[
      "sap.fe.templates.ListReport.ListReportController#tide.cockpit::PreventionList"
    ].controllerName,
    "tide.cockpit.ext.prevention.PreventionHeader",
  );
  assert.ok(
    extensions[
      "sap.fe.templates.ListReport.ListReportController#tide.cockpit::DeliveryRisksList"
    ],
  );
  assert.ok(
    extensions[
      "sap.fe.templates.ObjectPage.ObjectPageController#tide.cockpit::RequestsReviewObjectPage"
    ],
  );
});

test("summary starts unknown and sets all five exact backend totals atomically", async () => {
  const fixture = setup();
  assert.equal(fixture.data().price.count, null);
  await fixture.controller.refresh();
  assert.equal(fixture.calls(), 1);
  for (const key of KEYS) {
    assert.equal(fixture.data()[key].count, 6123);
    assert.equal(fixture.data()[key].status, "current");
  }
  fixture.setResponse(Object.fromEntries(KEYS.map((key) => [key, 0])));
  await fixture.controller.refresh();
  for (const key of KEYS) assert.equal(fixture.data()[key].count, 0);
});

test("an invalid or failed summary preserves previous values as stale", async () => {
  const fixture = setup();
  await fixture.controller.refresh();
  fixture.setResponse({
    price: 1,
    duplicates: 1,
    unusual: 1,
    supplier: 1,
    material: -1,
  });
  await fixture.controller.refresh();
  for (const key of KEYS) {
    assert.equal(fixture.data()[key].count, 6123);
    assert.equal(fixture.data()[key].status, "stale");
  }
  const unavailable = setup();
  unavailable.fail(true);
  await unavailable.controller.refresh();
  for (const key of KEYS)
    assert.equal(unavailable.data()[key].status, "unavailable");
});

test("summary is loaded once when the list renders and never updates after exit", async () => {
  const fixture = setup();
  fixture.start();
  fixture.start();
  await fixture.controller._pending;
  assert.equal(fixture.calls(), 1);
  fixture.exit();
  await fixture.controller.refresh();
  assert.equal(fixture.calls(), 1);
});
