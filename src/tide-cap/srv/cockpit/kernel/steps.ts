// Step registry (contract §4 as amended by A1): the feature steps run after
// the preparation calculations in this fixed order. Required failures prevent
// publication; optional evidence failures remain recorded explicitly.
import cds from "@sap/cds";
import type { Step, StepContext } from "./types";
import { step as guard } from "../guard";
import { step as atrisk } from "../atrisk";
import { step as rules } from "../rules";
import { step as impact } from "../impact";
import { step as leadtimes } from "../leadtimes";
import { step as planning } from "../planning";
import { step as freetext } from "../freetext";
import { step as expire } from "../expire";
import { step as feed } from "../feed";
import { step as overview } from "../overview";

const LOG = cds.log("cockpit");

/** Fixed order (A1), guard first (buyers are read by the routing of free text). */
export const STEP_ORDER = ["guard", "atrisk", "rules", "impact", "leadtimes", "planning", "freetext", "expire", "feed", "overview"] as const;

export function steps(): Step[] {
  return [guard, atrisk, rules, impact, leadtimes, planning, freetext, expire, feed, overview];
}

/**
 * Runs every step with `ctx` (dry run passed through: steps then only count
 * planned model calls on ctx.meter). Returns "<step>: <message>" per failed step.
 */
export async function runSteps(ctx: StepContext, list: Step[] = steps()): Promise<string[]> {
  const errors: string[] = [];
  for (const s of list) {
    const startedAt = new Date().toISOString();
    const writesBefore = ctx.publication?.writes.length ?? 0;
    try {
      await s.run(ctx);
      if (!ctx.dryRun)
        await recordPhase(ctx, s, startedAt, ctx.publication ? "staged" : "succeeded", null);
    } catch (e: any) {
      if (ctx.publication) ctx.publication.writes.length = writesBefore;
      LOG.error(`step ${s.name} failed`, e);
      errors.push(`${s.name}: ${String(e?.message ?? e).slice(0, 120)}`);
      if (!ctx.dryRun)
        await recordPhase(ctx, s, startedAt, "failed", String(e?.message ?? e).slice(0, 1000));
      if (s.required !== false) throw e;
    }
  }
  return errors;
}

async function recordPhase(ctx: StepContext, step: Step, startedAt: string, status: string, error: string | null) {
  await cds.tx(() => cds.ql.UPSERT.into("tide.cockpit.PreparationPhase").entries({
    snapshot_ID: ctx.snapshotId,
    name: step.name,
    required: step.required !== false,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    error,
  }));
}
