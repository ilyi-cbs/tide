// Feature "outlook": the delivery outlook of an at_risk / overdue finding for
// the object page (timeline and options). Read-only, no morning step.
import cds from "@sap/cds";
import type { Step, StepContext } from "../kernel/types";
import { readDeliveryHistory, readOutlook } from "./read";

export const step: Step = {
  name: "outlook",
  async run(_ctx: StepContext) {
    // computed on read from the stored grids, impact and actions
  },
};

export function register(srv: cds.Service) {
  const handle = async (req: cds.Request) => {
    const [k] = req.params as any[];
    const ID = String(typeof k === "object" ? k.header_ID ?? k.ID : k);
    const o = await readOutlook(ID);
    if (!o) return req.reject(404, "No delivery outlook for this finding");
    return o;
  };
  srv.on("outlook", "Findings", handle);
  srv.on("outlook", "FulfillmentRisks", handle);
  srv.on("outlook", "DeliveryRisks", handle);
  srv.on("deliveryHistory", "FulfillmentRisks", async (req: cds.Request) => {
    const [k] = req.params as any[];
    const ID = String(typeof k === "object" ? k.ID : k);
    const history = await readDeliveryHistory(ID);
    if (!history) return req.reject(404, "No delivery history for this finding");
    return history;
  });
  srv.on("deliveryHistory", "DeliveryRisks", async (req: cds.Request) => {
    const [k] = req.params as any[];
    const ID = String(typeof k === "object" ? k.header_ID ?? k.ID : k);
    const history = await readDeliveryHistory(ID);
    if (!history) return req.reject(404, "No delivery history for this case");
    return history;
  });
}
