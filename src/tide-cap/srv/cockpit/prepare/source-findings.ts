// Step 5 of prepareDay: source findings — planned delivery time rule / range
// check, proposal, backtest; tier 1 behind open items, tier 2 without.
import { PROPOSAL_QUANTILE, VERDICT_TEXT, addDays, at, backtest, effectiveDays, pdtVerdict, verdictCriticality } from "../logic";
import { NS, type Row } from "../kernel/model-calls";
import cds from "@sap/cds";
import { key, type SourceKey } from "./shared";
import type { Source } from "./histories";
import type { RangeRow } from "./ranges";
import type { Names } from "./lookups";

const { SELECT } = cds.ql;

const RELEVANCE_DAYS = 365;

/** PO count and EUR value per source in the RELEVANCE_DAYS before the as-of date. */
export async function poActivity(asOf: string, only?: SourceKey) {
  const since = addDays(asOf, -RELEVANCE_DAYS);
  const q = SELECT.from(`${NS}.ItemFact`)
    .columns("Material", "Supplier", "Plant", "count(1) as n", "sum(NetAmountEUR) as value")
    .where`PurchaseOrderDate >= ${since} and PurchaseOrderDate < ${asOf} and Material != ''`
    .groupBy("Material", "Supplier", "Plant");
  if (only) q.where({ Material: only.Material, Supplier: only.Supplier, Plant: only.Plant });
  const rows: Row[] = await q;
  return new Map(
    rows.map((r) => [key(r.Material, r.Supplier, r.Plant), { n: Number(r.n), value: Number(r.value ?? 0) }]),
  );
}

export function sourceFindings(
  irRows: Row[],
  masterByKey: Map<string, Row>,
  sources: Map<string, Source>,
  rangeMap: Map<string, RangeRow>,
  items: Row[],
  nm: Names,
  snapshotId: string,
  activity: Map<string, { n: number; value: number }>,
) {
  const openBy = new Map<string, Row[]>();
  for (const i of items) {
    const k = key(i.Material, i.Supplier, i.Plant);
    (openBy.get(k) ?? openBy.set(k, []).get(k)!).push(i);
  }
  const rows: Row[] = [];
  const backtests: Row[] = [];
  const done = new Set<string>();
  for (const ir of irRows) {
    if (!ir.Material || !ir.Supplier) continue;
    const k = key(ir.Material, ir.Supplier, ir.Plant);
    if (done.has(k)) continue;
    done.add(k);
    const r = rangeMap.get(k);
    const grid = r?.grid ?? null;
    const irDays = ir.MaterialPlannedDeliveryDurn === null ? null : Number(ir.MaterialPlannedDeliveryDurn);
    const m = masterByKey.get(`${ir.Material}|${ir.Plant}`);
    const masterDays = m?.PlannedDeliveryDurationInDays ?? null;
    const eff = effectiveDays(irDays, masterDays);
    const useIr = eff.from === "info record";
    const current = eff.days;
    const verdict = pdtVerdict(current, grid);
    if (verdict === "within_range" || verdict === "no_range") continue;
    const act = activity.get(k) ?? { n: 0, value: 0 };
    const open = openBy.get(k) ?? [];
    // Sources nobody orders are not worth a correction.
    if (!open.length && act.n === 0) continue;
    const hist = sources.get(k)?.history ?? [];
    const q = at(grid, PROPOSAL_QUANTILE);
    const bt = backtest(hist.map((h) => h.lt), current);
    for (const row of bt.rows)
      backtests.push({ Material: ir.Material, Supplier: ir.Supplier, Plant: ir.Plant, ...row });
    const risk = open.reduce((a, i) => a + (i.revenueAtRiskP80 ?? 0), 0);
    const ruled = ["not_maintained", "default", "placeholder"].includes(verdict);
    rows.push({
      Material: ir.Material,
      Supplier: ir.Supplier,
      Plant: ir.Plant,
      snapshot_ID: snapshotId,
      MaterialText: nm.material.get(ir.Material) ?? null,
      SupplierName: nm.supplier.get(ir.Supplier) ?? ir.Supplier,
      PurchasingGroup: ir.PurchasingGroup,
      MRPController: m?.MRPResponsible ?? null,
      PurchasingInfoRecord: ir.PurchasingInfoRecord,
      infoRecordDays: irDays,
      masterDays,
      currentDays: current,
      currentFrom: useIr ? "info record" : "material master",
      verdict,
      verdictCriticality: verdictCriticality(verdict),
      source: ruled ? "rule" : (r?.source ?? "none"),
      nOwn: hist.length,
      p10: at(grid, 0.1),
      p50: at(grid, 0.5),
      p90: at(grid, 0.9),
      proposalDays: q === null ? null : Math.ceil(q),
      proposalQuantile: PROPOSAL_QUANTILE,
      proposalSource: r?.source ?? "none",
      poCount12m: act.n,
      poValue12m: Math.round(act.value),
      openItems: open.length,
      openRevenueAtRiskP80: Math.round(risk),
      tier: open.length ? 1 : 2,
      reason: `${VERDICT_TEXT[verdict]} (${current ?? "-"} days from ${useIr ? "info record" : "material master"}); real lead times ${at(grid, 0.1) ?? "-"} to ${at(grid, 0.9) ?? "-"} days (${r?.source ?? "none"})`.slice(0, 300),
    });
  }
  rows.sort(
    (a, b) => a.tier - b.tier || b.openRevenueAtRiskP80 - a.openRevenueAtRiskP80 || b.poValue12m - a.poValue12m,
  );
  rows.forEach((r, i) => (r.priority = i + 1));
  return { rows, backtests };
}

/** Finding priorities in the order sourceFindings uses (tier, open risk, PO value). */
export async function rerankFindings() {
  const { UPDATE } = cds.ql;
  const rows: Row[] = await SELECT.from(`${NS}.SourceFinding`).columns(
    "Material",
    "Supplier",
    "Plant",
    "tier",
    "openRevenueAtRiskP80",
    "poValue12m",
    "priority",
  );
  rows.sort(
    (a, b) =>
      a.tier - b.tier ||
      (b.openRevenueAtRiskP80 ?? 0) - (a.openRevenueAtRiskP80 ?? 0) ||
      (b.poValue12m ?? 0) - (a.poValue12m ?? 0),
  );
  for (const [n, r] of rows.entries())
    if (r.priority !== n + 1)
      await UPDATE.entity(`${NS}.SourceFinding`, { Material: r.Material, Supplier: r.Supplier, Plant: r.Plant }).with({
        priority: n + 1,
      });
}
