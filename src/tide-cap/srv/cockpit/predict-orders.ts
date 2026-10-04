// predict_orders (chat, P-8): I/O around the pure core in ./predict-logic.ts.
// The strict form is a 400 before any model call; the reality check (context
// known at the cutoff) runs first and — only on a pass — the prediction for
// the open items. Both model runs go through callCore (queue, run records,
// budget guard) on CockpitPredictFeed, whose rows this question
// writes first and removes afterwards. 0 calls with too little history, 1 on
// a failed check, 2 on a pass. The result is stored on the PredictionQuestion
// (chatResult) for "Add to worklist".
import cds from "@sap/cds";
import { predictionSource } from "./kernel/prediction-source";
import {
  NS,
  awaitRun,
  callCore,
  runResults,
  type Row,
} from "./kernel/model-calls";
import { round as roundTo } from "./kernel/stats";
import { fail } from "./kernel/errors";
import { datasetInfo } from "./prepare";
import { scopeOf as buyerScopeOf, inScope } from "./kernel/auth";
import {
  LEVELS,
  PREDICT_FEATURES,
  chatResult,
  enough,
  features as featureRow,
  gate as gateOf,
  knownValues,
  ownPastDeliveries,
  parseRequest,
  plan as planOf,
  rank as rankOf,
  resolveFilters,
  type Item,
  type Labelled,
  type RankedRow,
  type Request as PredictRequest,
} from "./predict-logic";

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const round3 = (x: number) => roundTo(x, 3);
const LOG = cds.log("cockpit");

async function update(ID: string, data: Row) {
  await cds.tx(() => UPDATE.entity(`${NS}.PredictionQuestion`, ID).with(data));
}

export const PREDICT_FEED = "CockpitPredictFeed";
/** Longest wait for one model run (cds.env.requires.tabular.predictRunMs, read at call time). */
const runTimeoutMs = () =>
  Number((cds.env.requires as any)?.tabular?.predictRunMs ?? 10 * 60_000);

/** First schedule line per PO item with what the features and labels need. */
async function loadItems(): Promise<Item[]> {
  const rows: Row[] = await cds.tx(() =>
    SELECT.from(`${NS}.ItemFact`).columns(
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Material",
      "Supplier",
      "Plant",
      "PurchasingGroup",
      "MaterialType",
      "MaterialGroup",
      "SupplierCountry",
      "PlannedDays",
      "OrderQuantity",
      "NetAmountEUR",
      "PurchaseOrderDate",
      "RequestedDate",
      "AvailableDate",
      "PartialFirstReceipt",
      "IsOpen",
    ),
  );
  return rows
    .filter((r) => r.PurchaseOrderDate)
    .map((r) => ({
      ...r,
      id: `${r.PurchaseOrder}/${r.PurchaseOrderItem}`,
      PurchaseOrderDate: String(r.PurchaseOrderDate).slice(0, 10),
      RequestedDate: r.RequestedDate
        ? String(r.RequestedDate).slice(0, 10)
        : null,
      AvailableDate: r.AvailableDate
        ? String(r.AvailableDate).slice(0, 10)
        : null,
      PlannedDays: r.PlannedDays == null ? null : Number(r.PlannedDays),
      OrderQuantity: r.OrderQuantity == null ? null : Number(r.OrderQuantity),
      NetAmountEUR: r.NetAmountEUR == null ? null : Number(r.NetAmountEUR),
    })) as Item[];
}

const classification = (req: PredictRequest) => req.target !== "lead_time_days";

function feedRows(
  question: string,
  role: "backtest" | "predict",
  ctx: Labelled[],
  rows: Item[],
  past: Map<string, number>,
  asOfFor: (i: Item) => Partial<Item>,
  req: PredictRequest,
) {
  const out: Row[] = [];
  const add = (i: Item, kind: "c" | "t", y: number | null) => {
    const f = featureRow(i, past.get(i.id) ?? 0, asOfFor(i));
    out.push({
      rowKey: `${question}|${role}${kind}|${i.id}`,
      question,
      role: role + kind,
      ...f,
      yClass: classification(req) && y !== null ? (y ? "yes" : "no") : null,
      yDays: !classification(req) && y !== null ? y : null,
    });
  };
  for (const c of ctx) add(c.item, "c", c.y);
  for (const i of rows) add(i, "t", null);
  return out;
}

function feedSpec(
  question: string,
  role: string,
  keys: string[],
  req: PredictRequest,
) {
  return {
    feed: PREDICT_FEED,
    target: classification(req) ? "yClass" : "yDays",
    features: [...PREDICT_FEATURES],
    task: classification(req) ? "classification" : "regression",
    train: {
      filter: [
        { col: "question", op: "=", value: question },
        { col: "role", op: "=", value: `${role}c` },
      ],
    },
    predict: { keys },
    output: classification(req)
      ? { type: "probas" }
      : { type: "quantiles", levels: LEVELS },
  };
}

/** Runs one prediction on the feed; per key the positive-class probability or [p10, p50, p90]. */
async function score(
  user: cds.User,
  question: string,
  role: string,
  keys: string[],
  req: PredictRequest,
) {
  const run: any = await callCore(user, "predict", {
    spec: feedSpec(question, role, keys, req),
  });
  const done = await awaitRun(user, run.ID, runTimeoutMs());
  if (done.status !== "succeeded") {
    throw fail(
      502,
      `The prediction service could not answer (${done.errorMessage ?? done.errorCode ?? "failed"})`,
    );
  }
  const results = await cds.tx(() => runResults(run.ID));
  if (
    keys.some(
      (key) =>
        !results.has(key) ||
        !results.get(key)?.length ||
        !results.get(key)!.every(Number.isFinite),
    )
  )
    throw fail(
      502,
      "The prediction service returned incomplete scores; no probabilities were invented",
    );
  return {
    runId: run.ID as string,
    scores: keys.map(
      (k) => results.get(k) ?? (classification(req) ? [0] : [0, 0, 0]),
    ),
  };
}

/** Scope of the caller for the predict form (Buyers, T8b; none = all). */
async function scopeOf(user: cds.User) {
  const b = await cds.tx(() =>
    SELECT.one.from(`${NS}.Buyer`).where({ userId: user.id }),
  );
  const scope = buyerScopeOf(user);
  return scope.isAdmin
    ? { plant: null, purchasingGroup: null }
    : {
        plant: scope.Plant ?? b?.Plant ?? null,
        purchasingGroup: scope.PurchasingGroup ?? b?.PurchasingGroup ?? null,
      };
}

const link = (r: Row) =>
  r.PurchaseOrder && r.PurchaseOrder !== "(new order)"
    ? `#/DeliveryRisks('${encodeURIComponent(encodeURIComponent(`delivery:${r.PurchaseOrder}/${r.PurchaseOrderItem}`))}')`
    : null;

/** Predict on request for the chat (tool predict_orders). */
/** The strict form, the resolved filters and the plan: 400 before any model call. */
async function prepareQuestion(user: cds.User, data: Row) {
  const raw: Row = {};
  for (const k of Object.keys(data ?? {}))
    if (data[k] !== null && data[k] !== undefined) raw[k] = data[k];
  let req: PredictRequest;
  try {
    req = parseRequest(raw);
  } catch (e: any) {
    throw fail(400, e.message);
  }
  const asOf: string | null = (await cds.tx(() => datasetInfo()))?.asOf ?? null;
  if (!asOf) throw fail(409, "No dataset is loaded (run the loader first)");
  const callerScope = buyerScopeOf(user);
  const items = (await loadItems()).filter((item) =>
    inScope(callerScope, item),
  );
  const buyers: Row[] = await cds.tx(() => SELECT.from(`${NS}.Buyer`));
  let filters;
  try {
    filters = resolveFilters(
      req,
      knownValues(items, asOf),
      await scopeOf(user),
      buyers as any,
    );
    if (
      (callerScope.Plant &&
        filters.plant &&
        callerScope.Plant !== filters.plant) ||
      (callerScope.PurchasingGroup &&
        filters.purchasingGroup &&
        callerScope.PurchasingGroup !== filters.purchasingGroup)
    )
      throw new Error("The requested scope is outside your purchasing scope");
    if (callerScope.Plant) filters.plant = callerScope.Plant;
    if (callerScope.PurchasingGroup)
      filters.purchasingGroup = callerScope.PurchasingGroup;
  } catch (e: any) {
    throw fail(400, e.message);
  }
  return {
    req,
    filters,
    plan: planOf(items, req, filters, asOf),
    past: ownPastDeliveries(items),
  };
}

/** The reality check, then (on a pass) the prediction; the model runs 0, 1 or 2 times. */
async function runQuestion(
  user: cds.User,
  ID: string,
  q: Awaited<ReturnType<typeof prepareQuestion>>,
) {
  const { req, plan: p, past } = q;
  let calls = 0;
  let backScores: number[][] | null = null;
  if (enough(req, p)) {
    const rows = feedRows(
      ID,
      "backtest",
      p.backtestContext,
      p.evaluated.map((e) => e.item),
      past,
      () => ({}),
      req,
    );
    await cds.tx(() => INSERT.into(`${NS}.PredictRow`).entries(rows));
    const r = await score(
      user,
      ID,
      "backtest",
      p.evaluated.map((e) => `${ID}|backtestt|${e.item.id}`),
      req,
    );
    calls++;
    backScores = r.scores;
    await update(ID, { backtestRun_ID: r.runId });
  }
  const check = gateOf(req, p.evaluated, p.backtestContext, backScores);
  let ranked: RankedRow[] = [];
  let scoredOrders: Row[] = [];
  let predictionRun: Row | undefined;
  if (p.rows.length) {
    await update(ID, { status: "predicting", openItems: p.openItems });
    const rows = feedRows(
      ID,
      "predict",
      p.context,
      p.rows,
      past,
      () => ({}),
      req,
    );
    await cds.tx(() => INSERT.into(`${NS}.PredictRow`).entries(rows));
    const r = await score(
      user,
      ID,
      "predict",
      p.rows.map((i) => `${ID}|predictt|${i.id}`),
      req,
    );
    calls++;
    ranked = rankOf(p.rows, r.scores, req);
    scoredOrders = p.rows.map((item, index) => ({
      ...item,
      score: r.scores[index]?.[0] ?? null,
    }));
    predictionRun = await cds.tx(() =>
      SELECT.one.from("tide.core.PredictionRun").where({ ID: r.runId }),
    );
    await update(ID, { predictionRun_ID: r.runId });
  }
  return { check, ranked, calls, scoredOrders, predictionRun };
}

/** Predict on request for the chat (tool predict_orders). */
export async function predictOrders(
  user: cds.User,
  data: Row,
  assessment = false,
) {
  const q = await prepareQuestion(user, data);
  const ID = cds.utils.uuid();
  const started = Date.now();
  await cds.tx(() =>
    INSERT.into(`${NS}.PredictionQuestion`).entries({
      ID,
      target: q.req.target,
      lateDays: q.req.lateDays,
      filters: JSON.stringify(q.filters),
      status: "checking",
      cutoff: q.plan.cutoff,
    }),
  );
  let run: Awaited<ReturnType<typeof runQuestion>>;
  try {
    run = await runQuestion(user, ID, q);
  } catch (e) {
    LOG.warn(`predict_orders ${ID} failed:`, e);
    await update(ID, {
      status: "failed",
      verdict: String((e as Error).message).slice(0, 300),
    });
    throw e;
  } finally {
    await cds.tx(() => DELETE.from(`${NS}.PredictRow`).where({ question: ID }));
  }
  const { result, card } = chatResult({
    ID,
    req: q.req,
    filters: q.filters,
    plan: q.plan,
    ...run,
    latencyMs: Date.now() - started,
    link,
  });
  await store(ID, q.req, result, run);
  return {
    ...result,
    ...(assessment
      ? {
          scoredOrders: run.scoredOrders,
          validation: run.check,
          predictionRunID: run.predictionRun?.ID ?? null,
          source: predictionSource(run.predictionRun),
        }
      : {}),
    card: JSON.stringify(card),
  };
}

/** The question's verdict and, for classification, its ranking (the app's Questions page). */
async function store(
  ID: string,
  req: PredictRequest,
  result: Row,
  run: Awaited<ReturnType<typeof runQuestion>>,
) {
  const { check, ranked } = run;
  await update(ID, {
    status:
      result.verdict === "pass"
        ? "passed"
        : result.verdict === "fail"
          ? "refused"
          : "too_little",
    verdict: check.summary.slice(0, 300),
    evaluated: check.evaluated,
    positives: check.positives ?? null,
    auc: check.auc ?? null,
    top10Hits: check.topPositive ?? null,
    mae: check.maeP50 ?? null,
    baselineMae: check.maeBaseline ?? null,
    openItems: result.openItems,
    chatResult: JSON.stringify(result),
  });
  if (!ranked.length || !classification(req)) return;
  await cds.tx(() =>
    INSERT.into(`${NS}.PredictionAnswer`).entries(
      ranked.map((r) => ({
        question_ID: ID,
        rank: r.rank,
        PurchaseOrder: r.item.PurchaseOrder.slice(0, 10),
        PurchaseOrderItem: r.item.PurchaseOrderItem,
        Material: r.item.Material,
        Supplier: r.item.Supplier,
        Plant: r.item.Plant,
        RequestedDate: r.item.RequestedDate,
        score: r.score == null ? null : round3(r.score),
      })),
    ),
  );
}

/** A stored chat prediction of the caller (404 for others). */
export async function readPrediction(user: cds.User, ID: string): Promise<Row> {
  const q: Row | null = await SELECT.one
    .from(`${NS}.PredictionQuestion`)
    .columns("ID", "createdBy", "chatResult")
    .where({ ID });
  if (!q || !q.chatResult || (q.createdBy && q.createdBy !== user.id))
    throw fail(404, `Prediction ${ID} not found`);
  return JSON.parse(q.chatResult);
}
