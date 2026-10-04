import cds from "@sap/cds";
import { inputFingerprint } from "./feeds";
import { tabularRuntime } from "./tabular-client";

const { SELECT, UPDATE } = cds.ql;
const LOG = cds.log("core");
const RUNS = "tide.core.PredictionRun";
// Set by scripts/predictions.py import.
const STORED = "stored-predictions";

/** Re-keys imported runs to the local tabular identity so identical requests hit them. */
export async function adoptStoredPredictions() {
  const runs = await cds.tx(() =>
    SELECT.from(RUNS)
      .columns("ID", "inputFingerprint", "inputSnapshot", "predictionContractVersion")
      .where({ createdBy: STORED, status: "succeeded" }),
  );
  if (!runs.length) return;
  const { identity } = await tabularRuntime();
  let adopted = 0;
  await cds.tx(async () => {
    for (const run of runs) {
      if (!run.inputSnapshot) continue;
      // Forced runs carry a nonce in their stored fingerprint, so always recompute it.
      const hash = inputFingerprint(
        JSON.parse(run.inputSnapshot),
        identity,
        run.predictionContractVersion,
      );
      if (hash === run.inputFingerprint) continue;
      if (await SELECT.one.from(RUNS).columns("ID").where({ inputFingerprint: hash }))
        continue;
      await UPDATE.entity(RUNS, run.ID).with({
        inputFingerprint: hash,
        backendIdentity: identity,
      });
      adopted++;
    }
  });
  if (adopted) LOG.info(`adopted ${adopted} stored prediction runs`);
}
