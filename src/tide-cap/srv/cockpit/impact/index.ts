// Feature "impact": T1b P-2 impact (MTO + MTS), scenarios, MD04, reminder text.
// Wiring only (north-star §4.1): the step runs the day's use case, the hooks
// recompute after confirmations, goods receipts and new PO items.
import type cds from "@sap/cds";
import { registerFindingActionBuilder } from "../kernel/actions";
import { registerHook } from "../kernel/hooks";
import type { Step, StepContext } from "../kernel/types";
import { runImpact } from "./day";
import { onConfirmation, onSupplyChange } from "./hooks";
import { readBusinessImpact } from "./read";
import { REMINDER_LISTS, reminderAction } from "./reminder-action";

export { runImpact } from "./day";
export { onConfirmation, onSupplyChange } from "./hooks";

export const step: Step = {
  name: "impact",
  run: async (ctx: StepContext) => {
    await runImpact(ctx);
  },
};

export function register(srv: cds.Service) {
  srv.on("businessImpact", "DeliveryRisks", async (req: cds.Request) => {
    const [key] = req.params as any[];
    const caseID = String(typeof key === "object" ? key.header_ID ?? key.ID : key);
    const impact = await readBusinessImpact(caseID);
    if (!impact) return req.reject(404, "No business impact for this delivery case");
    return impact;
  });
  registerHook("confirmation", "impact.confirmation", onConfirmation);
  registerHook("goods_receipt", "impact.goods_receipt", onSupplyChange);
  registerHook("po_item", "impact.po_item", onSupplyChange);
  for (const list of REMINDER_LISTS) registerFindingActionBuilder(list, reminderAction);
}
