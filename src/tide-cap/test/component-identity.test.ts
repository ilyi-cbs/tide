import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

async function component(
  hostname: string,
  search: string,
  hash = "",
  mockAuthentication = true,
) {
  let implementation: any;
  let destroyed = false;
  const attributes: Record<string, string> = {};
  const assistantListeners = new Map<string, Function>();
  let refreshes = 0;
  const assistant: any = {
    setAttribute: (key: string, value: string) => {
      attributes[key] = value;
    },
    addEventListener: (name: string, listener: Function) => {
      assistantListeners.set(name, listener);
    },
    removeEventListener: (name: string, listener: Function) => {
      if (assistantListeners.get(name) === listener) assistantListeners.delete(name);
    },
  };
  const app = {
    prototype: { init() {}, exit() {} },
    extend: (_name: string, value: any) => {
      implementation = value;
      return value;
    },
  };
  class ShellBar {
    addStyleClass() {
      return this;
    }
    placeAt() {}
    destroy() {
      destroyed = true;
    }
  }
  vm.runInNewContext(
    readFileSync(
      path.join(__dirname, "../app/purchasing-desk/webapp/Component.js"),
      "utf8",
    ),
    {
      sap: {
        ui: {
          define: (_deps: string[], factory: Function) =>
            factory(app, ShellBar, { initialize: () => {} }),
        },
      },
      document: { querySelector: () => assistant, getElementById: () => ({}) },
      window: { location: { hostname, search, hash }, history: { back() {} } },
      URL,
      URLSearchParams,
      btoa,
      fetch: async () => ({
        ok: true,
        json: async () => ({ userId: "buyerD01", mockAuthentication }),
      }),
    },
  );
  const routeListeners: Function[] = [];
  const router = {
    navTo() {},
    attachRouteMatched(listener: Function) {
      routeListeners.push(listener);
    },
    detachRouteMatched(listener: Function) {
      const index = routeListeners.indexOf(listener);
      if (index >= 0) routeListeners.splice(index, 1);
    },
  };
  const instance = {
    ...implementation,
    getRouter: () => router,
    getRootControl: () => ({
      byId: () => ({
        getCurrentPage: () => ({
          getComponentInstance: () => ({
            getRootControl: () => ({
              getController: () => ({
                getExtensionAPI: () => ({ refresh: () => refreshes++ }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
  instance.init();
  await new Promise((resolve) => setImmediate(resolve));
  return {
    assistant,
    attributes,
    exit: () => instance.exit(),
    destroyed: () => destroyed,
    refreshes: () => refreshes,
    assistantChanged: (summary: unknown) =>
      assistantListeners.get("tide:assistant-data-changed")?.({ detail: { ok: true, summary } }),
    hasAssistantListener: () => assistantListeners.has("tide:assistant-data-changed"),
    route: (name: string, key: string) => {
      routeListeners.forEach(listener => listener({
        getParameter: (parameter: string) => parameter === "name" ? name : { key },
      }));
    },
  };
}

test("assistant context preserves escaped OData keys across detail routes", async () => {
  const fixture = await component("localhost", "");
  const keys = [
    ["DeliveryRiskCaseObjectPage", "'delivery:O''Brien'", "case", "delivery:O'Brien"],
    ["PriceDeviationObjectPage", "'price:O''Brien'", "case", "price:O'Brien"],
  ];
  for (const [route, key, kind, id] of keys) {
    fixture.route(route, encodeURIComponent(encodeURIComponent(key)));
    const context = fixture.assistant.contextProvider.getContext();
    assert.equal(context.entity.kind, kind);
    assert.equal(context.entity.id, id);
  }
  fixture.route("QuestionsObjectPage", "'q1'");
  assert.equal(fixture.assistant.contextProvider.getContext().surface, "cockpit.approvals");
  assert.equal(fixture.assistant.contextProvider.getContext().entity, undefined);
  fixture.exit();
});

test("assistant writes refresh only the visible page and the listener is detached on exit", async () => {
  const fixture = await component("localhost", "");
  fixture.assistantChanged({ rows: [] });
  assert.equal(fixture.refreshes(), 0);
  fixture.assistantChanged({ caseID: "delivery:4500000001/10", status: "open" });
  assert.equal(fixture.refreshes(), 1);
  fixture.exit();
  assert.equal(fixture.hasAssistantListener(), false);
});

test("assistant request context uses the existing requisition case identity", async () => {
  const fixture = await component("localhost", "");
  fixture.route("RequestsObjectPage", encodeURIComponent(
    "PurchaseRequisition='1000000001',PurchaseRequisitionItem='00010',IsActiveEntity=false",
  ));
  const context = fixture.assistant.contextProvider.getContext();
  assert.equal(context.surface, "cockpit.requests");
  assert.equal(context.entity.kind, "case");
  assert.equal(context.entity.id, "requisition:1000000001/00010");
  fixture.route("RequestsList", "");
  assert.equal(fixture.assistant.contextProvider.getContext().entity, undefined);
  fixture.exit();
});

test("local assistant uses the signed-in buyer and rejects external agent overrides", async () => {
  const fixture = await component(
    "localhost",
    "?agentUrl=https://external.example",
    "#%invalid",
  );
  assert.equal(
    fixture.assistant.authToken,
    "Basic " + btoa("buyerD01:buyerD01"),
  );
  assert.equal(fixture.assistant.userId, "buyerD01");
  assert.equal(fixture.attributes["agent-url"], undefined);
  assert.doesNotThrow(() => fixture.assistant.contextProvider.getContext());
  fixture.exit();
  assert.equal(fixture.destroyed(), true);
});

test("production hosts never derive mocked credentials or accept agent overrides", async () => {
  const fixture = await component(
    "purchasing.example",
    "?agentUrl=http://localhost:8081",
  );
  assert.equal(fixture.assistant.authToken, undefined);
  assert.equal(fixture.assistant.userId, "buyerD01");
  assert.equal(fixture.attributes["agent-url"], undefined);
});

test("loopback hosts with real authentication do not derive mocked credentials", async () => {
  const fixture = await component("localhost", "", "", false);
  assert.equal(fixture.assistant.authToken, undefined);
  assert.equal(fixture.assistant.userId, "buyerD01");
  fixture.exit();
});

test("the user menu offers buyer switching only under server-reported mock authentication", async () => {
  for (const mockAuthentication of [false, true]) {
    let menu: any;
    let sheet: any;
    class Button {
      constructor(public settings: any) {}
    }
    class ActionSheet {
      constructor(settings: any) {
        sheet = settings;
      }
      openBy() {}
    }
    class ResourceModel {
      getResourceBundle() {
        return { getText: String };
      }
    }
    class XMLHttpRequest {
      status = 200;
      responseText = JSON.stringify({
        userId: "buyerD01",
        name: "Buyer D01",
        mockAuthentication,
      });
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        this.onload?.();
      }
    }
    vm.runInNewContext(
      readFileSync(
        path.join(__dirname, "../app/purchasing-desk/webapp/ext/guard/UserMenu.js"),
        "utf8",
      ),
      {
        XMLHttpRequest,
        sap: {
          ui: {
            define: (dependencies: string[], factory: Function) => {
              menu = factory(
                ...dependencies.map(
                  (name) =>
                    (
                      ({
                        "sap/m/Button": Button,
                        "sap/m/ActionSheet": ActionSheet,
                        "sap/ui/model/resource/ResourceModel": ResourceModel,
                      }) as Record<string, unknown>
                    )[name] || {},
                ),
              );
            },
          },
        },
      },
    );
    menu.open(null, {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(sheet);
    assert.equal(
      sheet.buttons.some(
        (button: Button) => button.settings.id === "guardSwitchBuyer",
      ),
      mockAuthentication,
    );
  }
});
