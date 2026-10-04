import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import cds from "@sap/cds";

const manifest = JSON.parse(
  readFileSync("app/purchasing-desk/webapp/manifest.json", "utf8"),
);
const targets = manifest["sap.ui5"].routing.targets;
const styles = readFileSync("app/purchasing-desk/webapp/css/style.css", "utf8");
test("retired legacy worklist pages stay removed", () => {
  const routes = manifest["sap.ui5"].routing.routes.map(
    (route: { name: string }) => route.name,
  );
  for (const page of [
    "OpenItemsList",
    "OpenItemsObjectPage",
    "CustomerImpactsObjectPage",
    "CustomersObjectPage",
    "SourceFindingsObjectPage",
  ]) {
    assert.equal(targets[page], undefined, page);
    assert.ok(!routes.includes(page), page);
  }
  assert.equal(manifest["tide.actions"].OpenItems, undefined);
});
const cases = [
  {
    entity: "DuplicateMaterials",
    section: "comparisonEvidence",
    fragment: "ComparisonEvidence",
    facets: ["Main"],
    fields: ["candidateCount"],
  },
  {
    entity: "UnusualSettings",
    section: "comparisonEvidence",
    fragment: "RareCombinationEvidence",
    facets: ["Main"],
    fields: ["groupSize", "unusualPairCount"],
  },
  {
    entity: "SupplierPlannedTimes",
    section: "leadTimeComparison",
    fragment: "SupplierLeadTimeComparison",
    facets: ["Main"],
    fields: [
      "currentDays",
      "proposedDays",
      "p50",
      "ownDeliveries",
      "value12mEUR",
      "proposalRule",
    ],
  },
  {
    entity: "MaterialPlannedTimes",
    section: "leadTimeComparison",
    fragment: "MaterialLeadTimeComparison",
    facets: ["Main"],
    fields: [
      "currentDays",
      "proposedDays",
      "delta",
      "tolerance",
      "orders12m",
      "masterFlag",
    ],
  },
];

test("approvals use delivery-style body decisions and contextual proposal utilities", () => {
  const content = targets.ActionsObjectPage.options.settings.content;
  assert.equal(content.body.sections.pageActions, undefined);
  assert.equal(content.body.sections.approvalDecisionSection.title, "Decision");
  assert.equal(content.footer.actions.approveApproval.visible, false);
  assert.match(content.footer.actions.approveApproval.enabled, /canApprove/);
  assert.equal(content.footer.actions.recordOutcome.visible, false);
  const workspace = readFileSync(
    "app/purchasing-desk/webapp/ext/approvals/ApprovalWorkspace.fragment.xml",
    "utf8",
  );
  const actions = readFileSync(
    "app/purchasing-desk/webapp/ext/approvals/ApprovalActions.fragment.xml",
    "utf8",
  );
  assert.equal(content.body.sections.approvalActionsSection.title, "Actions");
  assert.equal(
    content.body.sections.approvalActionsSection.template,
    "tide.cockpit.ext.approvals.ApprovalActions",
  );
  assert.equal(
    content.body.sections.approvalActionsSection.position.anchor,
    "approvalDecisionSection",
  );
  assert.doesNotMatch(
    workspace,
    /tideActionRow|tide.cockpit.ext.ActionSection/,
  );
  assert.match(actions, /tide.cockpit.ext.ActionSection/);
  assert.match(actions, /class="tideActionRow tideRecommendedAction"/);
  assert.match(actions, /visible="\{approval>\/canDecide\}"/);
  assert.match(actions, /visible="\{approval>\/canLogOutcome\}"/);
  assert.match(
    actions,
    /press="\.extension\.tide\.cockpit\.ext\.controller\.ApprovalWorkspace.onApprove" enabled=".*canApprove/,
  );
  const prevention = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/DecisionSection.fragment.xml",
    "utf8",
  );
  assert.match(
    prevention,
    /visible="\{prevention>\/canPrepare\}" class="tideActionRow"/,
  );
  assert.match(
    prevention,
    /type="Emphasized" press="Decisions.prepare" enabled=".*canPrepare.*busy/,
  );
  assert.match(
    prevention,
    /press="Decisions.accept" enabled=".*canAccept.*busy/,
  );
  assert.match(prevention, /visible="\{= !!%\{prevention>\/incomplete\} \}"/);
  assert.doesNotMatch(prevention, /level="H3"/);
  assert.doesNotMatch(workspace, /press="ApprovalWorkspace.onApprove"/);
  assert.match(workspace, /approval>\/hasEvents/);
  assert.match(workspace, /approval>\/state.*error/);
});

test("preparing and deciding approvals refresh cached filtered lists", async () => {
  let actions: any;
  const decisions: any[] = [];
  let pageRefreshes = 0;
  let refreshes = 0;
  const model = {
    refresh: () => {
      refreshes += 1;
    },
  };
  const workflow = {
    bindContext: (action: string) => {
      const parameters: Record<string, unknown> = {};
      return {
        setParameter: (key: string, value: unknown) => { parameters[key] = value; },
        invoke: async () => { decisions.push({ action, parameters }); },
        getBoundContext: () => ({ getObject: () => ({
          caseID: parameters.caseID, actionID: parameters.actionID || "prepared-action", status: "waiting",
        }) }),
        destroy: () => undefined,
      };
    },
  };
  const storage = new Map();
  let pending: any;
  class Storage {
    static Type = { session: "session" };
    put(key: string, value: unknown) { storage.set(key, value); return true; }
    get(key: string) { return storage.get(key); }
    remove(key: string) { storage.delete(key); }
  }
  runInNewContext(readFileSync("app/purchasing-desk/webapp/ext/shared/WorkflowPending.js", "utf8"), {
    sap: { ui: { define: (_deps: string[], factory: Function) => {
      pending = factory(Storage, () => `command-${decisions.length}`);
    } } },
  });
  const api = {
    refresh: () => {
      pageRefreshes += 1;
    },
    getModel: (name?: string) =>
      name === "workflow" ? workflow : name
        ? {
            getResourceBundle: () => ({ getText: (key: string) => key }),
          }
        : model,
    editFlow: {
      invokeAction: async (action: string, options: any) => {
        assert.fail(`Legacy decision reached: ${action} ${JSON.stringify(options)}`);
      },
    },
  };
  const context = {
    getModel: () => model,
    requestProperty: async () => assert.fail("Must use the displayed evidence, not reload a fresh fingerprint"),
    getProperty: (name: string) =>
      name === "status" ? "needs_decision" : "value",
  };
  runInNewContext(
    readFileSync("app/purchasing-desk/webapp/ext/CockpitActions.js", "utf8"),
    {
      sap: {
        ui: {
          define: (_deps: string[], factory: Function) => {
            actions = factory(
              null,
              null,
              null,
              null,
              null,
              null,
              { show: () => undefined },
              {
                confirm: (_text: string, options: any) =>
                  options.onClose(options.emphasizedAction),
              },
              pending,
            );
          },
        },
      },
    },
  );
  await actions.addToApprovals.call(api, context);
  assert.equal(refreshes, 1);
  await actions.approveSelected.call(api, null, [context]);
  assert.equal(refreshes, 2);
  assert.equal(pageRefreshes, 2);
  assert.equal(decisions[0].action, "/prepareCaseAction(...)");
  assert.equal(decisions[1].action, "/approveAction(...)");
  assert.deepEqual(
    JSON.parse(JSON.stringify(decisions[1].parameters)),
    { actionID: "value", expectedModifiedAt: "value", note: null, commandID: "command-1" },
  );
  assert.equal(decisions[0].parameters.expectedFingerprint, "value");
  assert.equal(decisions[0].parameters.expectedModifiedAt, "value");
  assert.equal(storage.size, 0);
  const workspace = readFileSync(
    "app/purchasing-desk/webapp/ext/approvals/ApprovalWorkspace.js",
    "utf8",
  );
  assert.match(workspace, /context\.getModel\(\)\.refresh\(\)/);
  assert.match(workspace, /api\.refresh\(\)/);
});

test("remaining cockpit mutation handlers invalidate cached lists", () => {
  for (const file of [
    "ActionSection.js",
    "freetext/Review.js",
    "outlook/Outlook.js",
    "controller/RequisitionWorkspace.controller.js",
  ]) {
    const source = readFileSync("app/purchasing-desk/webapp/ext/" + file, "utf8");
    assert.match(source, /context\.getModel\(\)\.refresh\(\)/, file);
  }
});

test("approval workspace shares complete decision data with the page footer", async () => {
  let workspace: any;
  let failCollection = false;
  let disposed = 0;
  const selections: string[] = [];
  const row = {
    ID: "approval-1",
    status: "needs_decision",
    kind: "reminder",
    operationKey: "delivery_intervention",
    summary: "Confirm delivery",
    createdBy: "buyer",
  };
  class Model {
    data: any;
    constructor(data: any) {
      this.data = data;
    }
    setData(data: any) {
      this.data = data;
    }
    getProperty(path: string) {
      return this.data[path.slice(1)];
    }
  }
  const service = {
    bindContext: (_path: string, _context: unknown, parameters: any) => {
      selections.push(parameters.$select);
      return { requestObject: async () => row, destroy: () => { disposed++; } };
    },
    bindList: (
      path: string,
      _context: unknown,
      _sort: unknown,
      _filter: unknown,
      parameters: any,
    ) => {
      if (path === "items" || path === "actionEvents")
        selections.push(parameters.$select);
      return {
        requestContexts: async () => {
          if (path === "items" && failCollection) throw new Error("Evidence unavailable");
          return path === "items"
            ? [
                {
                  getObject: () => ({
                    text: "Please confirm delivery",
                    oldValue: "2026-10-04",
                    newValue: "Confirm date",
                  }),
                },
              ]
            : [];
          },
          destroy: () => { disposed++; },
      };
    },
  };
  const context = {
    getPath: () => "/Actions('approval-1')",
    getModel: () => service,
  };
  let shared: any;
  let local: any;
  const values: Record<string, unknown> = {};
  const view = {
    isA: () => true,
    setModel: (model: unknown) => {
      shared = model;
    },
  };
  const box = {
    isA: () => false,
    getParent: () => view,
    getBindingContext: () => context,
    getModel: () => local,
    setModel: (model: unknown) => {
      local = model;
    },
    data: (key: string, value?: unknown) =>
      value === undefined ? values[key] : (values[key] = value),
  };
  const formatter = { format: () => "date" };
  runInNewContext(
    readFileSync(
      "app/purchasing-desk/webapp/ext/approvals/ApprovalWorkspace.js",
      "utf8",
    ),
    {
      sap: {
        ui: {
          define: (dependencies: string[], factory: any) => {
            const modules: Record<string, unknown> = {
              "sap/ui/model/json/JSONModel": Model,
              "sap/ui/core/format/DateFormat": {
                getDateTimeInstance: () => formatter,
                getDateInstance: () => formatter,
              },
              "tide/cockpit/ext/shared/WorkflowPending": { reconcile: async () => undefined },
            };
            workspace = factory(...dependencies.map(dependency => modules[dependency] || {}));
          },
        },
      },
    },
  );
  workspace.onContextChange({ getSource: () => box });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shared, local);
  assert.equal(shared.data.state, "loaded");
  assert.equal(shared.data.canApprove, true);
  assert.equal(shared.data.hasPreparedContent, true);
  assert.equal(shared.data.preparedBy, "buyer");
  assert.equal(shared.data.hasEvents, false);
  assert.deepEqual(selections, ["*", "*", "*"]);
  assert.equal(disposed, 4);
  failCollection = true;
  values.approvalPath = null;
  workspace.onContextChange({ getSource: () => box });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shared.data.state, "error");
  assert.equal(shared.data.canApprove, false);
  assert.equal(disposed, 8);
});

test("all moved page commands use body sections and preserve state guards", () => {
  const registry = manifest["tide.actions"];
  for (const [entity, pageName] of [
    ["PurchaseRequisitionReviews", "RequestsReviewObjectPage"],
    ["PriceDeviations", "PriceDeviationObjectPage"],
    ...cases.map((entry) => [entry.entity, `${entry.entity}ObjectPage`]),
  ]) {
    const content = targets[pageName!].options.settings.content;
    assert.equal(content.header?.actions, undefined, entity);
    if (entity === "PurchaseRequisitionReviews") {
      assert.equal(
        content.body.sections.decisionWorkspace.subSections.reviewCommands
          .template,
        "tide.cockpit.ext.requisition.ReviewCommands",
      );
    } else {
      assert.ok(
        Object.values(content.body.sections).some((section: unknown) =>
          [
            "tide.cockpit.ext.ActionSection",
            "tide.cockpit.ext.prevention.DecisionSection",
          ].includes((section as { template: string }).template),
        ),
        entity,
      );
    }
    const actions = registry[entity!];
    assert.ok(actions.length > 0, entity);
    assert.equal(
      new Set(actions.map((action: { id: string }) => action.id)).size,
      actions.length,
      entity,
    );
  }
  for (const entry of cases) {
    for (const action of registry[entry.entity].filter(
      (action: { action?: string }) => action.action,
    ))
      assert.equal(
        action.enabled,
        "{= %{caseStatus} === 'open' }",
        `${entry.entity}.${action.id}`,
      );
  }
  const review =
    targets.RequestsReviewObjectPage.options.settings.content.footer.actions
      .submitForApproval;
  assert.equal(
    review.press,
    ".extension.tide.cockpit.ext.controller.RequisitionWorkspace.onReviewOrder",
  );
  assert.equal(
    review.enabled,
    "{= !%{requiresSourceReconciliation} && !%{workspace>/actionBusy} }",
  );
  assert.equal(
    review.visible,
    "{= %{lifecycleStatus} === 'needs_review' || %{lifecycleStatus} === 'source_changed' }",
  );
  assert.deepEqual(registry.Actions, []);
  assert.doesNotMatch(JSON.stringify(registry), /downloadApprovedInstructions|downloadReviewCsv|downloadOrderDraft/);
  assert.equal(targets.ActionsObjectPage.options.settings.content.footer.actions.approveApproval.press,
    ".extension.tide.cockpit.ext.controller.ApprovalWorkspace.onApprove");
  assert.equal(
    targets.DeliveryRiskCaseObjectPage.options.settings.content.header.actions,
    undefined,
  );
  const delivery = readFileSync(
    "app/purchasing-desk/webapp/ext/finding/ActSection.fragment.xml",
    "utf8",
  );
  assert.match(delivery, /class="tideActionRow"/);
  assert.doesNotMatch(delivery, /class="\{=/);
  assert.match(delivery, /fragmentName="tide.cockpit.ext.ActionSection"/);
  assert.match(styles, /padding: 1\.25rem 0/);
  assert.match(styles, /overflow-wrap: anywhere/);
});

test("action buttons align their boxes and the AI badge sits above the highlighted title", () => {
  const rule = (selector: string) =>
    styles.slice(styles.indexOf(`${selector} {`)).split("}")[0];
  const button = rule(".tideActionRow .sapMBtn");
  const inner = rule(".tideActionRow .sapMBtnInner");
  assert.match(button, /padding: 0;/);
  assert.match(button, /margin: 0;/);
  assert.match(button, /min-height: 2\.5rem;/);
  assert.match(inner, /min-height: 2\.5rem;/);
  assert.match(inner, /align-items: center;/);
  assert.match(inner, /border-radius: 0\.375rem;/);
  const delivery = readFileSync(
    "app/purchasing-desk/webapp/ext/finding/ActSection.fragment.xml",
    "utf8",
  );
  const badge = delivery.match(
    /<HBox id="actRecommendedBadge"[\s\S]*?<\/HBox>/,
  )?.[0];
  assert.ok(badge);
  assert.match(badge, /actRecommendedIcon/);
  assert.match(badge, /actRecommendedLabel/);
  assert.doesNotMatch(badge, /id="actTitle"/);
  assert.ok(
    delivery.indexOf('id="actRecommendedBadge"') <
      delivery.indexOf('id="actTitle"'),
  );
  assert.match(delivery, /CustomData key="recommended".*writeToDom="true"/);
  assert.doesNotMatch(delivery, /sapUiSmallMarginBegin/);
  assert.match(rule('.tideActionRow[data-recommended="true"]'), /box-shadow:/);
  assert.match(
    rule('.tideActionRow[data-recommended="true"]'),
    /border: 1px solid/,
  );
});

test("receipt review opens the read-only evidence dialog from the loaded case", async () => {
  const messages: { message: string; title: string }[] = [];
  const option = {
    operation: "checkReceipt",
    title: "Verify goods receipt status",
    reason: "Other items were received on 16 Jun 2025.",
    effect: "Verify the receipt with Goods Receiving; no action is prepared.",
  };
  const context = {
    getProperty: (key: string) =>
      ({ PurchaseOrder: "4500000663", PurchaseOrderItem: "120" })[
        key as "PurchaseOrder" | "PurchaseOrderItem"
      ],
  };
  const view = {
    isA: () => true,
    getController: () => ({ getExtensionAPI: () => ({}) }),
  };
  const source = {
    getId: () => "case--actBox",
    isA: () => false,
    getParent: () => view,
    getBindingContext: (model?: string) =>
      model === "out" ? { getObject: () => option } : context,
    getModel: () => ({
      getResourceBundle: () => ({
        getText: (_key: string, values: string[]) => values.join("/"),
      }),
    }),
  };
  let handlers!: {
    onOption: (event: { getSource: () => typeof source }) => Promise<void>;
  };
  runInNewContext(
    readFileSync("app/purchasing-desk/webapp/ext/outlook/Outlook.js", "utf8"),
    {
      sap: {
        ui: {
          define: (
            dependencies: string[],
            factory: (...modules: any[]) => typeof handlers,
          ) => {
            handlers = factory(
              ...dependencies.map((dependency) => {
                if (dependency.endsWith("DateFormat"))
                  return { getDateInstance: () => ({}) };
                if (dependency.endsWith("NumberFormat"))
                  return { getPercentInstance: () => ({}) };
                if (dependency === "sap/m/MessageBox")
                  return {
                    information: (
                      message: string,
                      settings: { title: string },
                    ) => messages.push({ message, title: settings.title }),
                    error: (message: string) => assert.fail(message),
                  };
                return {};
              }),
            );
          },
        },
      },
    },
  );
  await handlers.onOption({ getSource: () => source });
  assert.deepEqual(messages, [
    {
      title: option.title,
      message: "4500000663/120\n\n" + option.reason + "\n\n" + option.effect,
    },
  ]);
});

test("shared action renderer preserves handler contexts and prevents repeated clicks", async () => {
  const calls: unknown[][] = [];
  const errors: unknown[] = [];
  let refreshes = 0;
  const context = {
    getPath: () => "/Example('case')",
    getModel: () => ({
      refresh: () => {
        refreshes += 1;
      },
    }),
    requestProperty: () => Promise.resolve("reviewed-fingerprint"),
  };
  const api = {
    refresh: () => undefined,
    editFlow: {
      invokeAction: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    },
  };
  const owner = {
    run: function (binding: unknown) {
      calls.push([this === owner, binding]);
    },
  };
  const controller = { getExtensionAPI: () => api, extension: { test: owner } };
  const view = { isA: () => true, getController: () => controller };
  class Control {
    id: string;
    settings: Record<string, any>;
    items: Control[];
    busy = false;
    constructor(
      idOrSettings: string | Record<string, any>,
      settings?: Record<string, any>,
    ) {
      this.id = typeof idOrSettings === "string" ? idOrSettings : "section";
      this.settings = settings || (idOrSettings as Record<string, any>);
      this.items = this.settings.items || [];
    }
    addStyleClass() {
      return this;
    }
    addItem(item: Control) {
      this.items.push(item);
    }
    destroyItems() {
      this.items = [];
    }
    getId() {
      return this.id;
    }
    getBindingContext() {
      return context;
    }
    getParent() {
      return view;
    }
    isA() {
      return false;
    }
    getBusy() {
      return this.busy;
    }
    setBusy(value: boolean) {
      this.busy = value;
    }
    isDestroyed() {
      return false;
    }
  }
  const registry = {
    Example: [
      {
        id: "module",
        text: "Prepare",
        icon: "sap-icon://discussion-2",
        press: "test.handlers.run",
        enabled: "{= %{caseStatus} === 'open' }",
      },
      { id: "controller", text: "Review", press: ".extension.test.run" },
      { id: "bound", text: "Accept", action: "PurchasingDeskService.acceptException" },
    ],
  };
  let renderer!: {
    onContextChange: (event: { getSource: () => Control }) => void;
  };
  const Component = {
    getOwnerComponentFor: () => ({ getManifestEntry: () => registry }),
  };
  runInNewContext(
    readFileSync("app/purchasing-desk/webapp/ext/ActionSection.js", "utf8"),
    {
      sap: {
        ui: {
          define: (
            _dependencies: unknown,
            factory: (...args: any[]) => typeof renderer,
          ) => {
            renderer = factory(
              Component,
              Control,
              Control,
              Control,
              Control,
              Control,
              { error: (error: unknown) => errors.push(error) },
            );
          },
          require: (_modules: unknown, callback: (handlers: unknown) => void) =>
            callback({
              run: function (binding: unknown) {
                calls.push([this === api, binding]);
              },
            }),
        },
      },
    },
  );
  const box = new Control({});
  const event = { getSource: () => box };
  renderer.onContextChange(event);
  renderer.onContextChange(event);
  assert.equal(box.items.length, 3);
  const buttons = box.items.map((row) => row.items[1]!);
  assert.equal(buttons[0]!.id, "section--module");
  assert.equal(buttons[0]!.settings.icon, registry.Example[0]!.icon);
  assert.equal(buttons[0]!.settings.enabled, registry.Example[0]!.enabled);
  for (const button of buttons) {
    button.settings.press();
    button.settings.press();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  assert.equal(calls[0]![0], true);
  assert.equal(calls[0]![1], context);
  const bound = calls.find(
    (call) => call[0] === "PurchasingDeskService.acceptException",
  )!;
  assert.equal((bound[1] as { contexts: unknown[] }).contexts[0], context);
  assert.deepEqual(
    JSON.parse(JSON.stringify((bound[1] as any).parameterValues)),
    [{ name: "expectedFingerprint", value: "reviewed-fingerprint" }],
  );
  assert.ok(
    calls
      .filter((call) => call[0] === true)
      .every((call) => call[1] === context),
  );
  assert.deepEqual(errors, []);
  assert.equal(refreshes, 1);
  assert.ok(buttons.every((button) => !button.busy));
});

test("prevention overview uses a bounded strip with aligned labels and readable counts", () => {
  const rule = (selector: string) =>
    styles.slice(styles.indexOf(`${selector} {`)).split("}")[0];
  assert.match(rule(".tidePreventionKpis"), /max-width: 80rem/);
  assert.match(rule(".tidePreventionKpis"), /repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(rule(".tidePreventionKpis > .sapMFlexItem"), /margin: 0/);
  assert.match(rule(".tidePreventionMetric .sapMLabel"), /min-height: 2\.5rem/);
  assert.match(rule(".tidePreventionMetric .sapMLabel"), /white-space: normal/);
  assert.match(
    rule(".tidePreventionMetricValue .sapMObjectNumberText"),
    /font-variant-numeric: tabular-nums/,
  );
  const phoneStyles = styles.slice(styles.indexOf("@media (max-width: 42rem)"));
  assert.match(phoneStyles, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(phoneStyles, /flex-direction: row/);
  assert.match(phoneStyles, /justify-content: space-between/);
  assert.match(phoneStyles, /min-height: 2\.75rem/);
  const fragment = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/PreventionHeader.fragment.xml",
    "utf8",
  );
  assert.equal((fragment.match(/<ObjectNumber /g) || []).length, 5);
  assert.doesNotMatch(fragment, /GenericTile|NumericContent/);
});

test("prevention pages start with specific comparisons without redundant summary facets", async () => {
  const planned = targets.PreventionList.options.settings.views.paths.filter(
    (view: any) =>
      ["PlannedTimes", "SupplierPlannedTimes", "MaterialPlannedTimes"].includes(
        view.entitySet,
      ),
  );
  assert.equal(planned.length, 1);
  assert.equal(planned[0].entitySet, "PlannedTimes");
  assert.equal(planned[0].label, "{i18n>preventionPlannedTimes}");
  const evidence = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/Evidence.fragment.xml",
    "utf8",
  );
  assert.match(
    evidence,
    /fragmentName="tide.cockpit.ext.prevention.Assessment"/,
  );
  const decisions = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/DecisionSection.fragment.xml",
    "utf8",
  );
  assert.doesNotMatch(
    decisions,
    /fragmentName="tide.cockpit.ext.prevention.Assessment"/,
  );
  const model = (await cds.load("app/purchasing-desk/annotations.cds")) as unknown as {
    definitions: Record<string, Record<string, unknown>>;
  };
  for (const [entity, qualifier, label] of [
    ["PriceDeviations", "Price", "Price deviations"],
    ["DuplicateMaterials", "Duplicate", "Duplicates"],
    ["UnusualSettings", "Rare", "Unusual settings"],
    ["SupplierPlannedTimes", "SupplierPlannedTime", "Supplier lead times"],
    [
      "MaterialPlannedTimes",
      "MaterialMasterPlannedTime",
      "Material lead times",
    ],
  ]) {
    const text =
      model.definitions[`PurchasingDeskService.${entity}`]![
        `@UI.SelectionPresentationVariant#${qualifier}.Text`
      ];
    assert.equal(text, label, entity);
  }
  for (const entry of cases) {
    const page = targets[`${entry.entity}ObjectPage`];
    const sections = page.options.settings.content.body.sections;
    assert.equal(sections.decisionSummary, undefined, entry.entity);
    assert.equal(
      sections[entry.section].position.placement,
      "Before",
      entry.entity,
    );
    assert.equal(
      sections[entry.section].position.anchor,
      entry.facets[0],
      entry.entity,
    );
    const entity = model.definitions[`PurchasingDeskService.${entry.entity}`]!;
    assert.deepEqual(
      (entity["@UI.Facets"] as { ID: string }[]).map((facet) => facet.ID),
      entry.facets,
      entry.entity,
    );
    assert.equal(
      (entity["@UI.Identification"] as unknown[]).length,
      2,
      entry.entity,
    );
    assert.ok(
      (entity["@UI.Identification"] as Record<string, unknown>[]).every(
        (action) => action["@UI.Hidden"] === true,
      ),
      entry.entity,
    );
    const fragment = readFileSync(
      `app/purchasing-desk/webapp/ext/prevention/${entry.fragment}.fragment.xml`,
      "utf8",
    );
    assert.ok(
      fragment.includes(
        'fragmentName="tide.cockpit.ext.prevention.CaseSummary"',
      ),
      entry.entity,
    );
    const workspace = readFileSync(
      "app/purchasing-desk/webapp/ext/prevention/Workspace.js",
      "utf8",
    );
    for (const field of entry.fields)
      assert.ok(
        fragment.includes(`prevention>/row/${field}`) ||
          fragment.includes(`prevention>/${field}`) ||
          workspace.includes(`row.${field}`),
        `${entry.entity}.${field}`,
      );
    if (entry.entity === "UnusualSettings") {
      assert.equal(sections.supportingEvidence, undefined);
      assert.match(fragment, /prevention>\/deliveryRanges/);
    } else {
      assert.equal(
        sections.supportingEvidence.template,
        "tide.cockpit.ext.prevention.Evidence",
      );
      assert.equal(sections.supportingEvidence.position.anchor, "Main");
    }
    assert.equal(
      sections.pageActions.template,
      "tide.cockpit.ext.prevention.DecisionSection",
    );
    assert.equal(
      sections.pageActions.position.anchor,
      entry.entity === "UnusualSettings" ? "Main" : "supportingEvidence",
    );
  }
  const lines = model.definitions["PurchasingDeskService.RuleLines"]!;
  for (const [qualifier, expected] of Object.entries({
    DuplicateCandidates: ["label", "text", "n1", "n2"],
    RareCombinations: ["label", "text", "n1", "n2", "n3"],
  })) {
    const columns = lines[`@UI.LineItem#${qualifier}`] as {
      Value: { "=": string };
      "@UI.Importance": { "#": string };
    }[];
    assert.deepEqual(
      columns.map((column) => column.Value["="]),
      expected,
    );
    assert.ok(
      columns.every((column) => column["@UI.Importance"]["#"] === "High"),
    );
  }
});

test("price and duplicates have one comparison, context, evidence and decision", async () => {
  const model = (await cds.load("app/purchasing-desk/annotations.cds")) as any;
  const price = model.definitions["PurchasingDeskService.PriceDeviations"];
  assert.deepEqual(price["@UI.HeaderFacets"], []);
  assert.deepEqual(
    price["@UI.Facets"].map((facet: any) => facet.ID),
    ["Main"],
  );
  const sections =
    targets.PriceDeviationObjectPage.options.settings.content.body.sections;
  assert.equal(sections.priceActions, undefined);
  assert.equal(sections.priceComparison.position.anchor, "Main");
  assert.equal(sections.supportingEvidence.position.anchor, "Main");
  assert.equal(sections.pageActions.position.anchor, "supportingEvidence");
  const fragment = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/PriceComparison.fragment.xml",
    "utf8",
  );
  assert.match(fragment, /p:EvidenceChart/);
  assert.match(fragment, /class="tidePriceCharts"/);
  assert.match(fragment, /AI estimate/);
  assert.match(fragment, /formatter: 'Workspace.formatPrice'/);
  assert.doesNotMatch(fragment, /items="\{prevention>\/priceQuantiles\}"/);
  assert.doesNotMatch(
    fragment,
    /VizFrame|priceHistoryChartHost|priceAnomalyIcon|priceSupportingFacts/,
  );
  const candidates = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/ComparisonEvidence.fragment.xml",
    "utf8",
  );
  assert.match(candidates, /id="duplicateCandidates"/);
  assert.match(candidates, /Reference material/);
  assert.match(
    candidates,
    /id="duplicatePlanning" items="\{prevention>\/lines\}"/,
  );
  assert.doesNotMatch(
    candidates,
    /ProgressIndicator|Planning Comparison:|headerText="Compare Candidate Activity"/,
  );
  assert.match(candidates, /prevention>\/ordersChart/);
  assert.match(candidates, /prevention>\/movementsChart/);
  assert.doesNotMatch(candidates, /number="\{activity\}"|state="Warning"/);
  const decisions = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/DecisionSection.fragment.xml",
    "utf8",
  );
  assert.match(decisions, /fragmentName="tide.cockpit.ext.ActionSection"/);
  assert.match(decisions, /press="Decisions.prepare"/);
  assert.match(decisions, /press="Decisions.accept"/);
  assert.match(decisions, /expanded="false"/);
});

test("price comparison uses responsive charts and explicit AI attribution", () => {
  const fragment = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/PriceComparison.fragment.xml",
    "utf8",
  );
  assert.match(fragment, /class="tidePriceCharts"/);
  assert.match(fragment, /AI estimate/);
  assert.equal(
    (fragment.match(/formatter: 'Workspace.formatPrice'/g) || []).length,
    3,
  );
  assert.doesNotMatch(fragment, /priceQuantiles|Empirical historical median/);
});

test("rare combinations and planned times share comparison styling and AI attribution", () => {
  for (const name of [
    "MaterialLeadTimeComparison",
    "SupplierLeadTimeComparison",
    "RareCombinationEvidence",
  ]) {
    const fragment = readFileSync(
      `app/purchasing-desk/webapp/ext/prevention/${name}.fragment.xml`,
      "utf8",
    );
    assert.match(fragment, /tidePriceSummary tideComparisonSummary/);
    assert.match(fragment, /AI/);
    assert.match(fragment, /tideAIStatus/);
  }
  const evidence = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/PlannedTimeEvidence.fragment.xml",
    "utf8",
  );
  assert.match(evidence, /tideDeliveryEvidenceColumns/);
  assert.match(evidence, /\? 'AI' :/);
  assert.doesNotMatch(evidence, /AI estimate|AI ·/);
  assert.match(evidence, /Source: TabPFN by PriorLabs/);
  assert.match(evidence, /visible="\{prevention>\/hasTabPFNDelivery\}"/);
  const rare = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/RareCombinationEvidence.fragment.xml",
    "utf8",
  );
  assert.doesNotMatch(rare, /AI ·|Suggested Planning[^"\n]*TabPFN/);
  assert.match(rare, /Source: TabPFN by PriorLabs/);
  assert.match(rare, /visible="\{prevention>\/hasTabPFNPlanning\}"/);
  assert.match(rare, /tideRareComparisonColumns/);
  assert.doesNotMatch(rare, /Observed Combination Counts/);
  const rareSections =
    targets.UnusualSettingsObjectPage.options.settings.content.body.sections;
  assert.equal(rareSections.comparisonEvidence.title, "Evidence & Forecast");
  assert.equal(rareSections.supportingEvidence, undefined);
  assert.equal(rareSections.pageActions.position.anchor, "Main");
  assert.match(rare, /prevention>\/deliveryRanges/);
  assert.doesNotMatch(
    rare,
    /fragmentName="tide.cockpit.ext.prevention.PlannedTimeEvidence"|items="\{prevention>\/deliveryEvidence\}"/,
  );
  const controls = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/PredictionControls.fragment.xml",
    "utf8",
  );
  assert.doesNotMatch(controls, /Late threshold|lateThreshold|StepInput/);
  assert.doesNotMatch(evidence, /<Panel/);
});

test("typed-case lists use the shared generalized attention status column", () => {
  const shared = readFileSync(
    "app/purchasing-desk/webapp/ext/shared/AttentionStatus.fragment.xml",
    "utf8",
  );
  assert.match(shared, /tide\/cockpit\/ext\/shared\/Attention/);
  assert.match(shared, /Attention\.text/);
  assert.match(shared, /Attention\.state/);
  assert.match(shared, /Attention\.icon/);

  for (const [entitySet, lineItem] of [
    ["PriceDeviations", "@com.sap.vocabularies.UI.v1.LineItem#Price"],
    [
      "DuplicateMaterials",
      "/DuplicateMaterials/@com.sap.vocabularies.UI.v1.LineItem#Duplicate",
    ],
    [
      "UnusualSettings",
      "/UnusualSettings/@com.sap.vocabularies.UI.v1.LineItem#Rare",
    ],
    [
      "SupplierPlannedTimes",
      "/SupplierPlannedTimes/@com.sap.vocabularies.UI.v1.LineItem#SupplierPlannedTime",
    ],
    [
      "MaterialPlannedTimes",
      "/MaterialPlannedTimes/@com.sap.vocabularies.UI.v1.LineItem#MaterialMasterPlannedTime",
    ],
  ]) {
    const config =
      manifest["sap.ui5"].routing.targets.PreventionList.options.settings
        .controlConfiguration[lineItem];
    assert.equal(
      config.columns.attention.template,
      "tide.cockpit.ext.shared.AttentionStatus",
      entitySet,
    );
    assert.deepEqual(
      config.columns.attention.properties,
      ["caseAttention"],
      entitySet,
    );
    assert.equal(
      config.columns["DataField::caseAttention"].availability,
      "Hidden",
      entitySet,
    );
  }
});

test("all case attention badges share the generalized presentation", () => {
  for (const file of [
    "app/purchasing-desk/webapp/ext/finding/DeliveryRiskHeader.fragment.xml",
    "app/purchasing-desk/webapp/ext/prevention/CaseSummary.fragment.xml",
  ]) {
    const fragment = readFileSync(file, "utf8");
    assert.match(fragment, /tide\/cockpit\/ext\/shared\/Attention/, file);
    assert.match(fragment, /Attention\.text/, file);
    assert.match(fragment, /Attention\.state/, file);
    assert.match(fragment, /Attention\.icon/, file);
  }
  const manifest = JSON.parse(
    readFileSync("app/purchasing-desk/webapp/manifest.json", "utf8"),
  );
  const deliverySettings =
    manifest["sap.ui5"].routing.targets.DeliveryRisksList.options.settings;
  assert.equal(
    deliverySettings.defaultTemplateAnnotationPath,
    "com.sap.vocabularies.UI.v1.SelectionPresentationVariant#ActionRequired",
  );
  const deliveryColumns =
    deliverySettings.controlConfiguration[
      "@com.sap.vocabularies.UI.v1.LineItem"
    ].columns;
  assert.equal(
    deliveryColumns["DataField::caseAttention"].availability,
    "Hidden",
  );
  assert.equal(
    deliveryColumns.condition.template,
    "tide.cockpit.ext.finding.DeliveryRiskPhaseCell",
  );
  assert.deepEqual(deliveryColumns.condition.properties, ["phase"]);

  const approvals = readFileSync(
    "app/purchasing-desk/webapp/ext/approvals/ApprovalWorkspace.js",
    "utf8",
  );
  assert.match(approvals, /tide\/cockpit\/ext\/shared\/Attention/);
  assert.match(approvals, /attentionBucket: Attention\.bucket/);
  const approvalFragment = readFileSync(
    "app/purchasing-desk/webapp/ext/approvals/ApprovalWorkspace.fragment.xml",
    "utf8",
  );
  assert.match(approvalFragment, /Attention\.textForBucket/);
  assert.match(approvalFragment, /state="\{approval>attentionState\}"/);
  assert.match(approvalFragment, /icon="\{approval>attentionIcon\}"/);
});

test("delivery-risk worklist tabs cover each generalized state bucket", async () => {
  const model = (await cds.load("app/purchasing-desk/annotations.cds")) as unknown as {
    definitions: Record<string, Record<string, any>>;
  };
  const delivery = model.definitions["PurchasingDeskService.DeliveryRisks"]!;
  const attentionValues = (name: string) => {
    const selectOptions = delivery[
      `@UI.SelectionPresentationVariant#${name}.SelectionVariant.SelectOptions`
    ] as {
      PropertyName: { "=": string };
      Ranges: { Low: string }[];
    }[];
    return selectOptions
      .find((option) => option.PropertyName["="] === "caseAttention")!
      .Ranges.map((range) => range.Low)
      .sort();
  };
  assert.deepEqual(attentionValues("ActionRequired"), [
    "follow_up_overdue",
    "needs_attention",
    "needs_review",
    "source_changed",
  ]);
  assert.deepEqual(attentionValues("InProgress"), ["in_progress"]);
  assert.deepEqual(attentionValues("Waiting"), [
    "awaiting_decision",
    "awaiting_source",
    "waiting_external",
  ]);
  assert.deepEqual(attentionValues("Done"), ["done"]);

  const views = targets.DeliveryRisksList.options.settings.views.paths;
  assert.deepEqual(
    views.map((view: { key: string }) => view.key),
    ["actionRequired", "inProgress", "waiting", "done"],
  );
  assert.deepEqual(
    views.map((view: { annotationPath: string }) => view.annotationPath),
    ["ActionRequired", "InProgress", "Waiting", "Done"].map(
      (name) =>
        `com.sap.vocabularies.UI.v1.SelectionPresentationVariant#${name}`,
    ),
  );
  const tabs = views as {
    key: string;
    annotationPath: string;
    label: string;
  }[];
  assert.deepEqual(
    tabs.map((view) => view.label),
    [
      "{i18n>attentionActionRequired}",
      "{i18n>attentionInProgress}",
      "{i18n>attentionWaiting}",
      "{i18n>attentionDone}",
    ],
  );
});
