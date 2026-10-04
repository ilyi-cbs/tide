import cds from "@sap/cds";
import { registerHook } from "../kernel/hooks";
import type { Step, StepContext } from "../kernel/types";
import { onGoodsReceipt, onPoItem } from "./feed";
import { runMorning } from "./morning";

export { verdictForItem } from "./feed";

const LOG = cds.log("cockpit.atrisk");

export const step: Step = {
  name: "atrisk",
  async run(ctx: StepContext) {
    const r = await runMorning(ctx);
    if (!ctx.dryRun)
      LOG.info(`at risk: ${r.findings} findings, ${r.grids} line grids`);
  },
};

export function register(_srv: cds.Service) {
  registerHook("po_item", "atrisk.verdict", onPoItem);
  registerHook("goods_receipt", "atrisk.receipt", onGoodsReceipt);
}
