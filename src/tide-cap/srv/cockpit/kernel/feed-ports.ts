import type cds from "@sap/cds";
import type { Row } from "./model-calls";

type SourceRefresh = (rows: Row[], asOf: string) => Promise<unknown>;
type DayPreparation = (user: cds.User) => Promise<Row>;
let refresh: SourceRefresh | undefined;
let prepare: DayPreparation | undefined;

/** Cross-feature feed orchestration is wired by the service composition root. */
export function registerFeedPorts(ports: { refreshSources: SourceRefresh; prepareDay: DayPreparation }) {
  refresh = ports.refreshSources;
  prepare = ports.prepareDay;
}

export async function refreshRequisitionSources(rows: Row[], asOf: string) {
  if (!refresh) throw new Error("Requisition source refresh is not registered");
  return refresh(rows, asOf);
}

export async function prepareResetDay(user: cds.User): Promise<Row> {
  if (!prepare) throw new Error("Day preparation is not registered");
  return prepare(user);
}
