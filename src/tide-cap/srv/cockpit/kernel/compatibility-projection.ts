// Transitional read adapter for retained Finding consumers. Detector code uses
// typed roots directly and must not know the legacy persistence layout.
import cds from "@sap/cds";
import { NS } from "./model-calls";
import type { FindingRow } from "./types";

const { SELECT } = cds.ql;

/** Existing at-risk rows needed for the follow-up retention policy. */
export async function openAtRiskProjectionRows(): Promise<FindingRow[]> {
  // `list` is also a CQN operator property, so object-style predicates are
  // ambiguous here (`arg.list.forEach is not a function`). Use an expression.
  const rows: FindingRow[] = await SELECT.from(`${NS}.Finding`).where`list = ${"at_risk"} and status = ${"open"}`;
  for (const row of rows)
    row.atRiskDetail = await SELECT.one.from(`${NS}.AtRiskDetail`).where({ finding_ID: row.ID });
  return rows;
}
