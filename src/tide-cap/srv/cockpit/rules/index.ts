// Feature "rules" (T2, P-13): wiring only (north star §4.1). Rule lists are
// computed in morning.ts, feeder hooks in hooks.ts, the confirmation entry in
// enter-confirmation.ts; pure rules in domain/.
import cds from "@sap/cds";
import { registerHook } from "../kernel/hooks";
import { NS, modelWork } from "../kernel/model-calls";
import { scopeOf } from "../kernel/auth";
import type { Step, StepContext } from "../kernel/types";
import { enterConfirmation } from "./enter-confirmation";
import { onConfirmation, onGoodsReceipt, onPoItem } from "./hooks";
import { runRules } from "./morning";
import { estimatePurchasePrice } from "./price-model";
import { registerFindingActionBuilder } from "../kernel/actions";
import { priceAction } from "./price-action";
import { duplicateMdgAction, rarePlannerAction } from "./disposition-actions";

export { copySapConfirmations, RULE_LISTS } from "./rows";
export { computeRuleFindings, runRules } from "./morning";
export { enterConfirmation } from "./enter-confirmation";
export { onConfirmation, onGoodsReceipt, onPoItem } from "./hooks";

export const step: Step = {
  name: "rules",
  async run(ctx: StepContext) {
    await runRules(ctx);
  },
};

export function register(srv: cds.Service) {
  srv.on("enterConfirmation", enterConfirmation);
  srv.on("estimatePurchasePrice", (req: any) =>
    modelWork(() => estimatePurchasePrice(req.data, req.user)),
  );
  srv.on("preventionSummary", async (req) => {
    const scope = scopeOf(req.user);
    const { SELECT } = cds.ql;
    const count = async (entity: string) => {
      const where: Record<string, any> = { status: "open", listing: "listed" };
      if (scope.Plant) where.Plant = scope.Plant;
      if (scope.PurchasingGroup) where.PurchasingGroup = scope.PurchasingGroup;
      const headers = await SELECT.from(`${NS}.Cases`)
        .columns("ID")
        .where(where);
      if (!headers.length) return 0;
      const row = await SELECT.one
        .from(`${NS}.${entity}`)
        .columns("count(1) as count")
        .where({ header_ID: { in: headers.map((h: any) => h.ID) } });
      return Number(row?.count ?? 0);
    };
    const [price, duplicates, unusual, supplier, material] = await Promise.all([
      count("PriceDeviations"),
      count("DuplicateMaterials"),
      count("UnusualSettings"),
      count("SupplierPlannedTimes"),
      count("MaterialPlannedTimes"),
    ]);
    return { price, duplicates, unusual, supplier, material };
  });
  registerHook("confirmation", "rules.confirmation", (ev) =>
    onConfirmation(ev),
  );
  registerHook("goods_receipt", "rules.goods_receipt", (ev) =>
    onGoodsReceipt(ev),
  );
  registerHook("po_item", "rules.po_item", (ev) => onPoItem(ev));
  registerFindingActionBuilder("price", priceAction);
  registerFindingActionBuilder("duplicate", duplicateMdgAction);
  registerFindingActionBuilder("rare", rarePlannerAction);
}
