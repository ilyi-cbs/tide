// Step 3 of prepareDay: ranges for every source with an open item or an
// info record. TabPFN is called only for sources whose inputs changed since
// the last run (fingerprint mismatch or no stored range yet); unchanged
// sources reuse their stored SourceRange grid, so a prepareDay re-run with
// the same dataset and no new history makes no model calls at all. The
// own-history (empirical) range is additionally computed whenever the
// source has >= EMPIRICAL_MIN own lead times, and stored as secondary
// evidence alongside the AI estimate.
import cds from "@sap/cds";
import { createHash } from "node:crypto";
import {
  EMPIRICAL_MIN,
  GRID,
  at,
  empiricalGrid,
  gridFrom,
  type Grid,
} from "../logic";
import {
  FEATURES,
  NS,
  awaitRun,
  callCore,
  estimate,
  forcePrediction,
  meterRun,
  runResults,
  type Meter,
  type Row,
} from "../kernel/model-calls";
import { rangeSpec, representativeItems, sourceFeedRows } from "../kernel/source-ranges";
import { tabularRuntime } from "../../core/tabular-client";
import { predictionSource } from "../kernel/prediction-source";
import { PREDICTION_PROFILES } from "../kernel/prediction-profiles";
import { key, type SourceKey } from "./shared";
import type { Source } from "./histories";

const { SELECT } = cds.ql;

export interface RangeRow {
  Material: string;
  Supplier: string;
  Plant: string;
  source: string;
  nOwn: number;
  contextLevel: string;
  contextRows: number;
  grid: Grid | null;
  run_ID?: string | null;
  /** Own-history (empirical) range, additional evidence when nOwn >= EMPIRICAL_MIN; null otherwise. */
  own: { grid: Grid } | null;
  /** How closely the AI estimate and own history agree; null when there is no second source. */
  agreement: "aligned" | "divergent" | null;
  /** Hash of the inputs this range depended on (own history + representative item key). Unchanged => reused without a model call. */
  fingerprint: string;
  /** Set when this run's grid was reused from the stored SourceRange (no TabPFN call made). */
  reused?: boolean;
}

/**
 * Fingerprints a source's TabPFN inputs: its own lead-time history (which PO
 * items, in what order, with what lead time) plus the representative item
 * picked to stand for it, plus the full plant's training/test feature context
 * and inference settings. Equal fingerprint means the prediction request is
 * semantically unchanged and the stored grid can be reused.
 */
export function sourceFingerprint(
  hist: Source["history"],
  repKey: string | undefined,
  plantContextFingerprint: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        history: hist,
        representative: repKey ?? null,
        plantContextFingerprint,
        features: FEATURES,
        levels: GRID,
      }),
    )
    .digest("hex");
}

/** Hash the plant's current model inputs once, so a changed training context or test-row feature invalidates its cached ranges. */
export async function plantContextFingerprint(
  plant: string,
  asOf: string,
  runtimeIdentity?: string | null,
): Promise<string> {
  const tabular = (cds.env.requires as any).tabular ?? {};
  const identity =
    runtimeIdentity === undefined
      ? await tabularRuntime()
          .then((runtime) => runtime.identity)
          .catch(() => null)
      : runtimeIdentity;
  const rows: Row[] = await SELECT.from(`${NS}.ItemFactSource`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    ...FEATURES,
    "PurchaseOrderDate",
    "AvailableDate",
    "LeadTimeDays",
  ).where`Plant = ${plant}`.orderBy("PurchaseOrder", "PurchaseOrderItem");
  const eligible = rows.filter(
    (r) => r.LeadTimeDays >= 0 && r.AvailableDate && r.AvailableDate < asOf,
  );
  const candidates = rows.filter(
    (r) => r.PurchaseOrderDate && r.PurchaseOrderDate < asOf,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        plant,
        asOf,
        predictionPolicy: PREDICTION_PROFILES.source.version,
        runtimeIdentity: identity,
        features: FEATURES,
        levels: GRID,
        contextLimit: tabular.maxContextRows ?? null,
        sampleSeed: tabular.sampleSeed ?? null,
        dataVersion: process.env.DATA_VERSION ?? "1",
        training: eligible.map((r) => [
          r.PurchaseOrder,
          r.PurchaseOrderItem,
          ...FEATURES.map((f) => r[f]),
          r.AvailableDate,
          r.LeadTimeDays,
        ]),
        candidates: candidates.map((r) => [
          r.PurchaseOrder,
          r.PurchaseOrderItem,
          ...FEATURES.map((f) => r[f]),
        ]),
      }),
    )
    .digest("hex");
}

/** Agreement: own history's p50 within the AI's p10-p90 band (and vice versa) counts as aligned. */
export function rangeAgreement(
  aiGrid: Grid | null,
  ownGrid: Grid | null,
): "aligned" | "divergent" | null {
  if (!aiGrid || !ownGrid) return null;
  const aiP10 = at(aiGrid, 0.1);
  const aiP50 = at(aiGrid, 0.5);
  const aiP90 = at(aiGrid, 0.9);
  const ownP10 = at(ownGrid, 0.1);
  const ownP50 = at(ownGrid, 0.5);
  const ownP90 = at(ownGrid, 0.9);
  if (
    aiP10 === null ||
    aiP50 === null ||
    aiP90 === null ||
    ownP10 === null ||
    ownP50 === null ||
    ownP90 === null
  )
    return null;
  const ownP50InAi = ownP50 >= aiP10 && ownP50 <= aiP90;
  const aiP50InOwn = aiP50 >= ownP10 && aiP50 <= ownP90;
  return ownP50InAi && aiP50InOwn ? "aligned" : "divergent";
}

/** AI (TabPFN) ranges of the given sources from a succeeded range run, with own-history evidence and agreement merged in. */
export async function tabpfnRanges(
  runId: string,
  members: SourceKey[],
  reps: Map<string, string>,
  sources: Map<string, Source>,
  plantContext: string,
) {
  const full: any = await SELECT.one
    .from("tide.core.PredictionRun")
    .columns("backend", "fallback", "trainRows")
    .where({ ID: runId });
  const results = await runResults(runId);
  const ranges = new Map<string, RangeRow>();
  for (const m of members) {
    const k = key(m.Material, m.Supplier, m.Plant);
    const q = results.get(reps.get(k)!);
    if (!q) continue;
    const grid = gridFrom(GRID, q);
    const hist = sources.get(k)?.history ?? [];
    const own =
      hist.length >= EMPIRICAL_MIN
        ? { grid: empiricalGrid(hist.map((h) => h.lt)) }
        : null;
    ranges.set(k, {
      Material: m.Material,
      Supplier: m.Supplier,
      Plant: m.Plant,
      source: predictionSource(full),
      nOwn: hist.length,
      contextLevel: "similar deliveries of the plant",
      contextRows: full?.trainRows ?? 0,
      grid,
      run_ID: runId,
      own,
      agreement: rangeAgreement(grid, own?.grid ?? null),
      fingerprint: sourceFingerprint(hist, reps.get(k), plantContext),
    });
  }
  return { backend: (full?.backend as string | undefined) ?? null, ranges };
}

/** Empirical range of a source with enough own lead times, else null. Used only as a fallback when TabPFN itself has no answer. */
export function empiricalRange(
  n: SourceKey,
  hist: Source["history"],
): RangeRow | null {
  if (hist.length < EMPIRICAL_MIN) return null;
  return {
    Material: n.Material,
    Supplier: n.Supplier,
    Plant: n.Plant,
    source: "empirical",
    nOwn: hist.length,
    contextLevel: "own history of this source",
    contextRows: hist.length,
    grid: empiricalGrid(hist.map((h) => h.lt)),
    own: null,
    agreement: null,
    fingerprint: sourceFingerprint(hist, undefined, "empirical-fallback"),
  };
}

export function rangeRecord(r: RangeRow, snapshotId: string) {
  return {
    Material: r.Material,
    Supplier: r.Supplier,
    Plant: r.Plant,
    snapshot_ID: snapshotId,
    source: r.source,
    nOwn: r.nOwn,
    contextLevel: r.contextLevel,
    contextRows: r.contextRows,
    p10: at(r.grid, 0.1),
    p50: at(r.grid, 0.5),
    p80: at(r.grid, 0.8),
    p90: at(r.grid, 0.9),
    quantiles: r.grid ? JSON.stringify(r.grid) : null,
    run_ID: r.run_ID ?? null,
    fingerprint: r.fingerprint,
    reusedAt: r.reused ? new Date().toISOString() : null,
    ownP10: r.own ? at(r.own.grid, 0.1) : null,
    ownP50: r.own ? at(r.own.grid, 0.5) : null,
    ownP80: r.own ? at(r.own.grid, 0.8) : null,
    ownP90: r.own ? at(r.own.grid, 0.9) : null,
    ownQuantiles: r.own ? JSON.stringify(r.own.grid) : null,
    agreement: r.agreement,
  };
}

/** Reconstructs a RangeRow from its persisted SourceRange record (used to reuse an unchanged range without a model call). */
function fromStored(r: Row): RangeRow {
  const grid: Grid | null = r.quantiles ? JSON.parse(r.quantiles) : null;
  const own: { grid: Grid } | null = r.ownQuantiles
    ? { grid: JSON.parse(r.ownQuantiles) }
    : null;
  return {
    Material: r.Material,
    Supplier: r.Supplier,
    Plant: r.Plant,
    source: r.source,
    nOwn: r.nOwn,
    contextLevel: r.contextLevel,
    contextRows: r.contextRows,
    grid,
    run_ID: r.run_ID ?? null,
    own,
    agreement: r.agreement ?? null,
    fingerprint: r.fingerprint,
    reused: true,
  };
}

/**
 * Ranges. A source's TabPFN/empirical range is recomputed only when its
 * fingerprint (own history + representative item) differs from the stored
 * SourceRange row, or none is stored yet; otherwise the stored grid is
 * reused and no model call is made for that source. This is what lets a
 * prepareDay re-run over an unchanged dataset make zero TabPFN calls.
 */
export async function ranges(
  sources: Map<string, Source>,
  needed: { Material: string; Supplier: string; Plant: string }[],
  asOf: string,
  dryRun: boolean,
  meter: Meter,
): Promise<Map<string, RangeRow>> {
  const out = new Map<string, RangeRow>();
  if (!needed.length) return out;

  const reps = await representativeItems(needed, asOf, dryRun);
  const sourceRows = dryRun ? await sourceFeedRows() : undefined;
  const runtimeIdentity = await tabularRuntime()
    .then((runtime) => runtime.identity)
    .catch(() => null);
  const plantFingerprints = new Map<string, string>();
  for (const plant of new Set(needed.map((n) => n.Plant)))
    plantFingerprints.set(
      plant,
      await plantContextFingerprint(plant, asOf, runtimeIdentity),
    );
  const stored: Row[] = await SELECT.from(`${NS}.SourceRange`).where({
    Material: { in: [...new Set(needed.map((n) => n.Material))] },
  });
  const storedByKey = new Map(
    stored.map((r) => [key(r.Material, r.Supplier, r.Plant), r]),
  );

  const dirty: typeof needed = [];
  for (const n of needed) {
    const k = key(n.Material, n.Supplier, n.Plant);
    const fp = sourceFingerprint(
      sources.get(k)?.history ?? [],
      reps.get(k),
      plantFingerprints.get(n.Plant)!,
    );
    const prior = storedByKey.get(k);
    if (
      !forcePrediction() &&
      runtimeIdentity !== null &&
      prior &&
      prior.source !== "empirical" &&
      prior.fingerprint === fp &&
      prior.quantiles
    )
      out.set(k, fromStored(prior));
    else dirty.push(n);
  }
  if (!dirty.length) return out;

  const byPlant = new Map<string, typeof dirty>();
  for (const s of dirty) {
    if (!reps.has(key(s.Material, s.Supplier, s.Plant))) continue;
    (byPlant.get(s.Plant) ?? byPlant.set(s.Plant, []).get(s.Plant)!).push(s);
  }
  const pending: {
    plant: string;
    runId: string;
    cached: boolean;
    members: typeof dirty;
  }[] = [];
  for (const [plant, members] of byPlant) {
    const keys = members.map((m) =>
      reps.get(key(m.Material, m.Supplier, m.Plant))!,
    );
    const spec = rangeSpec(plant, keys, asOf);
    if (dryRun) {
      await estimate(meter, `ranges ${plant}`, spec, sourceRows);
      continue;
    }
    const run: any = await callCore(meter.user, "predict", { spec });
    pending.push({
      plant,
      runId: run.ID,
      cached: run.status === "succeeded",
      members,
    });
  }
  for (const p of pending) {
    const run = await awaitRun(meter.user, p.runId);
    meter.runs.push(p.runId);
    if (run.status !== "succeeded") {
      meter.failed.push(`${p.plant}: ${run.errorCode}`);
      // TabPFN failed for this plant: fall back to empirical ranges where possible.
      for (const m of p.members) {
        const k = key(m.Material, m.Supplier, m.Plant);
        const own = empiricalRange(m, sources.get(k)?.history ?? []);
        if (own) out.set(k, own);
      }
      continue;
    }
    meterRun(meter, run, p.cached);
    const got = await tabpfnRanges(
      p.runId,
      p.members,
      reps,
      sources,
      plantFingerprints.get(p.plant)!,
    );
    meter.backend = got.backend ?? meter.backend;
    for (const [k, r] of got.ranges) out.set(k, r);
    // Sources the run had no key/answer for (e.g. dropped): fall back to empirical.
    for (const m of p.members) {
      const k = key(m.Material, m.Supplier, m.Plant);
      if (out.has(k)) continue;
      const own = empiricalRange(m, sources.get(k)?.history ?? []);
      if (own) out.set(k, own);
    }
  }
  return out;
}
