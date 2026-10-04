// Register handlers before kernel stubs so the feed implementations take precedence.
import cds from "@sap/cds";
import { emit } from "../kernel/events";
import { writePreparation } from "../kernel/publication";
import type { Step, StepContext } from "../kernel/types";
import { applyChanges, handle } from "./feed";

export const step: Step = {
  name: "feed",
  /**
   * The morning run starts a new day of the event log: one "morning" event
   * (the feed's delta polling starts after it). Dry run: nothing.
   */
  async run(ctx: StepContext) {
    if (ctx.dryRun) return;
    await writePreparation(ctx, () =>
      emit({
        kind: "morning",
        title: "Your day was prepared this morning",
        simTime: `${ctx.asOf}T06:00:00Z`,
        status: "done",
        modelCalls: ctx.meter.calls,
        costUnits: Math.round(ctx.meter.cost * 1e6) / 1e6,
      }),
    );
  },
};

export function register(srv: cds.Service) {
  srv.before(["applyChanges"], (req) => {
    if (!req.user.is("admin"))
      req.reject(403, "Source intake requires administrator authorization");
  });
  srv.on("applyChanges", (req) => handle(req, applyChanges)());
}
