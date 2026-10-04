// One-off backfill for pre-detail Finding rows. Safe to run repeatedly.
import cds from "@sap/cds";
import { NS, type Row } from "./model-calls";

const { SELECT, INSERT } = cds.ql;

function json(value: unknown): Row {
  try { return typeof value === "string" ? JSON.parse(value) : {}; } catch { return {}; }
}

/** Materializes only legacy JSON shapes that existed before the typed details. */
export async function migrateFindingDetails() {
  const rows: Row[] = await SELECT.from(`${NS}.Finding`).columns("ID", "list", "expert");
  for (const f of rows) {
    const e = json(f.expert);
    if (f.list === "freetext") {
      const exists = await SELECT.one.from(`${NS}.FreetextDetail`).where({ finding_ID: f.ID });
      if (!exists) await INSERT.into(`${NS}.FreetextDetail`).entries({ finding_ID: f.ID, requestText: "", codingText: "", segment: null, demo: !!e.demo, contextRows: e.contextRows ?? 0, inputs: JSON.stringify(e.inputs ?? []) });
    }
    if (f.list === "at_risk") {
      const exists = await SELECT.one.from(`${NS}.AtRiskDetail`).where({ finding_ID: f.ID });
      if (!exists) await INSERT.into(`${NS}.AtRiskDetail`).entries({ finding_ID: f.ID, source: null, lateShare: e.p_late ?? null, gapDays: e.gap ?? 0, plannedDays: e.plannedDays ?? null, plannedFlag: e.plannedFlag ?? null, riskRank: e.riskRank ?? 0, ruleVerdict: e.ruleVerdict ?? null, ownDeliveries: e.nOwn ?? 0, contextLevel: e.contextLevel ?? null, gridRef: e.grid ?? "", fastDays: null, typicalDays: null, slowDays: null, dueCriticality: 0 });
    }
    if (f.list === "mm_pdt") {
      const exists = await SELECT.one.from(`${NS}.MmPdtDetail`).where({ finding_ID: f.ID });
      if (!exists) {
        await INSERT.into(`${NS}.MmPdtDetail`).entries({ finding_ID: f.ID, proposalDays: e.proposalDays ?? null, proposalRule: e.proposalRule ?? null, masterDays: e.masterDays ?? null, masterFlag: e.masterFlag ?? null, difference: e.difference ?? null, tolerance: e.tolerance ?? null, orders12m: e.pos12m ?? null, note: e.note ?? null });
        for (const s of e.sources ?? []) await INSERT.into(`${NS}.MmPdtSource`).entries({ finding_finding_ID: f.ID, supplier: s.Supplier, supplierName: s.supplierName ?? null, orders12m: s.pos ?? null, orderShare: s.share ?? null, ownDeliveries: s.nOwn ?? null, typicalDays: s.median ?? null, infoRecordDays: s.infoRecordDays ?? null, source: s.source ?? null, pdtFindingID: s.findingID ?? null });
      }
    }
  }
}
