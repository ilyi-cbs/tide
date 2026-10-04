import cds from "@sap/cds";
import {
  FEATURES,
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
import { rangeSpec, representativeItems } from "../kernel/source-ranges";
import { levelsFrom, rangeResult } from "./domain/leadtimes";
import { predictionSource } from "../kernel/prediction-source";
import { PREDICTION_PROFILES } from "../kernel/prediction-profiles";

export const SETTING_FEATURES = [
  ...PREDICTION_PROFILES.independentSetting.features,
];

export function supplierSettingTrigger(current: unknown, range: Row): boolean {
  return (
    current !== null &&
    current !== undefined &&
    Number.isFinite(Number(current)) &&
    range.source === "tabpfn" &&
    range.contextRows >= 5 &&
    Number.isFinite(range.p10) &&
    Number.isFinite(range.p90) &&
    (Number(current) < range.p10 || Number(current) > range.p90)
  );
}

export function materialSettingComparison(current: unknown, sources: Row[]) {
  const covered =
    sources.length > 0 &&
    sources.every(
      (source) =>
        source.range?.source === "tabpfn" &&
        source.range.contextRows >= 5 &&
        Number.isFinite(source.range.p50) &&
        source.orders > 0,
    );
  const orders = sources.reduce((sum, source) => sum + source.orders, 0);
  const value = covered
    ? sources.reduce(
        (sum, source) => sum + source.range.p50 * source.orders,
        0,
      ) / orders
    : null;
  const validCurrent =
    current !== null &&
    current !== undefined &&
    Number.isFinite(Number(current));
  const tolerance = validCurrent
    ? Math.max(3, Math.abs(Number(current)) * 0.2)
    : null;
  return {
    covered,
    value,
    tolerance,
    trigger:
      value !== null &&
      tolerance !== null &&
      Math.abs(Number(current) - value) > tolerance,
  };
}

export async function refreshSettingRanges(
  keys: { Material: string; Supplier: string; Plant: string }[],
  asOf: string,
  meter: Meter,
  currentTx = false,
  dryRun = false,
) {
  const read = <Result>(fn: () => Promise<Result>): Promise<Result> =>
    currentTx ? inTx(fn) : (cds.tx(fn) as Promise<Result>);
  const reps = await read(() => representativeItems(keys, asOf));
  const out = new Map<string, Row>();
  for (const Plant of new Set(keys.map((entry) => entry.Plant))) {
    const members = keys.filter(
      (entry) =>
        entry.Plant === Plant &&
        reps.has(`${entry.Material}|${entry.Supplier}|${Plant}`),
    );
    if (!members.length) continue;
    try {
      const spec = rangeSpec(
        Plant,
        members.map((entry) =>
          reps.get(`${entry.Material}|${entry.Supplier}|${Plant}`)!,
        ),
        asOf,
      );
      spec.features = SETTING_FEATURES;
      if (dryRun) {
        await estimate(meter, `independent setting ranges ${Plant}`, spec);
        continue;
      }
      const started = await callCore(meter.user, "predict", { spec });
      const run =
        started.status === "succeeded"
          ? started
          : await awaitRun(meter.user, started.ID);
      meterRun(meter, run, started.status === "succeeded");
      meter.runs.push(run.ID);
      if (run.status !== "succeeded") continue;
      const results = await read(() => runResults(run.ID));
      for (const entry of members) {
        const key = `${entry.Material}|${entry.Supplier}|${Plant}`;
        const quantiles = results.get(reps.get(key)!);
        if (!quantiles?.length || !quantiles.every(Number.isFinite)) continue;
        const range = {
          ...rangeResult(
            entry,
            predictionSource(run),
            0,
            "independent plant context",
            Number(run.trainRows ?? 0),
            levelsFrom(quantiles, spec.output.levels),
          ),
          runID: run.ID,
          inputFingerprint: run.inputFingerprint,
          backend: run.backend ?? null,
          asOf,
          independentSettingProfile: true,
        };
        out.set(key, range);
        await read(async () =>
          cds.ql.UPSERT.into(`${NS}.SettingRange`).entries({
            ...entry,
            asOf,
            result: JSON.stringify(range),
          }),
        );
      }
    } catch (error: any) {
      meter.failed.push(`independent setting range ${Plant}: ${error.message}`);
    }
  }
  return out;
}
