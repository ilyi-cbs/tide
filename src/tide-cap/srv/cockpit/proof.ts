// Proof: how good are the lead-time estimates the cockpit shows?
//
// Cutoff = as-of date - PROOF_DAYS. Context: deliveries available before the
// cutoff. Evaluated: PO items ordered before the cutoff and available between
// cutoff and as-of date (their outcome was unknown at the cutoff). Four
// methods estimate each evaluated item's lead time from the context only:
//
//   planned          SAP's planned delivery time on the item (point)
//   key_median       median of the source's own lead times (point; supplier
//                    median when the source has none)
//   supplier_median  median of the supplier's lead times in the plant (point)
//   tabpfn           TabPFN quantiles from the plant context (range)
//
// Metrics: mean absolute error of the point / p50, share of actuals within
// p10-p90 (ranges only), and the share of late deliveries (available after
// the requested date) the method flagged in advance (estimate after the
// requested date). Results per amount of own history before the cutoff.
import cds from "@sap/cds";
import { sourceFeedRows } from "./kernel/source-ranges";
import {
  FEATURES,
  FEED,
  NS,
  awaitRun,
  callCore,
  estimate,
  meterRun,
  runResults,
  type Meter,
  type Row,
} from "./prepare";
import { addDays, historyBucket, mean, median, round1, round3 } from "./logic";
import { groupBy, groupByArray } from "./kernel/collections";
import { seededSample } from "./freetext/domain/logic";
import { writePreparation } from "./kernel/publication";
import type { StepContext } from "./kernel/types";

const { SELECT, INSERT, DELETE } = cds.ql;
export const PROOF_DAYS = 56;
const MAX_EVALUATED_PER_PLANT = 300;
const LEVELS = [0.1, 0.5, 0.9];

const LABELS: Record<string, string> = {
  planned: "SAP planned delivery time",
  key_median: "Median of the source",
  supplier_median: "Median of the supplier",
  tabpfn: "TabPFN (no training)",
};

interface Estimate {
  point: number | null;
  p10?: number | null;
  p90?: number | null;
}

export async function proof(
  _sources: unknown,
  snapshotId: string,
  asOf: string,
  dryRun: boolean,
  meter: Meter,
  publication: Pick<StepContext, "publication"> = {},
) {
  const cutoff = addDays(asOf, -PROOF_DAYS);
  const facts: Row[] = await SELECT.from(`${NS}.${dryRun ? "ItemFactSource" : "ItemFact"}`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "Material",
    "Supplier",
    "Plant",
    "PurchaseOrderDate",
    "RequestedDate",
    "AvailableDate",
    "LeadTimeDays",
    "PlannedDays",
  ).where`LeadTimeDays >= 0 and Material != '' and AvailableDate < ${asOf}`;
  const before = facts.filter((f) => f.AvailableDate < cutoff);
  const evaluated = facts.filter(
    (f) => f.PurchaseOrderDate < cutoff && f.AvailableDate >= cutoff,
  );
  const byKey = groupByArray(
    before,
    (f) => `${f.Material}|${f.Supplier}|${f.Plant}`,
    (f) => f.LeadTimeDays,
  );
  const bySupplier = groupByArray(
    before,
    (f) => `${f.Supplier}|${f.Plant}`,
    (f) => f.LeadTimeDays,
  );
  // A seeded per-plant sample keeps the model cost bounded.
  const byPlant = groupBy(
    evaluated.sort((a, b) =>
      `${a.PurchaseOrder}/${a.PurchaseOrderItem}` <
      `${b.PurchaseOrder}/${b.PurchaseOrderItem}`
        ? -1
        : 1,
    ),
    (e) => e.Plant,
  );
  const sample: Row[] = [];
  for (const list of byPlant.values())
    sample.push(
      ...seededSample(
        list,
        MAX_EVALUATED_PER_PLANT,
        (r) => `${r.PurchaseOrder}/${r.PurchaseOrderItem}`,
        `proof:${asOf}`,
      ),
    );

  const tabpfn = new Map<string, number[]>();
  const specFor = (plant: string, keys: string[]) => ({
    feed: FEED,
    target: "LeadTimeDays",
    features: FEATURES,
    task: "regression",
    train: {
      filter: [
        { col: "Plant", op: "=", value: plant },
        { col: "LeadTimeDays", op: ">=", value: "0" },
        { col: "AvailableDate", op: "<", value: cutoff },
      ],
    },
    predict: { keys },
    output: { type: "quantiles", levels: LEVELS },
  });
  const keysOf = (plant: string) =>
    sample
      .filter((s) => s.Plant === plant)
      .map((s) => `${s.PurchaseOrder}/${s.PurchaseOrderItem}`);
  if (dryRun) {
    const sourceRows = await sourceFeedRows();
    // Plan only: estimate the proof runs; the stored proof stays as it is.
    for (const [plant] of byPlant) {
      const keys = keysOf(plant);
      if (keys.length)
        await estimate(meter, `proof ${plant}`, specFor(plant, keys), sourceRows);
    }
    return;
  }
  const pending: { id: string; cached: boolean }[] = [];
  for (const [plant] of byPlant) {
    const keys = keysOf(plant);
    if (!keys.length) continue;
    const run: any = await callCore(meter.user, "predict", {
      spec: specFor(plant, keys),
    });
    pending.push({ id: run.ID, cached: run.status === "succeeded" });
  }
  for (const { id, cached } of pending) {
    const run = await awaitRun(meter.user, id);
    meter.runs.push(id);
    if (run.status !== "succeeded") {
      meter.failed.push(`proof: ${run.errorCode}`);
      continue;
    }
    meterRun(meter, run, cached);
    if (
      !["aicore", "priorlabs"].includes(run.backend) ||
      run.placeholder ||
      run.fallback
    ) {
      cds
        .log("proof")
        .warn("excluded non-model run from TabPFN quality metrics", {
          runId: id,
          backend: run.backend,
        });
      continue;
    }
    for (const [k, q] of await runResults(id)) tabpfn.set(k, q);
  }

  const estimates = (f: Row): Record<string, Estimate> => {
    const k = `${f.Material}|${f.Supplier}|${f.Plant}`;
    const own = byKey.get(k);
    const sup = bySupplier.get(`${f.Supplier}|${f.Plant}`);
    const q = tabpfn.get(`${f.PurchaseOrder}/${f.PurchaseOrderItem}`);
    return {
      planned: { point: f.PlannedDays ?? null },
      key_median: {
        point: own?.length ? median(own) : sup?.length ? median(sup) : null,
      },
      supplier_median: { point: sup?.length ? median(sup) : null },
      tabpfn: q ? { point: q[1], p10: q[0], p90: q[2] } : { point: null },
    };
  };

  type Acc = {
    err: number[];
    inside: number;
    ranged: number;
    late: number;
    caught: number;
  };
  const acc = new Map<string, Acc>();
  const get = (m: string, b: string) => {
    const k = `${m}|${b}`;
    return (
      acc.get(k) ??
      acc.set(k, { err: [], inside: 0, ranged: 0, late: 0, caught: 0 }).get(k)!
    );
  };
  // Paired scoring: every method is scored on the same rows; methods with no estimate anywhere don't shrink the set.
  const all = sample.map((f) => ({ f, e: estimates(f) }));
  const methods = Object.keys(LABELS).filter((m) =>
    all.some(({ e }) => e[m]?.point !== null && e[m]?.point !== undefined),
  );
  const paired = all.filter(({ e }) =>
    methods.every((m) => e[m]?.point !== null && e[m]?.point !== undefined),
  );
  const excluded = all.length - paired.length;
  if (excluded)
    cds.log("proof").info("rows excluded from paired scoring", {
      excluded,
      paired: paired.length,
    });
  for (const { f, e: est } of paired) {
    const bucket = historyBucket(
      byKey.get(`${f.Material}|${f.Supplier}|${f.Plant}`)?.length ?? 0,
    );
    const actual = f.LeadTimeDays;
    const late = !!f.RequestedDate && f.AvailableDate > f.RequestedDate;
    const gap = f.RequestedDate
      ? (Date.parse(f.RequestedDate) - Date.parse(f.PurchaseOrderDate)) /
        86_400_000
      : null;
    for (const m of methods) {
      const e = est[m];
      if (e.point === null || e.point === undefined) continue;
      for (const b of ["all", bucket]) {
        const a = get(m, b);
        a.err.push(Math.abs(e.point - actual));
        if (
          e.p10 !== undefined &&
          e.p10 !== null &&
          e.p90 !== undefined &&
          e.p90 !== null
        ) {
          a.ranged++;
          if (actual >= e.p10 && actual <= e.p90) a.inside++;
        }
        if (late) {
          a.late++;
          if (gap !== null && e.point > gap) a.caught++;
        }
      }
    }
  }
  const rows = [...acc].map(([k, a]) => {
    const [method, bucket] = k.split("|");
    return {
      method,
      bucket,
      snapshot_ID: snapshotId,
      label: LABELS[method],
      n: a.err.length,
      mae: round1(mean(a.err)),
      coverage: a.ranged ? round3(a.inside / a.ranged) : null,
      lateCaught: a.late ? round3(a.caught / a.late) : null,
      lateTotal: a.late,
      excluded,
      cutoff,
      evaluatedFrom: cutoff,
      evaluatedTo: asOf,
      source:
        method === "tabpfn"
          ? "tabpfn"
          : method === "planned"
            ? "lookup"
            : "empirical",
    };
  });
  await writePreparation(publication, async () => {
    await DELETE.from(`${NS}.ProofResult`);
    if (rows.length) await INSERT.into(`${NS}.ProofResult`).entries(rows);
  });
}
