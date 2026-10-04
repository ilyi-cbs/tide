import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function moduleOf(name: string, modules: Record<string, any>) {
  modules["tide/cockpit/ext/shared/WorkflowPending"] ??= workflowRecovery().load(modules["sap/base/util/uid"]);
  let result: any;
  runInNewContext(
    readFileSync(`app/purchasing-desk/webapp/ext/prevention/${name}.js`, "utf8"),
    {
      sap: {
        ui: {
          define: (
            dependencies: string[],
            factory: (...args: any[]) => any,
          ) => {
            result = factory(
              ...dependencies.map((dependency) => modules[dependency] || {}),
            );
          },
        },
      },
    },
  );
  return result;
}

class Model {
  data: any = {};
  setSizeLimit() {}
  setData(data: any) {
    this.data = data;
  }
  getData() {
    return this.data;
  }
  getProperty(path: string) {
    return this.data[path.slice(1)];
  }
  setProperty(path: string, value: unknown) {
    this.data[path.slice(1)] = value;
  }
}

function workspace() {
  return moduleOf("Workspace", {
    "sap/ui/model/json/JSONModel": Model,
    "sap/ui/core/format/NumberFormat": {
      getFloatInstance: () => ({
        format: (value: number) => String(Math.round(value * 100) / 100),
      }),
    },
    "sap/ui/core/format/DateFormat": {
      getDateTimeInstance: () => ({
        format: (value: Date) => value.toISOString(),
      }),
    },
  });
}

const base = {
  caseStatus: "open",
  header: { sourceFingerprint: "reviewed" },
  caseSourceRevision: 1,
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function workflowRecovery() {
  const storage = new Map<string, unknown>();
  let nextID = 0;
  class Storage {
    static Type = { session: "session" };
    put(key: string, value: unknown) { storage.set(key, value); return true; }
    get(key: string) { return storage.get(key); }
    remove(key: string) { storage.delete(key); }
  }
  const load = (uid = () => `command-${++nextID}`) => {
    let pending: any;
    runInNewContext(readFileSync("app/purchasing-desk/webapp/ext/shared/WorkflowPending.js", "utf8"), {
      sap: { ui: { define: (_dependencies: string[], factory: Function) => {
        pending = factory(Storage, uid);
      } } },
    });
    return pending;
  };
  return { storage, load };
}

test("canonical consumer retries frozen arguments and reload only looks up unknown writes", async () => {
  const recovery = workflowRecovery();
  const pending = recovery.load();
  const writes: any[] = [];
  let committed = false;
  let destroyed = 0;
  const model = { bindContext: (path: string) => {
    const parameters: Record<string, unknown> = {};
    return {
      setParameter: (name: string, value: unknown) => { parameters[name] = value; },
      invoke: async () => {
        if (path !== "/commandResult(...)") {
          writes.push({ ...parameters });
          if (!committed) throw new Error("Response lost");
        }
      },
      getBoundContext: () => ({ getObject: () => committed ? { actionID: "action-1", status: "waiting" } : null }),
      destroy: () => { destroyed++; },
    };
  } };
  const original = { actionID: "action-1", expectedModifiedAt: "reviewed-version", note: "Private exact note", items: ["4500000010/10"] };
  await assert.rejects(pending.execute(model, "action:action-1", "action-1", "approveAction", original), /Response lost/);
  assert.deepEqual(JSON.parse(JSON.stringify(recovery.storage.get("action:action-1"))),
    { commandID: "command-1", target: "action-1", commandType: "approveAction",
      parameters: { ...original, commandID: "command-1" } });
  await assert.rejects(pending.execute(model, "action:action-1", "action-1", "approveAction",
    { ...original, expectedModifiedAt: "new-unreviewed-version", items: [...original.items] }), /Response lost/);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  await assert.rejects(pending.execute(model, "action:action-1", "action-1", "declineAction",
    { ...original, note: "Changed decision" }), /Reconcile the previous/);
  const reloaded = recovery.load();
  await assert.rejects(reloaded.execute(model, "action:action-1", "action-1", "approveAction", original), /outcome is still unknown/);
  assert.equal(writes.length, 2);
  committed = true;
  assert.equal((await reloaded.execute(model, "action:action-1", "action-1", "approveAction", original)).actionID, "action-1");
  assert.equal(writes.length, 2);
  assert.equal(recovery.storage.size, 0);
  assert.equal(destroyed, 6);
});

test("canonical recovery isolates authenticated buyers and preserves the original user's receipt", async () => {
  const recovery = workflowRecovery();
  const pending = recovery.load();
  const calls: string[] = [];
  const model = { bindContext: (path: string) => ({
    setParameter: () => {},
    invoke: async () => { calls.push(path); },
    getBoundContext: () => ({ getObject: () => ({ actionID: "action-1", payloadMatched: true }) }),
    destroy: () => {},
  }) };
  const identity = { userId: "buyerD01", origin: "https://purchasing.example" };
  pending.initialize(Promise.resolve(identity));
  await pending.reconcile(model, "action:action-1", "action-1");
  pending.remember("action:action-1", "receipt-1", "action-1", "approveAction", { actionID: "action-1" });
  assert.equal(recovery.storage.has("action:action-1"), false);
  pending.initialize(Promise.resolve({ ...identity, userId: "buyerD02" }));
  assert.equal(await pending.reconcile(model, "action:action-1", "action-1"), undefined);
  assert.equal(calls.length, 0);
  pending.initialize(Promise.resolve(identity));
  assert.equal((await pending.reconcile(model, "action:action-1", "action-1")).actionID, "action-1");
  assert.deepEqual(calls, ["/commandResult(...)"]);
  assert.equal(recovery.storage.size, 0);
});

test("canonical recovery sends no write when authenticated identity cannot be loaded", async () => {
  const pending = workflowRecovery().load();
  pending.initialize(Promise.resolve({ origin: "https://purchasing.example" }));
  await assert.rejects(pending.execute({ bindContext: assert.fail }, "action:action-1", "action-1",
    "approveAction", { actionID: "action-1" }), /could not be verified/);
});

test("canonical recovery reconciles an unscoped legacy attempt before permitting another write", async () => {
  const recovery = workflowRecovery();
  const pending = recovery.load();
  const parameters = { actionID: "action-1", expectedModifiedAt: "reviewed", note: null };
  pending.remember("action:action-1", "legacy-1", "action-1", "approveAction", parameters);
  pending.initialize(Promise.resolve({ userId: "buyerD01", origin: "https://purchasing.example" }));
  let result: any = null;
  const model = { bindContext: (path: string) => {
    assert.equal(path, "/commandResult(...)", "An unresolved legacy attempt must not trigger a fresh write");
    return {
      setParameter: () => {}, invoke: async () => {},
      getBoundContext: () => ({ getObject: () => result }), destroy: () => {},
    };
  } };
  await assert.rejects(pending.execute(model, "action:action-1", "action-1", "approveAction", parameters), /still unknown/);
  assert.equal(recovery.storage.size, 1);
  result = { actionID: "action-1", payloadMatched: true };
  assert.equal((await pending.execute(model, "action:action-1", "action-1", "approveAction", parameters)).actionID, "action-1");
  assert.equal(recovery.storage.size, 0);
});

test("canonical consumer suppresses simultaneous clicks and reconciles a committed lost response", async () => {
  const recovery = workflowRecovery();
  const pending = recovery.load();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  let reads = 0;
  let destroyed = 0;
  const model = { bindContext: (path: string) => ({
    setParameter: () => undefined,
    invoke: async () => {
      if (path === "/commandResult(...)") { reads++; return; }
      writes++;
      await gate;
      throw new Error("Committed response lost");
    },
    getBoundContext: () => ({ getObject: () => ({ caseID: "case-1", actionID: "action-1" }) }),
    destroy: () => { destroyed++; },
  }) };
  const first = pending.execute(model, "case:case-1", "case-1", "prepareCaseAction",
    { caseID: "case-1", expectedModifiedAt: "reviewed", expectedFingerprint: "evidence" });
  await assert.rejects(pending.execute(model, "case:case-1", "case-1", "prepareCaseAction", {}), /still in flight/);
  assert.equal(writes, 1);
  release();
  assert.equal((await first).actionID, "action-1");
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(destroyed, 2);
  assert.equal(recovery.storage.size, 0);
});

test("prediction evidence is embedded without a recheck command or editable unsaved horizon", () => {
  const fragment = readFileSync(
    "app/purchasing-desk/webapp/ext/prevention/Assessment.fragment.xml",
    "utf8",
  );
  assert.doesNotMatch(
    fragment,
    /Recheck Evidence|Workspace\.assess|<Button|<StepInput/,
  );
  assert.match(fragment, /prevention>\/assessment\/metrics/);
  assert.match(fragment, /Background prediction evidence is not yet available/);
});

test("price page does not label non-alert, uncalibrated or fallback estimates as model triggers", () => {
  const assessment = {
    source: "tabpfn",
    alert: true,
    calibrationStatus: "calibrated",
    expectedP10: 8,
    expectedP50: 10,
    expectedP90: 12,
  };
  for (const override of [
    { alert: false },
    { calibrationStatus: "uncalibrated" },
    { source: "fallback" },
  ]) {
    const price = workspace().state("PriceDeviations", {
      ...base,
      unitPrice: 20,
      assessment: { ...assessment, ...override },
    });
    assert.equal(price.modelTrigger, false);
    assert.doesNotMatch(price.banner, /TabPFN flagged/);
  }
  const missing = workspace().state("PriceDeviations", {
    ...base,
    unitPrice: 20,
  });
  assert.equal(missing.hasModel, false);
  assert.equal(missing.priceQuantiles[1].value, "Not available");
  assert.equal(
    workspace().state("DuplicateMaterials", { ...base }).pricePage,
    false,
  );
});

test("price model evidence survives generic assessment state and duplicate predictions attach to candidates", () => {
  const price = workspace().state("PriceDeviations", {
    ...base,
    unitPrice: 20,
    priorMedian: 8,
    assessment: {
      source: "tabpfn",
      expectedP10: 8,
      expectedP50: 10,
      expectedP90: 12,
      calibrationStatus: "calibrated",
      alert: true,
    },
  });
  assert.equal(price.priceModel.expectedP50, 10);
  assert.equal(price.modelAI, true);
  assert.match(price.modelDeviation, /100% above/);
  assert.match(price.banner, /TabPFN flagged/);
  assert.equal(price.modelTrigger, true);
  assert.equal(price.priceQuantiles[1].value, "10");
  assert.ok(
    price.priceModelFacts.some(
      (entry: any) => entry.label === "Case creation basis",
    ),
  );
  assert.ok(
    price.priceEmpiricalFacts.some(
      (entry: any) => entry.label === "Comparison scope",
    ),
  );
  const duplicate = workspace().state("DuplicateMaterials", {
    ...base,
    Material: "A",
    candidateCount: 2,
    candidates: [
      { label: "A", similarityScore: 100 },
      { label: "B", similarityScore: 95 },
    ],
    assessmentJson: JSON.stringify({
      source: "mixed",
      status: "available",
      metrics: [
        {
          label: "B: MRPType",
          current: "ND",
          value: "PD",
          source: "tabpfn",
          detail: {
            limitation: "Peer plausibility only",
            probabilities: { PD: 0.75, ND: 0.25 },
          },
        },
      ],
    }),
  });
  assert.equal(duplicate.lines[1].similarityText, "95%");
  assert.equal(duplicate.lines[1].predictionText, "MRPType: PD");
  assert.equal(duplicate.lines[0].hasPrediction, false);
  assert.equal(duplicate.hasCandidatePredictions, true);
  assert.equal(duplicate.lines[0].similarityText, "Reference");
  assert.equal(duplicate.lines[1].planningFields[0].currentText, "ND");
  assert.equal(duplicate.lines[1].planningFields[0].valueText, "PD");
  assert.equal(
    duplicate.lines[1].planningFields[0].support,
    "75% model confidence",
  );
  assert.equal(duplicate.lines[1].planningFields[0].ai, true);
  assert.equal(
    duplicate.lines[1].predictionComparisonText,
    "MRP type: PD (current ND; 75% model confidence)",
  );
  assert.equal(duplicate.ordersChart.kind, "candidateActivity");
  assert.equal(duplicate.ordersChart.metric, "orders");
  assert.equal(duplicate.movementsChart.metric, "movements");
  assert.equal(duplicate.ordersChart.rows.length, duplicate.lines.length);
});

test("prevention links preserve business-key separators through hash routing", () => {
  const exported = { exports: {} as any };
  runInNewContext(
    readFileSync("app/purchasing-desk/webapp/ext/CaseNavigation.js", "utf8"),
    { module: exported },
  );
  for (const [key, entity] of [
    ["price:4500000797/200", "PriceDeviations"],
    ["duplicate:ERSA:30000229", "DuplicateMaterials"],
    ["rare:10000252|DE11", "UnusualSettings"],
    ["pdt:10000158|19000001|DE11", "SupplierPlannedTimes"],
    ["mm_pdt:10000087|DE11", "MaterialPlannedTimes"],
  ]) {
    const hash = exported.exports.caseHash(key);
    assert.equal(
      hash,
      `#${entity}('${encodeURIComponent(encodeURIComponent(key))}')`,
    );
    assert.ok(!decodeURIComponent(hash).includes("4500000797/200"));
  }
});

test("prevention assessments preserve zero values and distinguish empirical, fallback and model evidence", () => {
  const assessment = {
    status: "available",
    source: "mixed",
    assessmentID: "retained",
    metrics: [
      {
        label: "Model",
        current: 0,
        value: { p10: 0, p50: 5, p90: 10 },
        source: "tabpfn",
        unit: "days",
      },
      {
        label: "Observed",
        current: 0,
        value: 0,
        source: "empirical",
        unit: "days",
      },
      { label: "Fallback", value: null, source: "fallback" },
    ],
  };
  const result = workspace().state("SupplierPlannedTimes", {
    ...base,
    currentDays: 5,
    proposedDays: 10,
    assessmentJson: JSON.stringify(assessment),
    detail: JSON.stringify({
      settingRange: {
        source: "tabpfn",
        p10: 8,
        p50: 10,
        p80: 12,
        p90: 14,
        contextRows: 30,
        runID: "independent-run",
      },
      rangeSource: "empirical",
      rangeP10: 6,
      rangeP50: 9,
      rangeP80: 11,
      rangeP90: 13,
      rangeCount: 25,
      proposalRule: "ceil(p80) of own lead times",
    }),
  });
  assert.equal(result.canAssess, true);
  assert.equal(result.hasDeliveryEvidence, true);
  assert.equal(
    JSON.stringify(
      result.deliveryEvidence.map((entry: any) => [
        entry.source,
        entry.p50,
        entry.ai,
      ]),
    ),
    JSON.stringify([["TabPFN", 5, true]]),
  );
  assert.equal(result.deliveryEvidence[0].p10, 0);
  assert.equal(result.deliveryEvidence[0].p90, 10);
  assert.equal(result.proposalBasis, "ceil(p80) of own lead times");
  const master = workspace().state("MaterialPlannedTimes", {
    ...base,
    currentDays: 5,
    proposedDays: 10,
    detail: JSON.stringify({
      settingComparison: { value: 10 },
      settingSources: [
        {
          Supplier: "S1",
          range: { source: "tabpfn", p10: 8, p50: 10, p80: 12, p90: 14 },
          empiricalRange: {
            source: "empirical",
            p10: 6,
            p50: 9,
            p80: 11,
            p90: 13,
          },
        },
      ],
    }),
  });
  assert.equal(master.deliveryEvidence.length, 2);
  assert.equal(master.modelComparison, 10);
  assert.equal(result.assessment.ai, true);
  assert.equal(result.assessment.metrics[0].currentText, "0");
  assert.equal(result.assessment.metrics[0].ai, true);
  assert.equal(result.assessment.metrics[1].valueText, "0 days");
  assert.equal(result.assessment.metrics[1].ai, false);
  assert.equal(result.assessment.metrics[2].sourceText, "Fallback (not AI)");
  assert.equal(result.assessment.metrics[2].valueText, "Unavailable");
});

test("malformed assessment does not fabricate evidence and closed cases cannot assess", () => {
  const result = workspace().state("DuplicateMaterials", {
    ...base,
    assessmentJson: "invalid",
  });
  assert.equal(result.assessment, null);
  assert.match(result.assessmentError, /could not be read/);
  assert.equal(
    workspace().state("UnusualSettings", { ...base, caseStatus: "closed" })
      .canAssess,
    false,
  );
});

test("assessment presentation formats probabilities and explains model provenance without raw JSON", () => {
  const result = workspace().state("UnusualSettings", {
    ...base,
    assessmentJson: JSON.stringify({
      status: "available",
      source: "tabpfn",
      metrics: [
        {
          label: "Late",
          value: 0.25,
          unit: "probability",
          source: "tabpfn",
          detail: {
            peerRows: 30,
            asOf: "2026-10-01",
            runID: "run-1",
            limitation: "Requires review",
            probabilities: { PD: 0.75, ND: 0.25 },
          },
        },
      ],
    }),
  });
  assert.equal(result.assessment.metrics[0].valueText, "25%");
  assert.match(result.assessment.metrics[0].detailText, /PD \(75%\)/);
  assert.match(result.assessment.metrics[0].detailText, /Peer records: 30/);
  assert.match(result.assessment.metrics[0].detailText, /Requires review/);
  assert.match(
    result.assessment.metrics[0].detailText,
    /Prediction run: run-1/,
  );
});

test("delivery history binds raw dates and suppresses placeholder references without losing evidence", async () => {
  const model = new Model();
  const stored: Record<string, any> = {};
  const history = {
    observedReceipts: 30,
    typicalDays: 8.5,
    plannedDays: 999,
    plannedDaysFlag: "placeholder",
    deliveries: [
      {
        purchaseOrder: "PO1",
        item: "10",
        available: "2026-09-01",
        ordered: "2026-08-20",
        leadTimeDays: 0,
      },
      { available: "invalid", leadTimeDays: 9 },
      { available: "2026-09-02", leadTimeDays: null },
    ],
  };
  const context = {
    getPath: () => "/DeliveryRisks('current')",
    getModel: () => ({
      bindContext: () => ({
        invoke: () => Promise.resolve(),
        getBoundContext: () => ({
          requestObject: () => Promise.resolve(history),
        }),
      }),
    }),
  };
  let inherited = false;
  const box = {
    getId: () => "deliveryHistoryBox",
    getModel: () => model,
    getBindingContext: () => (inherited ? undefined : context),
    getParent: () => ({ getBindingContext: () => context }),
    data: function (key: string, value?: any) {
      if (arguments.length > 1) stored[key] = value;
      return stored[key];
    },
  };
  const section = moduleOf("../finding/DeliveryHistorySection", {
    "sap/ui/model/json/JSONModel": Model,
    "sap/ui/core/format/DateFormat": {
      getDateInstance: () => ({
        format: (value: Date) => value.toISOString().slice(0, 10),
      }),
    },
  });
  section.onContextChange({ getSource: () => box });
  await flush();
  assert.equal(model.data.chart.points.length, 1);
  assert.equal(model.data.chart.points[0].x, Date.parse("2026-09-01"));
  assert.equal(model.data.chart.points[0].y, 0);
  assert.equal(model.data.chart.median, 8.5);
  assert.equal(model.data.chart.planned, null);
  assert.match(model.data.plannedText, /placeholder/);
  assert.equal(model.data.deliveries.length, 3);
  assert.match(model.data.chartScope, /1 of 30/);
  inherited = true;
  section.onRetry({ getSource: () => box });
  await flush();
  assert.equal(model.data.state, "loaded");
  assert.equal(model.data.chart.points.length, 1);
});

test("price retains datetimes, zero-valued prices and deviation direction", () => {
  const state = workspace().state("PriceDeviations", {
    ...base,
    unitPrice: 0.08,
    priorMedian: 0.8,
    currency: "EUR",
    priceHistory: [
      { date: "2026-09-01", amount: 0, label: "Earlier" },
      { date: "2026-09-30", amount: 0.08, label: "Current", isCurrent: true },
      { date: "invalid", amount: 5 },
      { date: "2026-09-02", amount: null },
    ],
  });
  assert.equal(state.deviation, "90% below");
  assert.equal(state.chart.points.length, 2);
  assert.equal(state.chart.points[0].y, 0);
  assert.equal(state.chart.points[1].x, Date.parse("2026-09-30"));
  assert.equal(state.hasModel, false);
  assert.equal(state.canPrepare, true);
});

test("duplicate activity totals stay separate and incomplete evidence disables decisions", () => {
  const input = {
    ...base,
    candidateCount: 2,
    Material: "M1",
    candidates: [
      { label: "M1", n1: 0, n2: 3 },
      { label: "M2", n1: 4, n2: 5 },
    ],
  };
  const state = workspace().state("DuplicateMaterials", input);
  assert.equal(state.orders, 4);
  assert.equal(state.movements, 8);
  assert.equal(state.lines[0].reference, true);
  const partial = workspace().state("DuplicateMaterials", {
    ...input,
    candidateCount: 3,
  });
  assert.equal(partial.orders, null);
  assert.equal(partial.movements, null);
  assert.equal(partial.canPrepare, false);
  assert.equal(partial.canAccept, false);
  const missing = workspace().state("DuplicateMaterials", {
    ...input,
    candidates: [{ label: "M1", n1: null, n2: 0 }, input.candidates[1]],
  });
  assert.equal(missing.orders, null);
  assert.equal(missing.movements, 5);
});

test("rare settings preserve observed intersections without inferred percentages", () => {
  const state = workspace().state("UnusualSettings", {
    ...base,
    unusualPairCount: 1,
    groupSize: 20,
    settingPairs: [{ label: "MRP / Lot size", n1: 7, n2: 9, n3: 0 }],
  });
  assert.equal(state.chart.rows[0].count, 0);
  assert.equal(state.canAccept, true);
  assert.ok(state.facts.every((fact: any) => !fact.value.includes("%")));
  assert.equal(
    workspace().state("UnusualSettings", {
      ...base,
      unusualPairCount: 1,
      settingPairs: [{ n3: null }],
    }).chart,
    null,
  );
});

test("ranges require valid quantiles and material delta is proposed minus current", () => {
  const input = {
    ...base,
    currentDays: 0,
    proposedDays: 4,
    rangeP10: 0,
    rangeP50: 2,
    rangeP80: 3,
    rangeP90: 4,
    rangeSource: "empirical",
  };
  assert.equal(workspace().state("SupplierPlannedTimes", input).hasRange, true);
  assert.equal(
    workspace().state("SupplierPlannedTimes", { ...input, rangeP10: null })
      .hasRange,
    false,
  );
  assert.equal(
    workspace().state("SupplierPlannedTimes", { ...input, rangeP80: 5 })
      .hasRange,
    false,
  );
  const state = workspace().state("MaterialPlannedTimes", {
    ...base,
    currentDays: 9,
    proposedDays: 4,
    tolerance: 2,
  });
  assert.equal(state.delta, "-5");
  assert.equal(state.chart.tolerance, 2);
  assert.equal(state.hasRange, false);
});

test("closed cases, missing fingerprints and active reviews disable new decisions", () => {
  for (const row of [
    { ...base, caseStatus: "closed" },
    { ...base, header: {} },
    {
      ...base,
      caseActions: [
        { action_ID: "action-id", action: { status: "needs_decision" } },
      ],
    },
  ]) {
    const state = workspace().state("MaterialPlannedTimes", row);
    assert.equal(state.canPrepare, false);
    assert.equal(state.canAccept, false);
  }
  const active = workspace().state("MaterialPlannedTimes", {
    ...base,
    caseActions: [{ action_ID: "action-id", action: { status: "waiting" } }],
  });
  assert.equal(active.actionHref, "#/Actions(action-id)");
});

test("late requests cannot overwrite the next case and failures disable decisions", async () => {
  const pending: {
    resolve: (row: any) => void;
    reject: (error: any) => void;
    destroyed: boolean;
  }[] = [];
  const model = new Model();
  const view = {
    isA: () => true,
    getModel: () => model,
    setModel: () => {},
    isDestroyed: () => false,
  };
  const api = workspace();
  function source(path: string) {
    const context = {
      getPath: () => path,
      getObject: () => ({ caseSourceRevision: 1 }),
      getModel: () => ({
        bindContext: () => {
          const request = {
            resolve: (_row: any) => {},
            reject: (_error: any) => {},
            destroyed: false,
          };
          const promise = new Promise((resolve, reject) => {
            request.resolve = resolve;
            request.reject = reject;
          });
          pending.push(request);
          return {
            requestObject: () => promise,
            destroy: () => {
              request.destroyed = true;
            },
          };
        },
      }),
    };
    return {
      getSource: () => ({
        isA: () => false,
        getParent: () => view,
        getBindingContext: () => context,
        getModel: () => undefined,
        setModel: (assigned: unknown, name: string) => {
          assert.equal(assigned, model);
          assert.equal(name, "prevention");
        },
      }),
    };
  }
  api.onContextChange(source("/PriceDeviations('first')"));
  api.onContextChange(source("/MaterialPlannedTimes('second')"));
  pending[1]!.resolve({ ...base, currentDays: 3, proposedDays: 8 });
  await flush();
  pending[0]!.resolve({ ...base, unitPrice: 100 });
  await flush();
  assert.equal(model.data.entity, "MaterialPlannedTimes");
  api.onContextChange(source("/SupplierPlannedTimes('failed')"));
  pending[2]!.reject(new Error("Unavailable"));
  await flush();
  assert.match(model.data.error, /could not be loaded/);
  assert.equal(model.data.canPrepare, false);
  assert.ok(pending.every((request) => request.destroyed));
});

test("charts use datetime scatter, separate activity series and a factual tolerance band", () => {
  let definition: any;
  const chart = moduleOf("EvidenceChart", {
    "sap/ui/core/Control": {
      extend: (_name: string, settings: any) => {
        definition = settings;
        return function () {};
      },
    },
    "sap/ui/core/theming/Parameters": {
      get: () => ({ sapFontFamily: "SAP Font", sapTextColor: "#123456" }),
    },
    "sap/ui/core/format/DateFormat": {
      getDateInstance: () => ({
        format: (value: Date) => value.toISOString().slice(0, 10),
      }),
    },
    "sap/ui/core/format/NumberFormat": {
      getFloatInstance: () => ({ format: String }),
    },
    "highcharts/esm/highcharts": {
      color: () => ({
        setOpacity: () => ({ get: () => "rgba(0,112,242,0.08)" }),
      }),
    },
  });
  const price = chart.options({
    kind: "price",
    median: 0.8,
    points: [
      { x: 1, y: 0, current: false },
      { x: 2, y: 0.08, current: true },
    ],
  });
  assert.equal(price.xAxis.type, "datetime");
  assert.equal(price.series[0].data[0].y, 0);
  assert.equal(price.series[1].marker.symbol, "diamond");
  assert.equal(price.yAxis.plotLines[0].value, 0.8);
  const activity = chart.options({
    kind: "activity",
    rows: [{ label: "M1", orders: 0, movements: 5 }],
  });
  assert.equal(activity.series.length, 2);
  assert.equal(activity.series[0].data[0], 0);
  const setting = chart.options({
    kind: "setting",
    current: 4,
    proposed: 9,
    tolerance: 2,
  });
  assert.equal(setting.xAxis.plotBands[0].from, 2);
  assert.equal(setting.xAxis.plotBands[0].to, 6);
  assert.equal(setting.series[1].data[0].x, 4);
  assert.equal(setting.series[2].data[0].x, 9);
  assert.equal(setting.series[1].data[0].y, setting.series[2].data[0].y);
  const tiny = chart.options({
    kind: "price",
    unit: "EUR",
    median: 0.0012,
    points: [{ x: Date.parse("2026-10-01"), y: 0.001, name: "PO/item" }],
  });
  assert.ok(tiny.yAxis.max < 0.002);
  assert.ok(tiny.yAxis.min > 0);
  assert.match(
    tiny.tooltip.formatter.call(tiny.series[0].data[0]),
    /0.001 EUR/,
  );
  assert.equal(
    chart.options({ kind: "setting", current: -1, proposed: 2 }).series.length,
    0,
  );
  for (const value of [0, 0.00001, 12]) {
    const flat = chart.options({
      kind: "price",
      median: value,
      points: [{ x: 1, y: value }],
    });
    assert.ok(flat.yAxis.min >= 0 && flat.yAxis.min <= value);
    assert.ok(flat.yAxis.max > value);
    const equal = chart.options({
      kind: "setting",
      current: value,
      proposed: value,
    });
    assert.equal(equal.series[1].data[0].x, equal.series[2].data[0].x);
    assert.match(equal.tooltip.formatter(), /Change: 0 days/);
  }
  const decrease = chart.options({
    kind: "setting",
    current: 9.5,
    proposed: 0,
  });
  assert.equal(decrease.series[0].data[0].x, 0);
  assert.equal(decrease.series[0].data[1].x, 9.5);
  assert.match(decrease.tooltip.formatter(), /Change: -9.5 days/);
  assert.equal(
    workspace().state("MaterialPlannedTimes", {
      ...base,
      currentDays: -1,
      proposedDays: 2,
    }).chart,
    null,
  );
  assert.ok(definition.onBeforeRendering && definition.exit);
  const history = chart.options({
    kind: "deliveryHistory",
    median: 8.5,
    planned: 7,
    points: [
      { x: Date.parse("2026-10-01"), y: 0, name: "PO/item" },
      { x: NaN, y: 3 },
      { x: 1, y: null },
    ],
  });
  assert.equal(history.xAxis.type, "datetime");
  assert.equal(history.series[0].data.length, 1);
  assert.equal(history.series[0].data[0].y, 0);
  assert.equal(history.yAxis.plotLines[0].value, 8.5);
  assert.equal(history.yAxis.plotLines[1].value, 7);
  assert.equal(history.series[0].color, "#0f828f");
  const scenarios = chart.options({
    kind: "scenarioDelay",
    points: [{ x: Date.parse("2026-10-01"), y: 12, name: "P50" }],
  });
  assert.equal(scenarios.series[0].dataLabels.enabled, false);
  assert.equal(scenarios.series[0].data[0].name, "P50");
  const delays = chart.options({
    kind: "delayBars",
    title: "Customer delays",
    unit: "calendar days",
    rows: [
      { label: "SO 1", value: 2 },
      { label: "SO 2", value: 7 },
      { label: "SO 3", value: null },
    ],
  });
  assert.equal(delays.chart.type, "bar");
  assert.equal(delays.yAxis.title.text, "calendar days");
  assert.deepEqual(Array.from(delays.xAxis.categories), ["SO 2", "SO 1"]);
});

test("dialogs require trimmed input, submit once and retain the reviewed fingerprint", async () => {
  const controls: any[] = [];
  let refreshes = 0;
  let dialog: any;
  let finish!: () => void;
  const calls: any[] = [];
  class Control {
    value: string | number = "";
    busy = false;
    destroyed = false;
    closed = false;
    constructor(public settings: any) {
      controls.push(this);
      this.value = settings.value ?? "";
    }
    addStyleClass() {
      return this;
    }
    getValue() {
      return this.value;
    }
    setValueState() {}
    setValueStateText() {}
    setEnabled() {}
    setInitialFocus() {}
    getBusy() {
      return this.busy;
    }
    setBusy(value: boolean) {
      this.busy = value;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    open() {
      dialog = this;
    }
    close() {
      this.closed = true;
    }
  }
  class Input extends Control {}
  class TextArea extends Control {}
  const model = new Model();
  model.data = workspace().state("PriceDeviations", {
    ...base,
    header_ID: "price:DIALOG",
    header: { ...base.header, modifiedAt: "2026-10-04T00:00:00.000Z" },
    caseTitle: "Price finding",
  });
  const context = {
    getPath: () => "/PriceDeviations('price')",
    getModel: () => ({
      refresh: () => {
        refreshes += 1;
      },
      bindContext: () => {
        const parameters: any = {};
        return {
          setParameter: (name: string, value: unknown) => {
            parameters[name] = value;
          },
          invoke: () => {
            calls.push(parameters);
            return new Promise<void>((resolve) => {
              finish = resolve;
            });
          },
          getBoundContext: () => ({ getObject: () => ({ caseID: parameters.caseID }) }),
          destroy: () => {},
        };
      },
    }),
  };
  const view = {
    getModel: (name: string) =>
      name === "workflow"
        ? context.getModel()
        : name === "i18n"
          ? { getResourceBundle: () => ({ getText: (key: string) => key }) }
          : model,
    getBindingContext: () => context,
    addDependent: () => {},
  };
  const modules: Record<string, any> = {};
  for (const name of ["Dialog", "VBox", "Text", "Label", "Button", "StepInput"])
    modules[`sap/m/${name}`] = Control;
  modules["sap/m/Input"] = Input;
  modules["sap/m/TextArea"] = TextArea;
  modules["sap/m/MessageBox"] = { error: assert.fail, warning: assert.fail };
  modules["sap/m/MessageToast"] = { show: () => {} };
  modules["sap/base/util/uid"] = () => "ui-command-1";
  modules["sap/ui/Device"] = { system: { phone: false } };
  modules["tide/cockpit/ext/prevention/Workspace"] = {
    viewOf: () => view,
    reload: () => Promise.resolve(),
  };
  const decisions = moduleOf("Decisions", modules);
  decisions.prepare({
    getSource: () => ({ getBindingContext: () => null }),
  });
  dialog.settings.beginButton.settings.press();
  assert.equal(calls.length, 0);
  const responsiblePerson = controls.find(
    (control) => control instanceof Input,
  );
  const responsibleMessage = controls.find(
    (control) => control instanceof TextArea,
  );
  assert.ok(responsiblePerson);
  assert.ok(responsibleMessage);
  responsiblePerson.value = " Buyer D01 ";
  responsibleMessage.value = " Please clarify ";
  model.data.fingerprint = "unreviewed-new-fingerprint";
  dialog.settings.beginButton.settings.press();
  dialog.settings.beginButton.settings.press();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(refreshes, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    expectedFingerprint: "reviewed",
    caseID: "price:DIALOG",
    expectedModifiedAt: "2026-10-04T00:00:00.000Z",
    commandID: "ui-command-1",
    responsiblePerson: "Buyer D01",
    responsibleMessage: "Please clarify",
  });
  finish();
  await flush();
  assert.equal(refreshes, 1);
  assert.equal(dialog.closed, true);
  assert.equal(model.data.busy, false);
  model.data = workspace().state("SupplierPlannedTimes", {
    ...base,
    header_ID: "pdt:SUPPLIER",
    header: { ...base.header, modifiedAt: "2026-10-04T00:00:00.000Z" },
    caseTitle: "Supplier duration",
    currentDays: 5,
    proposedDays: 12,
  });
  const supplierDecisions = moduleOf("Decisions", modules);
  supplierDecisions.prepare({
    getSource: () => ({ getBindingContext: () => null }),
  });
  const duration = controls.find((control) => control.settings.min === 1);
  assert.equal(duration.value, 12);
  const count = calls.length;
  for (const value of [0, 5, 366, 2.5]) {
    duration.value = value;
    dialog.settings.beginButton.settings.press();
    assert.equal(calls.length, count);
  }
  duration.value = 21;
  model.data.fingerprint = "new-evidence";
  dialog.settings.beginButton.settings.press();
  dialog.settings.beginButton.settings.press();
  await flush();
  assert.equal(calls.length, count + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
    expectedFingerprint: "reviewed",
    days: 21,
    caseID: "pdt:SUPPLIER",
    expectedModifiedAt: "2026-10-04T00:00:00.000Z",
    commandID: "ui-command-1",
  });
  finish();
  await flush();
});

test("supplier reload recovery stores only identity, reconciles in a new module and retains unknown outcomes", async () => {
  const saved = new Map<string, any>();
  class Storage {
    static Type = { session: "session" };
    put(key: string, value: any) {
      saved.set(key, value);
      return true;
    }
    get(key: string) {
      return saved.get(key);
    }
    remove(key: string) {
      saved.delete(key);
      return true;
    }
  }
  const original = moduleOf("../shared/WorkflowPending", {
    "sap/ui/util/Storage": Storage,
  });
  original.remember("case:pdt:RELOAD", "reload-command", "pdt:RELOAD");
  assert.deepEqual(JSON.parse(JSON.stringify(saved.get("case:pdt:RELOAD"))), {
    commandID: "reload-command",
    target: "pdt:RELOAD",
  });
  const restored = moduleOf("../shared/WorkflowPending", {
    "sap/ui/util/Storage": Storage,
  });
  let result: any = null;
  let destroyed = 0;
  const model = {
    bindContext: (path: string) => {
      assert.equal(path, "/commandResult(...)");
      return {
        setParameter: (name: string, value: string) => {
          assert.equal(name, "commandID");
          assert.equal(value, "reload-command");
        },
        invoke: async () => {},
        getBoundContext: () => ({ getObject: () => result }),
        destroy: () => destroyed++,
      };
    },
  };
  await assert.rejects(
    restored.reconcile(model, "case:pdt:RELOAD", "pdt:RELOAD"),
    /still unknown/,
  );
  assert.equal(saved.size, 1);
  result = { caseID: "pdt:FOREIGN" };
  await assert.rejects(
    restored.reconcile(model, "case:pdt:RELOAD", "pdt:RELOAD"),
    /still unknown/,
  );
  assert.equal(saved.size, 1);
  result = { caseID: "pdt:RELOAD" };
  await restored.reconcile(model, "case:pdt:RELOAD", "pdt:RELOAD");
  assert.equal(saved.size, 0);
  assert.equal(destroyed, 3);
});

test("supplier uncertain responses reconcile and retain frozen command identity across retry and reopen", async () => {
  const controls: any[] = [];
  const calls: any[] = [];
  const errors: string[] = [];
  let dialog: any;
  let identity = 0;
  let mode = "unknown";
  let refreshed = 0;
  class Control {
    value: any;
    busy = false;
    destroyed = false;
    enabled = true;
    constructor(public settings: any) {
      this.value = settings.value ?? "";
      controls.push(this);
    }
    addStyleClass() {
      return this;
    }
    getValue() {
      return this.value;
    }
    setValueState() {}
    setValueStateText() {}
    setInitialFocus() {}
    setEnabled(value: boolean) {
      this.enabled = value;
    }
    getBusy() {
      return this.busy;
    }
    setBusy(value: boolean) {
      this.busy = value;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    open() {
      dialog = this;
    }
    close() {
      this.settings.afterClose();
    }
  }
  const model = new Model();
  model.data = workspace().state("SupplierPlannedTimes", {
    ...base,
    header_ID: "pdt:RETRY",
    header: { ...base.header, modifiedAt: "2026-10-04T00:00:00.000Z" },
    currentDays: 2,
    proposedDays: 14,
  });
  const workflow = {
    bindContext: (path: string) => {
      const parameters: Record<string, unknown> = {};
      const call = { path, parameters, destroyed: false };
      return {
        setParameter: (name: string, value: unknown) => {
          parameters[name] = value;
        },
        invoke: async () => {
          calls.push(call);
          if (path === "/commandResult(...)") {
            if (mode !== "committed")
              throw Object.assign(new Error("Receipt unavailable"), {
                status: 404,
              });
          } else {
            throw Object.assign(
              new Error(
                mode === "rejected" ? "Stale version" : "Connection lost",
              ),
              mode === "rejected" ? { status: 409 } : {},
            );
          }
        },
        getBoundContext: () => ({ getObject: () => ({ caseID: "pdt:RETRY" }) }),
        destroy: () => {
          call.destroyed = true;
        },
      };
    },
  };
  const context = {
    getPath: () => "/SupplierPlannedTimes('retry')",
    getModel: () => ({
      refresh: () => {
        refreshed += 1;
      },
    }),
  };
  const view = {
    getModel: (name: string) =>
      name === "workflow"
        ? workflow
        : name === "i18n"
          ? { getResourceBundle: () => ({ getText: (key: string) => key }) }
          : model,
    getBindingContext: () => context,
    addDependent: () => {},
  };
  const modules: Record<string, any> = {};
  for (const name of [
    "Dialog",
    "VBox",
    "Text",
    "Label",
    "Button",
    "StepInput",
    "TextArea",
    "Input",
  ])
    modules[`sap/m/${name}`] = Control;
  modules["sap/base/util/uid"] = () => `retry-${++identity}`;
  modules["sap/ui/Device"] = { system: { phone: false } };
  modules["sap/m/MessageBox"] = {
    error: (message: string) => errors.push(message),
    warning: assert.fail,
  };
  modules["sap/m/MessageToast"] = { show: () => {} };
  modules["tide/cockpit/ext/prevention/Workspace"] = {
    viewOf: () => view,
    reload: () => Promise.resolve(),
  };
  const decisions = moduleOf("Decisions", modules);
  const event = { getSource: () => ({ getBindingContext: () => context }) };
  decisions.prepare(event);
  dialog.settings.beginButton.settings.press();
  await flush();
  assert.equal(identity, 1);
  assert.equal(refreshed, 0);
  assert.equal(errors.length, 1);
  assert.equal(
    controls.find((control) => control.settings.min === 1).enabled,
    false,
  );
  dialog.settings.endButton.settings.press();
  model.data.fingerprint = "unreviewed-new-evidence";
  decisions.prepare(event);
  mode = "committed";
  dialog.settings.beginButton.settings.press();
  await flush();
  assert.equal(identity, 1);
  assert.equal(refreshed, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls[0].parameters)),
    JSON.parse(JSON.stringify(calls[2].parameters)),
  );
  assert.equal(calls[2].parameters.expectedFingerprint, "reviewed");
  assert.equal(calls[3].parameters.commandID, "retry-1");
  assert.ok(calls.every((call) => call.destroyed));
  mode = "rejected";
  decisions.prepare(event);
  dialog.settings.beginButton.settings.press();
  await flush();
  assert.equal(identity, 2);
  const duration = controls
    .filter((control) => control.settings.min === 1)
    .at(-1);
  assert.equal(duration.enabled, true);
  duration.value = 21;
  dialog.settings.beginButton.settings.press();
  await flush();
  assert.equal(identity, 3);
  assert.equal(calls.at(-2).parameters.days, 21);
});

const outcomePolicies: Array<[string, string[]]> = [
  ["delivery_intervention", ["confirmed", "resolved_elsewhere"]],
  ["delivery_escalation", ["escalated", "resolved_elsewhere"]],
  ["price_clarification", ["confirmed", "resolved_elsewhere"]],
  ["master_data_duplicate_review", ["confirmed", "resolved_elsewhere"]],
  ["planner_review", ["confirmed", "posted", "resolved_elsewhere"]],
  ["pdt_change", ["posted", "resolved_elsewhere"]],
  ["requisition_review", ["posted", "resolved_elsewhere"]],
];
for (const [operation, resolutions] of outcomePolicies)
  for (const completeness of ["unknown", "partial", "complete"])
    test(`${operation} UI records explicit ${completeness} completion with only qualifying outcomes`, async () => {
      let dialog: any;
      class Control {
        settings: any;
        value = "";
        constructor(settings: any) { this.settings = settings; }
        addStyleClass() { return this; }
        open() { dialog = this; }
        close() {}
        destroy() {}
        getSelectedKey() { return this.settings.selectedKey; }
        getValue() { return this.value; }
      }
      class Select extends Control {}
      class Input extends Control {}
      const state = new Model();
      state.data = { id: "generic-action", modifiedAt: "displayed-version",
        workflowPilot: true, supplierPosting: false, operationKey: operation,
        items: [{ target: "reviewed-object" }] };
      const calls: Array<{ path: string; parameters: Record<string, unknown> }> = [];
      const workflow = { bindContext: (path: string) => {
        const parameters: Record<string, unknown> = {};
        return {
          setParameter: (name: string, value: unknown) => { parameters[name] = value; },
          invoke: () => { calls.push({ path, parameters }); return Promise.resolve(); },
          getBoundContext: () => ({ getObject: () => ({ actionID: "generic-action" }) }),
          destroy: () => {},
        };
      } };
      const context = { getPath: () => null, getModel: () => ({ refresh: () => {} }),
        requestProperty: assert.fail };
      let navigatedAway = false;
      const api = { refresh: () => { navigatedAway = true; }, editFlow: { invokeAction: assert.fail } };
      const view = { isA: () => true, setModel: () => {},
        getController: () => ({ getExtensionAPI: () => api }) };
      const box = {
        getId: () => "test-approvalWorkspace", getParent: () => view, isA: () => false,
        getBindingContext: () => navigatedAway ? null : context, data: () => {},
        getModel: (name: string) => name === "approval" ? state : name === "workflow" ? workflow :
          { getResourceBundle: () => ({ getText: (key: string) => key }) },
      };
      const modules: Record<string, any> = {
        "sap/ui/model/json/JSONModel": Model,
        "sap/ui/core/format/DateFormat": { getDateTimeInstance: () => ({}), getDateInstance: () => ({}) },
        "sap/m/Select": Select, "sap/m/Input": Input,
        "sap/m/MessageBox": { error: assert.fail }, "sap/base/util/uid": () => "outcome-ui-1",
        "tide/cockpit/ext/shared/WorkflowPending": workflowRecovery().load(() => "outcome-ui-1"),
      };
      for (const name of ["Button", "Dialog", "Label"])
        modules[`sap/m/${name}`] = Control;
      modules["sap/ui/core/Item"] = Control;
      const approval = moduleOf("../approvals/ApprovalWorkspace", modules);
      approval.onLogOutcome({ getSource: () => box });
      const outcome = dialog.settings.content[1];
      assert.deepEqual(Array.from(outcome.settings.items, (item: any) => item.settings.key), resolutions);
      const completion = dialog.settings.content.find((control: any) =>
        control instanceof Select && control !== outcome);
      assert.equal(completion.getSelectedKey(), "unknown");
      completion.settings.selectedKey = completeness;
      dialog.settings.content.find((control: any) => control instanceof Input).value = " Checked reference ";
      dialog.settings.beginButton.settings.press();
      await flush();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/recordActionOutcome(...)");
      assert.deepEqual(calls[0].parameters, {
        actionID: "generic-action", commandID: "outcome-ui-1", expectedModifiedAt: "displayed-version",
        resolution: resolutions[0], completeness, note: "Checked reference",
      });
    });

test("supplier approval keeps the displayed version and same command through uncertain response reconciliation", async () => {
  const approval = new Model();
  approval.data = {
    state: "loaded",
    id: "supplier-action",
    modifiedAt: "2026-10-04T00:00:00.000Z",
    workflowPilot: true,
  };
  const calls: any[] = [];
  const errors: string[] = [];
  let mode = "unknown";
  let identities = 0;
  let refreshed = 0;
  const workflow = {
    bindContext: (path: string) => {
      const parameters: Record<string, unknown> = {};
      const call = { path, parameters, destroyed: false };
      return {
        setParameter: (name: string, value: unknown) => {
          parameters[name] = value;
        },
        invoke: async () => {
          calls.push(call);
          if (path === "/commandResult(...)" && mode === "committed") return;
          throw new Error("Connection lost");
        },
        getBoundContext: () => ({
          getObject: () => ({ actionID: "supplier-action" }),
        }),
        destroy: () => {
          call.destroyed = true;
        },
      };
    },
  };
  const service = {
    refresh: () => {
      refreshed += 1;
    },
    bindContext: () => ({
      requestObject: async () => ({
        ID: "supplier-action",
        status: "waiting",
        summary: "Reviewed change",
        modifiedAt: "2026-10-04T02:00:00.000Z",
      }),
      destroy: () => {},
    }),
    bindList: () => ({ requestContexts: async () => [], destroy: () => {} }),
  };
  const context = {
    getPath: () => "/Actions('supplier-action')",
    getModel: () => service,
    requestProperty: assert.fail,
  };
  const api = { editFlow: { invokeAction: assert.fail }, refresh: () => {} };
  const view = {
    isA: () => true,
    getController: () => ({ getExtensionAPI: () => api }),
    setModel: () => {},
  };
  const box = {
    getId: () => "test-approvalWorkspace",
    isA: () => false,
    getParent: () => view,
    getBindingContext: () => context,
    getModel: (name: string) => (name === "workflow" ? workflow : approval),
    data: () => null,
  };
  const workspace = moduleOf("../approvals/ApprovalWorkspace", {
    "sap/ui/model/json/JSONModel": Model,
    "sap/ui/core/format/DateFormat": {
      getDateTimeInstance: () => ({ format: String }),
      getDateInstance: () => ({ format: String }),
    },
    "sap/base/util/uid": () => `approval-${++identities}`,
    "tide/cockpit/ext/shared/WorkflowPending": workflowRecovery().load(() => `approval-${++identities}`),
    "sap/m/MessageBox": { error: (message: string) => errors.push(message) },
  });
  const event = { getSource: () => box };
  workspace.onApprove(event);
  workspace.onApprove(event);
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(approval.data.busy, false);
  assert.equal(refreshed, 0);
  assert.equal(identities, 1);
  assert.equal(
    calls[0].parameters.expectedModifiedAt,
    "2026-10-04T00:00:00.000Z",
  );
  approval.data.modifiedAt = "2026-10-04T01:00:00.000Z";
  mode = "committed";
  workspace.onApprove(event);
  await flush();
  assert.equal(identities, 1);
  assert.equal(refreshed, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls[0].parameters)),
    JSON.parse(JSON.stringify(calls[2].parameters)),
  );
  assert.equal(calls[3].parameters.commandID, "approval-1");
  assert.ok(calls.every((call) => call.destroyed));
});
