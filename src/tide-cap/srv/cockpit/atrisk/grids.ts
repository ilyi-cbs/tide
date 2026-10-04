// Line grids (morning, arrival, receipt) and the reads shared by the at-risk
// use cases: own lead times, open items, late-rate rows, names, the plant
// context sample and the one quantile run per plant.
import cds from "@sap/cds";
import { chanceAfter, modelArrival, openArrival } from "../kernel/arrival";
import { daysBetween } from "../kernel/calendar";
import {
  NS,
  awaitRun,
  callCore,
  estimate,
  inTx,
  meterRun,
  runResults,
  type Meter,
  type Row,
} from "../kernel/model-calls";
import type { Source } from "../kernel/types";
import { predictionSource } from "../kernel/prediction-source";
import { PREDICTION_PROFILES } from "../kernel/prediction-profiles";
import { sourceFeedRows } from "../kernel/source-ranges";
import {
  LEVELS,
  PLANT_CONTEXT_ROWS,
  gapDays,
  gridFrom,
  gridSummary,
  pdtFlag,
  plantSample,
  serializeGrid,
  type Grid,
} from "./domain/rules";
import {
  NOTE_TEXT,
  arrivalSentence,
  chanceSentence,
  chanceWords,
  rangeSentence,
  rangeWords,
} from "./domain/texts";

const { SELECT } = cds.ql;
const LOG = cds.log("cockpit.atrisk");

export const FEED = PREDICTION_PROFILES.openItem.feed;
/** P-1 features in feed names (PlannedDays = PlannedDeliveryDurationInDays). */
export const FEATURES = [...PREDICTION_PROFILES.openItem.features];
export const CTX_OWN = "own history";
export const CTX_PLANT = "plant sample";
export const GRID_ENTITY = `${NS}.LineGrid`;
export const FACT = `${NS}.ItemFact`;
/** Live facts (feed hooks): the view over the current tide.s4 rows. */
export const FACT_LIVE = `${NS}.ItemFactSource`;

export type GridTrigger = "morning" | "arrived" | "receipt";
export const skey = (m: string, s: string, p: string) => `${m}|${s}|${p}`;
export const itemKey = (r: {
  PurchaseOrder?: unknown;
  PurchaseOrderItem?: unknown;
}) => `${r.PurchaseOrder}/${r.PurchaseOrderItem}`;
export const iso = (d: unknown) => (d ? String(d).slice(0, 10) : null);
export const numOrNull = (v: unknown) =>
  v === null || v === undefined || v === "" ? null : Number(v);

/**
 * One LineGrid row with the buyer texts of its range (the section binds
 * them; the UI computes nothing). Requested gap and planned marker belong to
 * the item, so they are stored with its grid. `open` dates the range for the
 * item still open at `open.asOf`; `pool` (within `open`) is past lead times
 * for the survivor fallback when the grid's own tail is already passed.
 */
export function lineGridRow(
  item: Row,
  grid: Grid,
  source: Source,
  nOwn: number,
  contextLevel: string,
  snapshotId: string | null,
  trigger: GridTrigger = "morning",
  open: {
    asOf: string;
    pool?: readonly number[];
    ageConditioned?: boolean;
  } | null = null,
  evidence: {
    own?: Grid | null;
    agreement?: "aligned" | "divergent" | null;
    runID?: string | null;
    inputFingerprint?: string | null;
    backend?: string | null;
    trainingRows?: number | null;
    fallback?: string | null;
  } = {},
) {
  const sum = gridSummary(grid);
  const req = iso(item.RequestedDate);
  const po = iso(item.PurchaseOrderDate);
  const gap = req && po ? gapDays(po, req) : null;
  const planned = numOrNull(item.PlannedDays);
  const flag = pdtFlag(planned);
  const markPlanned =
    flag === "not_maintained" || flag === "placeholder" ? null : planned;
  return {
    PurchaseOrder: item.PurchaseOrder,
    PurchaseOrderItem: item.PurchaseOrderItem,
    snapshot_ID: snapshotId,
    Material: item.Material ?? null,
    Supplier: item.Supplier ?? null,
    Plant: item.Plant ?? null,
    source,
    nOwn,
    levels: serializeGrid(grid),
    ...sum,
    contextLevel,
    atriskTrigger: trigger,
    atriskComputedAt: new Date().toISOString(),
    atriskGapDays: gap,
    atriskPlannedDays: markPlanned,
    atriskSentence: rangeSentence(source, nOwn, sum),
    atriskWords: rangeWords(sum, gap, markPlanned),
    atriskNote: NOTE_TEXT[trigger],
    ownLevels: evidence.own ? serializeGrid(evidence.own) : null,
    ...(evidence.own
      ? Object.fromEntries(
          Object.entries(gridSummary(evidence.own)).map(([key, value]) => [
            `own${key[0].toUpperCase()}${key.slice(1)}`,
            value,
          ]),
        )
      : {}),
    agreement: evidence.agreement ?? null,
    modelRun_ID: evidence.runID ?? null,
    modelInputFingerprint: evidence.inputFingerprint ?? null,
    modelBackend: evidence.backend ?? null,
    modelTrainingRows: evidence.trainingRows ?? null,
    modelFallback: evidence.fallback ?? null,
    ...(open
      ? openFields(
          po,
          req,
          grid,
          source,
          open.asOf,
          open.pool ?? [],
          open.ageConditioned,
        )
      : {}),
  };
}
export type LineGridRow = ReturnType<typeof lineGridRow>;

/** Arrival of the still-open item at `asOf` (kernel/arrival) and its buyer texts. */
function openFields(
  po: string | null,
  req: string | null,
  grid: Grid,
  source: Source,
  asOf: string,
  pool: readonly number[],
  ageConditioned = false,
) {
  const model = source === "tabpfn" || source === "fake";
  const a =
    ageConditioned && model
      ? modelArrival(po, grid, asOf)
      : openArrival(po, grid, asOf, model ? [] : pool);
  const age = po ? Math.max(0, daysBetween(po, asOf)) : 0;
  const gap = req && po ? gapDays(po, req) : null;
  const chance =
    gap !== null && req! >= asOf ? chanceAfter(a.grid, gap, age) : null;
  const lateDays = a.p50 && req ? daysBetween(req, a.p50) : null;
  return {
    arrivalAsOf: asOf,
    openLevels: a.grid ? serializeGrid(a.grid) : null,
    openBasis: a.basis,
    openSource: (a.basis === "grid"
      ? source
      : a.basis === "survivors"
        ? "empirical"
        : "none") as Source,
    arrivalP10: a.p10,
    arrivalP50: a.p50,
    arrivalP80: a.p80,
    arrivalP90: a.p90,
    ownArrivalP10: null as string | null,
    ownArrivalP50: null as string | null,
    ownArrivalP90: null as string | null,
    arrivalLateDays: lateDays,
    chanceLate: chance,
    chanceWords: chanceWords(chance),
    chanceText: chanceSentence(chance),
    arrivalText: arrivalSentence({
      basis: a.basis,
      p10: a.p10,
      p50: a.p50,
      p90: a.p90,
      requested: req,
      lateDays,
    }),
  };
}

/** Own lead times per source (> 0 days, ordered and received before asOf), in receipt order. */
export async function histories(
  asOf: string,
  entity = FACT,
  only?: { Material: string; Supplier: string; Plant: string },
) {
  const q = SELECT.from(entity).columns(
    "Material",
    "Supplier",
    "Plant",
    "LeadTimeDays",
  )
    .where`LeadTimeDays > 0 and AvailableDate < ${asOf} and PurchaseOrderDate < ${asOf} and Material != ''`.orderBy(
    "AvailableDate",
    "PurchaseOrder",
    "PurchaseOrderItem",
  );
  if (only) q.where(only);
  const rows: Row[] = await q;
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const k = skey(r.Material, r.Supplier, r.Plant);
    (out.get(k) ?? out.set(k, []).get(k)!).push(Number(r.LeadTimeDays));
  }
  return out;
}

export const ITEM_COLUMNS = [
  "PurchaseOrder",
  "PurchaseOrderItem",
  "Material",
  "MaterialGroup",
  "MaterialType",
  "Plant",
  "Supplier",
  "PurchasingGroup",
  "MRPController",
  "OrderQuantity",
  "NetAmount",
  "NetAmountEUR",
  "PlannedDays",
  "PurchaseOrderDate",
  "RequestedDate",
  "AvailableDate",
];

/** Open items ordered before asOf (every one gets a grid; candidates also need no receipt before asOf). */
export async function openItems(asOf: string, entity = FACT): Promise<Row[]> {
  return SELECT.from(entity).columns(...ITEM_COLUMNS)
    .where`IsOpen = true and PurchaseOrderDate < ${asOf}`.orderBy(
    "PurchaseOrder",
    "PurchaseOrderItem",
  );
}

/** Rows for the historical late rates (domain lateRates filters the window). */
export async function rateRows(asOf: string, entity = FACT) {
  return (await SELECT.from(entity).columns(
    "Plant",
    "PurchaseOrderDate",
    "RequestedDate",
    "AvailableDate as ReceiptDate",
    "PlannedDays",
  ).where`RequestedDate is not null and PurchaseOrderDate < ${asOf}`) as any[];
}

export async function names(
  materials: string[],
  suppliers: string[],
  plants: string[] = [],
) {
  const m = [...new Set(materials.filter(Boolean))];
  const s = [...new Set(suppliers.filter(Boolean))];
  const p = [...new Set(plants.filter(Boolean))];
  const mats: Row[] = m.length
    ? await SELECT.from("tide.s4.ProductDescription")
        .columns("Product", "ProductDescription")
        .where({ Language: "EN", Product: { in: m } })
    : [];
  const sups: Row[] = s.length
    ? await SELECT.from("tide.s4.Supplier")
        .columns("Supplier", "SupplierName")
        .where({ Supplier: { in: s } })
    : [];
  const plts: Row[] = p.length
    ? await SELECT.from("tide.s4.Plant")
        .columns("Plant", "PlantName")
        .where({ Plant: { in: p } })
    : [];
  return {
    material: new Map(
      mats.map((r) => [r.Product, r.ProductDescription as string]),
    ),
    supplier: new Map(sups.map((r) => [r.Supplier, r.SupplierName as string])),
    plant: new Map(plts.map((r) => [r.Plant, r.PlantName as string])),
  };
}
export type Names = Awaited<ReturnType<typeof names>>;

/** Plant context sample (P-0): 2,500 rows, seed 1, sorted by PO/item; keys and the plant's row count. */
async function contextKeys(
  asOf: string,
  plant: string,
  ageDays = 0,
  entity = FACT,
): Promise<{ keys: string[]; total: number }> {
  const rows: Row[] = await SELECT.from(entity).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
  )
    .where`Plant = ${plant} and LeadTimeDays > ${ageDays} and AvailableDate < ${asOf} and PurchaseOrderDate < ${asOf}`;
  return {
    keys: plantSample(rows as any[], PLANT_CONTEXT_ROWS).map(itemKey),
    total: rows.length,
  };
}

/** Dataset spec of the plant's quantile run (19 levels; key filter only when the plant is sampled down). */
export function gridSpec(
  plant: string,
  asOf: string,
  predictKeys: string[],
  context: string[],
  ageDays = 0,
) {
  return {
    feed: FEED,
    target: "LeadTimeDays",
    features: FEATURES,
    task: "regression",
    train: {
      filter: [
        { col: "Plant", op: "=", value: plant },
        { col: "LeadTimeDays", op: ">", value: String(ageDays) },
        { col: "AvailableDate", op: "<", value: asOf },
        { col: "PurchaseOrderDate", op: "<", value: asOf },
        ...(context.length ? [{ col: "id", op: "in", values: context }] : []),
      ],
    },
    predict: { keys: predictKeys },
    output: { type: "quantiles", levels: LEVELS },
  };
}

export interface ModelGrid {
  grid: Grid;
  source: Source;
  ageConditioned: boolean;
  runID: string | null;
  inputFingerprint: string | null;
  backend: string | null;
  trainingRows: number | null;
  fallback: string | null;
}

/**
 * One quantile run per plant and overdue-age group (dry run: estimate only,
 * nothing returned). A refused call (budget, 429) is rethrown; other
 * failures are recorded on the meter and leave those lines without a grid.
 */
export async function modelGrids(
  byPlant: Map<string, Row[]>,
  asOf: string,
  dryRun: boolean,
  meter: Meter,
): Promise<Map<string, ModelGrid>> {
  const out = new Map<string, ModelGrid>();
  const groups = new Map<
    string,
    { plant: string; ageDays?: number; lines: Row[] }
  >();
  for (const [plant, lines] of byPlant) {
    for (const item of lines) {
      const requested = iso(item.RequestedDate);
      const ordered = iso(item.PurchaseOrderDate);
      const ageDays =
        requested && ordered && requested < asOf
          ? Math.max(0, daysBetween(ordered, asOf))
          : undefined;
      const groupKey = `${plant}|${ageDays ?? "ordinary"}`;
      const group: { plant: string; ageDays?: number; lines: Row[] } =
        groups.get(groupKey) ?? { plant, ageDays, lines: [] };
      group.lines.push(item);
      groups.set(groupKey, group);
    }
  }
  const pending: {
    plant: string;
    ageDays?: number;
    runId: string;
    cached: boolean;
    lines: Row[];
  }[] = [];
  for (const { plant, lines, ageDays: overdueAge } of groups.values()) {
    let ageDays = overdueAge;
    let context = await inTx(() => contextKeys(asOf, plant, ageDays, dryRun ? FACT_LIVE : FACT));
    if (ageDays !== undefined && context.keys.length < 2) {
      ageDays = undefined;
      context = await inTx(() => contextKeys(asOf, plant, 0, dryRun ? FACT_LIVE : FACT));
    }
    if (context.keys.length < 2) {
      LOG.info(`plant ${plant}: no lead time history, no model grid`);
      continue;
    }
    const spec = gridSpec(
      plant,
      asOf,
      lines.map(itemKey),
      context.keys.length < context.total ? context.keys : [],
      ageDays,
    );
    if (dryRun) {
      await estimate(meter, `at risk grids ${plant}`, spec, await sourceFeedRows());
      continue;
    }
    try {
      const run: any = await callCore(meter.user, "predict", { spec });
      pending.push({
        plant,
        ageDays,
        runId: run.ID,
        cached: run.status === "succeeded",
        lines,
      });
    } catch (e: any) {
      if (e?.status === 429 || e?.code === 429 || e?.code === "BUDGET_EXCEEDED")
        throw e;
      LOG.warn(`at risk grids ${plant} not started:`, e?.code ?? e?.message);
      meter.failed.push(`at risk grids ${plant}: ${e?.code ?? "INTERNAL"}`);
    }
  }
  for (const p of pending) {
    const run = await awaitRun(meter.user, p.runId);
    meter.runs.push(p.runId);
    if (run.status !== "succeeded") {
      meter.failed.push(`at risk grids ${p.plant}: ${run.errorCode}`);
      continue;
    }
    meterRun(meter, run, p.cached);
    const [results, full] = await inTx(() =>
      Promise.all([
        runResults(p.runId),
        SELECT.one
          .from("tide.core.PredictionRun")
          .columns("fallback", "backend", "trainRows", "inputFingerprint")
          .where({ ID: p.runId }),
      ]),
    );
    const source: Source = predictionSource(full);
    if (source === "none") continue;
    for (const i of p.lines) {
      const q = results.get(itemKey(i));
      if (q)
        out.set(itemKey(i), {
          grid: gridFrom(q),
          source,
          ageConditioned: p.ageDays !== undefined,
          runID: p.runId,
          inputFingerprint: (full as any)?.inputFingerprint ?? null,
          backend: (full as any)?.backend ?? null,
          trainingRows: (full as any)?.trainRows ?? null,
          fallback: (full as any)?.fallback ?? null,
        });
    }
  }
  return out;
}
