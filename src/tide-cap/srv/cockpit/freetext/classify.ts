// Classifier over CoreService (the guarded model path): one prediction run per
// field and segment on the feed CockpitFreetextFeed. Probabilities are read
// from the run's results (class -> probability).
import cds from "@sap/cds";
import {
  awaitRun,
  callCore,
  estimate,
  meterRun,
  type Meter,
  type Row,
} from "../kernel/model-calls";
import type { Classify, ClassifyRequest, ClassifyResult } from "./engine";
import { itemKey } from "./domain/logic";

const { SELECT } = cds.ql;
export const FEED = "CockpitFreetextFeed";

type ClassifyRow = {
  PurchaseRequisition: string;
  PurchaseRequisitionItem: string;
  id?: string;
};
type CoreClassifyRequest = Omit<ClassifyRequest, "train" | "test"> & {
  train: ClassifyRow[];
  test: ClassifyRow[];
};

/** Row key of an item in the feed (FreetextItem.id). */
const idOf = (r: {
  PurchaseRequisition: string;
  PurchaseRequisitionItem: string;
  id?: string;
}) => r.id ?? itemKey(r);

export function specOf(req: CoreClassifyRequest, feed = FEED) {
  return {
    feed,
    target: req.field,
    task: "classification",
    features: req.columns.map((c) => c.name),
    train: { filter: [{ col: "id", op: "in", values: req.train.map(idOf) }] },
    predict: { keys: req.test.map(idOf) },
    output: { type: "probas" },
  };
}

/** Real runs: counted on the meter, results as class probabilities. */
export function coreClassify(
  meter: Meter,
  feed = FEED,
): (req: CoreClassifyRequest) => Promise<ClassifyResult> {
  return async (req) => {
    const run: any = await callCore(meter.user, "predict", {
      spec: specOf(req, feed),
    });
    const cached = run.status === "succeeded";
    const done = cached
      ? run
      : await awaitRun(meter.user, run.ID, req.deadlineMs);
    meter.runs.push(run.ID);
    meterRun(meter, done, cached);
    if (done.status !== "succeeded")
      throw new Error(`run ${run.ID} ${done.status}: ${done.errorCode ?? ""}`);
    if (
      done.fallback ||
      (!["tabpfn", "priorlabs", "aicore"].includes(done.backend) &&
        !(cds.env.profiles.includes("test") && done.backend === "fake"))
    )
      throw new Error(
        `TabPFN prediction required; received ${done.backend ?? "unrecorded backend"}${done.fallback ? " fallback" : ""}`,
      );
    const rows: Row[] = await cds.tx(() =>
      SELECT.from("tide.core.PredictionResult")
        .columns("rowKey", "probabilities")
        .where({ run_ID: run.ID }),
    );
    const maps = rows.map(
      (r) =>
        [
          String(r.rowKey),
          r.probabilities
            ? (JSON.parse(r.probabilities) as Record<string, number>)
            : {},
        ] as const,
    );
    const classes = [
      ...new Set(maps.flatMap(([, m]) => Object.keys(m))),
    ].sort();
    const byKey = new Map(req.test.map((t) => [idOf(t), itemKey(t)]));
    const probabilities = new Map<string, number[]>();
    for (const [k, m] of maps)
      probabilities.set(
        byKey.get(k) ?? k,
        classes.map((c) => Number(m[c] ?? 0)),
      );
    return {
      classes,
      probabilities,
      source: "tabpfn",
      backend: done.backend ?? null,
      modelVersion: done.modelVersion ?? null,
    } satisfies ClassifyResult;
  };
}

/** Dry run: counts the planned call on the meter; answers with nothing (the step writes nothing). */
export function dryClassify(meter: Meter): Classify {
  return async (req) => {
    await estimate(meter, req.label, specOf(req));
    return { classes: [], probabilities: new Map(), source: "none" };
  };
}
