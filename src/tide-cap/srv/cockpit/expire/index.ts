// Feature "expire" (§ approval workflow unification): flags `waiting`
// Actions whose cooldown (kernel/action-state.ts COOLDOWN_DAYS, working
// days from decide()) elapsed without a logged outcome — loud, not silent:
// the Waiting tab surfaces `overdue` rows first (see the Actions
// annotations). Never auto-resolves; a human still has to log the real
// outcome.
import cds from "@sap/cds";
import { NS } from "../kernel/model-calls";
import { flagOverdue } from "../kernel/action-state";
import { writePreparation } from "../kernel/publication";
import type { Row } from "../kernel/model-calls";
import type { Step, StepContext } from "../kernel/types";

const { SELECT } = cds.ql;
const LOG = cds.log("cockpit.expire");

export const step: Step = {
  name: "expire",
  async run(ctx: StepContext) {
    if (ctx.dryRun) return;
    await writePreparation(ctx, async () => {
      const overdue: Row[] = await SELECT.from(`${NS}.Actions`).columns(
        "ID",
        "expectedBy",
      )
        .where`status = 'waiting' and overdue = false and expectedBy <= ${ctx.asOf}`;
      for (const a of overdue) await flagOverdue(a.ID, ctx.asOf, a.expectedBy);
      if (overdue.length)
        LOG.info(`expire: ${overdue.length} waiting action(s) flagged overdue`);
    });
  },
};

export function register(_srv: cds.Service) {
  // No operations or hooks of its own.
}
