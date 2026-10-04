import { modelWork, withPredictionOptions } from "../kernel/model-calls";
import cds from "@sap/cds";
import type { Step, StepContext } from "../kernel/types";
import { PlanningForecastError, PlanningInputError } from "./domain/logic";
import { compareSuppliers, planOrder, planningSources } from "./service";

export const step: Step = {
  name: "planning",
  async run(_ctx: StepContext) {
    // planning computes on request only
  },
};

const isForecastUnavailable = (error: unknown) =>
  error instanceof PlanningForecastError ||
  (error as any)?.status === 424 ||
  (error as Error)?.message?.startsWith("TabPFN delivery forecast unavailable");

// Register before kernel stubs so planOrder uses this handler.
export function register(srv: cds.Service) {
  srv.on("planOrder", async (req: cds.Request) => {
    try {
      return await withPredictionOptions(req.data.force === true, () =>
        modelWork(() => planOrder(req.data as any)),
      );
    } catch (e) {
      if (e instanceof PlanningInputError) return req.reject(400, e.message);
      if (isForecastUnavailable(e))
        return req.reject(424, (e as Error).message);
      throw e;
    }
  });
  srv.on("planningSources", async (req: cds.Request) =>
    planningSources(req.data as any),
  );
  srv.on("compareSuppliers", async (req: cds.Request) => {
    try {
      return await withPredictionOptions(req.data.force === true, () =>
        modelWork(() => compareSuppliers(req.data as any)),
      );
    } catch (e) {
      if (e instanceof PlanningInputError) return req.reject(400, e.message);
      if (isForecastUnavailable(e))
        return req.reject(424, (e as Error).message);
      throw e;
    }
  });
}
