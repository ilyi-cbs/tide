// Model-facing results expose allowlisted fields and withhold uncalibrated
// scores and expert-only data. UI cards remain serialized for the agent artifact.

export const MAX_MODEL_ROWS = 10;

export const UNCALIBRATED = new Set([
  "p_late",
  "pLate",
  "probability",
  "score",
  "confidence",
  "expected_value_at_risk",
  "expectedValueAtRisk",
]);

export const EXPERT_ONLY = new Set([
  "expert",
  "issueTechnical",
  "technicalChain",
  "levels",
  "contextRows",
  "contextLevel",
  "auc",
  "top10Hits",
  "modelCalls",
  "costUnits",
  "latencyMs",
  "rightOf100",
  "backtestRun_ID",
  "predictionRun_ID",
]);

export const PROPOSAL_KEYS = [
  "field",
  "value",
  "text",
  "status",
  "source",
] as const;

/** Keys a row may keep for the model (buyer words, keys, dates, days, counts). */
export const ROW_KEYS = new Set([
  // identity and links
  "ID",
  "id",
  "findingID",
  "caseID",
  "rank",
  "priority",
  "list",
  "listText",
  "objectKey",
  "link",
  "PurchaseOrder",
  "PurchaseOrderItem",
  "PurchaseRequisition",
  "PurchaseRequisitionItem",
  "Material",
  "MaterialText",
  "Supplier",
  "SupplierName",
  "SupplierRegion",
  "Plant",
  "PurchasingGroup",
  "MRPController",
  "MaterialGroup",
  // buyer words of a finding
  "itemTitle",
  "itemSubtitle",
  "issue",
  "impactLevel",
  "impactText",
  "impactCriticality",
  "revenueAtRisk",
  "currency",
  "dueDate",
  "nextStep",
  "nextActionKind",
  "source",
  "sourceText",
  "chain",
  "status",
  "listing",
  "attention",
  "closure",
  "trigger",
  "arrivedAt",
  "phase",
  "typedEntitySet",
  "typedKey",
  // dates and days
  "PurchaseOrderDate",
  "RequestedDate",
  "expectedDate",
  "cautiousDate",
  "confirmedDate",
  "needDate",
  "predictedArrival",
  "sourceRevision",
  "delayDays",
  "customerDelayDays",
  "shortageFrom",
  "shortageDays",
  "coverageDays",
  "productionOrders",
  "salesOrders",
  "customers",
  "materialKind",
  "plannedDays",
  "currentDays",
  "proposalDays",
  "p10",
  "p50",
  "p80",
  "p90",
  "p10Days",
  "p50Days",
  "p90Days",
  "n",
  "nOwn",
  "verdict",
  "reason",
  "note",
  // simulators and planning grids
  "quantile",
  "label",
  "lateShare",
  "meanBufferDays",
  "meanDaysLate",
  "nOlder",
  "nLater",
  "isCurrent",
  "leadTimeDays",
  "latestOrderDate",
  "earliestDelivery",
  "reachable",
  "within",
  "of",
  "safetyStock",
  "safetyStockValue",
  "threshold",
  "prefilledShare",
  "accuracy",
  "low",
  "high",
  "isStored",
  // code proposals, similar requests
  "field",
  "value",
  "text",
  "similarity",
  "similarText",
  "similarTotal",
  "similarRequests",
  "materialSources",
  "materialSourcesTotal",
  // actions (public view)
  "kind",
  "title",
  "summary",
  "preparedVia",
  "createdAt",
  "line",
  "oldValue",
  "newValue",
  "where",
  "items",
  "level",
  // counts
  "dim1",
  "dim2",
  "count",
  "key",
  "amount",
  // case and day details (get_case, get_today)
  "date",
  "quantity",
  "origin",
  "daysOverdue",
  "workingDays",
  "unitPrice",
  "usualPrice",
  "nPrior",
  "direction",
  "members",
  "activity",
  "groupSize",
  "orders",
  "movements",
  "materialsWithFirst",
  "materialsWithSecond",
  "materialsWithBoth",
  "currentFrom",
  "masterDays",
  "rule",
  "fieldText",
  "statusText",
  "similarSame",
  "orderShare",
  "typicalDays",
  "infoRecordDays",
  "freetextText",
  "freetextCodes",
  "meaning",
  "atRisk",
  "codesPrefilled",
  "codesTotal",
  "pdtFindings",
  "pendingApprovals",
]);

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isProposal = (r: Obj) =>
  "value" in r && "status" in r && ("confidence" in r || "rightOf100" in r);

function row(r: Obj): Obj {
  if (isProposal(r)) {
    const out: Obj = {};
    for (const k of PROPOSAL_KEYS)
      if (r[k] !== null && r[k] !== undefined) out[k] = r[k];
    return out;
  }
  const rule = r.source === "rule";
  const out: Obj = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) continue;
    if (UNCALIBRATED.has(k)) {
      if (rule) out[k] = v;
      continue;
    }
    if (!ROW_KEYS.has(k)) continue;
    out[k] = Array.isArray(v)
      ? v.slice(0, MAX_MODEL_ROWS).map((x) => (isObj(x) ? row(x) : x))
      : isObj(v)
        ? row(v)
        : v;
  }
  return out;
}

/** Reduced copy of a tool result for the model (see the header). */
export function modelView(value: Json): Json {
  if (Array.isArray(value))
    return value
      .slice(0, MAX_MODEL_ROWS)
      .map((v) => (isObj(v) ? row(v) : modelView(v)));
  if (!isObj(value)) return value;
  const rule = value.source === "rule";
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined || EXPERT_ONLY.has(k)) continue;
    if (UNCALIBRATED.has(k) && !rule) continue;
    if (k === "card") {
      out.card = typeof v === "string" ? v : JSON.stringify(v);
      continue;
    }
    // Nested objects and list rows keep the fixed row keys only.
    out[k] = Array.isArray(v) ? modelView(v) : isObj(v) ? row(v) : v;
    if (Array.isArray(v) && v.length > MAX_MODEL_ROWS)
      out[`${k}Shown`] = `first ${MAX_MODEL_ROWS} of ${v.length}`;
  }
  return out;
}

// ------------------------------------------------------------------ turn checks

/**
 * End-of-turn checks the agent runs on every answer (P-9, NS-J1): the texts
 * and patterns live here, the agent only applies them. Served by
 * AssistantRuntimeService.profile().checks.
 */
export const TURN_CHECKS = {
  noAction: "No action was prepared.",
  /** Sentence claims a prepared action ... */
  actionClaim: String.raw`\b(draft|reminder|change list|code list|worklist|export|action)s?\b[^.\n]*\b(created|prepared|drafted|added|ready|waits|waiting|queued|submitted)\b|\b(created|prepared|drafted|added|ready|waits|waiting|queued|submitted)\b[^.\n]*\b(draft|reminder|change list|code list|worklist|export|action)s?\b`,
  /** ... unless it is negated. */
  negation: String.raw`\b(no|not|never|cannot|can't|didn't|won't|without)\b`,
  /** Omit warnings that expose model internals from quoted output. */
  expertWarning: String.raw`tabpfn|\bmodel\b|quantile|\bp\d0\b|context|\bauc\b|confidence|calls?\b`,
  /** Result fields the answer must quote word for word: always, or only on these verdicts. */
  quote: [
    { field: "error" },
    { field: "warnings" },
    { field: "realityCheck" },
    { field: "answer", whenVerdict: ["fail", "too little"] },
  ],
};
