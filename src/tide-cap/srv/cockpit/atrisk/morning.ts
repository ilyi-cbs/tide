// Morning step of deliveries at risk (P-1): grids for every open item (own
// history or one quantile run per plant), candidates in the window, P(late)
// per source, the ranked list; Finding rows (at_risk) and LineGrid rows in
// one transaction. Dry run: the plant runs are estimated, nothing is written.
import cds from "@sap/cds";
import { addWorkingDays } from "../kernel/calendar";
import { replaceDetectorCases } from "../kernel/detector-writers";
import { openAtRiskProjectionRows } from "../kernel/compatibility-projection";
import { inTx, type Row } from "../kernel/model-calls";
import { writePreparation } from "../kernel/publication";
import type { FindingRow, StepContext } from "../kernel/types";
import {
  HORIZON_WORKING_DAYS,
  gapDays,
  gridValues,
  empiricalGrid,
  gridAt,
  inWindow,
  lateRates,
  morningList,
  parseGrid,
  pExceedEmpirical,
  pExceedFromQuantiles,
  rateFor,
  ruleFires,
  sourceFor,
  type AtRiskSource,
  type LateRates,
  type RuleVerdict,
} from "./domain/rules";
import { findingRow, type Candidate } from "./finding";
import {
  CTX_PLANT,
  GRID_ENTITY,
  FACT,
  FACT_LIVE,
  histories,
  iso,
  itemKey,
  lineGridRow,
  modelGrids,
  names,
  numOrNull,
  openItems,
  rateRows,
  skey,
  type LineGridRow,
} from "./grids";

const { INSERT, DELETE } = cds.ql;

export async function runMorning(
  ctx: StepContext,
): Promise<{ findings: number; grids: number }> {
  const { asOf, snapshotId, dryRun, meter } = ctx;
  const [open, hist, rates] = await inTx(async () => {
    const [o, h, r] = await Promise.all([
      openItems(asOf, dryRun ? FACT_LIVE : FACT),
      histories(asOf, dryRun ? FACT_LIVE : FACT),
      rateRows(asOf, dryRun ? FACT_LIVE : FACT),
    ]);
    return [o, h, lateRates(r, asOf)] as const;
  });
  const own = (i: Row) =>
    i.Material ? (hist.get(skey(i.Material, i.Supplier, i.Plant)) ?? []) : [];
  const pool = new Map<string, number[]>();
  for (const [k, h] of hist) {
    const plant = k.split("|")[2];
    (pool.get(plant) ?? pool.set(plant, []).get(plant)!).push(...h);
  }

  // Arrival forecasts always use TabPFN; own history remains evidence for risk scoring.
  const grids = new Map<string, LineGridRow>();
  const sparse = new Map<string, Row[]>();
  for (const i of open) {
    if (i.Plant)
      (sparse.get(i.Plant) ?? sparse.set(i.Plant, []).get(i.Plant)!).push(i);
  }
  const model = await modelGrids(sparse, asOf, dryRun, meter);
  if (dryRun) return { findings: 0, grids: 0 };
  for (const i of open) {
    const m = model.get(itemKey(i));
    const ownGrid = own(i).length >= 20 ? empiricalGrid(own(i)) : null;
    const selected = m?.grid ?? ownGrid;
    const selectedSource = m?.source ?? (ownGrid ? "empirical" : null);
    if (selected && selectedSource)
      grids.set(
        itemKey(i),
        lineGridRow(
          i,
          selected,
          selectedSource,
          own(i).length,
          CTX_PLANT,
          snapshotId,
          "morning",
          { asOf, pool: pool.get(i.Plant), ageConditioned: m?.ageConditioned },
          {
            own: ownGrid,
            agreement: ownGrid && m?.grid
              ? (gridAt(ownGrid, 0.5)! >= gridAt(m.grid, 0.1)! && gridAt(ownGrid, 0.5)! <= gridAt(m.grid, 0.9)! && gridAt(m.grid, 0.5)! >= gridAt(ownGrid, 0.1)! && gridAt(m.grid, 0.5)! <= gridAt(ownGrid, 0.9)! ? "aligned" : "divergent")
              : null,
            runID: m?.runID,
            inputFingerprint: m?.inputFingerprint,
            backend: m?.backend,
            trainingRows: m?.trainingRows,
            fallback: m?.fallback,
          },
        ),
      );
  }

  const cands = candidates(open, asOf, own, rates, grids);
  const discovered = morningList(cands);
  // The cap controls discovery only. Once surfaced, an unresolved eligible
  // delivery remains in follow-up even when its score drops below the top 20.
  const prior = await inTx(openAtRiskProjectionRows);
  const priorKeys = new Set(prior.map((row) => row.objectKey));
  const selectedKeys = new Set(discovered.map((candidate) => itemKey(candidate.item)));
  const rankedFollowUp = cands.filter((candidate) => priorKeys.has(itemKey(candidate.item)) && !selectedKeys.has(itemKey(candidate.item)));
  const currentOpen = new Map(open.map((item) => [itemKey(item), item]));
  const retained: FindingRow[] = [];
  for (const old of prior) {
    if (selectedKeys.has(old.objectKey) || rankedFollowUp.some((candidate) => itemKey(candidate.item) === old.objectKey)) continue;
    const item = currentOpen.get(old.objectKey);
    const requested = item && iso(item.RequestedDate);
    if (!item || !requested || requested < asOf) continue;
    retained.push({ ...old, list: "at_risk", objectKey: old.objectKey, snapshot_ID: snapshotId, rank: null, atRiskDetail: old.atRiskDetail ?? undefined });
  }
  const listed = [...discovered, ...rankedFollowUp];
  const nm = await inTx(() =>
    names(
      listed.map((c) => c.item.Material),
      listed.map((c) => c.item.Supplier),
      listed.map((c) => c.item.Plant),
    ),
  );
  // rank = position in the sorted list (1 = first); impact re-ranks later.
  const rows = listed.map((c, k) =>
    findingRow(c, { rank: k + 1, names: nm, arrived: false, snapshotId, asOf }),
  );
  rows.push(...retained);

  const all = [...grids.values()];
  if (ctx.publication) ctx.publication.lineGrids = all;
  await writePreparation(ctx, async () => {
    await replaceDetectorCases(snapshotId, ["at_risk"], rows);
    await DELETE.from(GRID_ENTITY);
    for (let k = 0; k < all.length; k += 500)
      await INSERT.into(GRID_ENTITY).entries(all.slice(k, k + 500));
  });
  return { findings: rows.length, grids: all.length };
}

/** Open items without a receipt before asOf, requested in [asOf, asOf + 10 working days], with source and P(late). */
function candidates(
  open: Row[],
  asOf: string,
  own: (i: Row) => number[],
  rates: LateRates,
  grids: Map<string, LineGridRow>,
): Candidate[] {
  const horizonEnd = addWorkingDays(asOf, HORIZON_WORKING_DAYS);
  const out: Candidate[] = [];
  for (const i of open) {
    if (i.AvailableDate && iso(i.AvailableDate)! < asOf) continue;
    const req = iso(i.RequestedDate);
    const po = iso(i.PurchaseOrderDate);
    if (!req || !po || !inWindow(req, asOf, horizonEnd)) continue;
    const gap = gapDays(po, req);
    const planned = numOrNull(i.PlannedDays);
    const h = own(i);
    const g = grids.get(itemKey(i)) ?? null;
    const grid = g ? parseGrid(g.levels) : null;
    const baselineSource = sourceFor(planned, h.length);
    // A realistic maintained time remains a deterministic check. Otherwise
    // model/fallback grids are primary while own history stays as evidence.
    // The grid's stored provenance wins; fake/fallback/unknown never read as tabpfn.
    const gridSource = g?.source;
    const source: AtRiskSource = baselineSource === "rule"
      ? "rule"
      : gridSource === "empirical" || gridSource === "fallback" ||
          gridSource === "fake" || gridSource === "tabpfn"
        ? gridSource
        : baselineSource === "empirical"
          ? "empirical"
          : "fallback";
    let ruleVerdict: RuleVerdict | null = null;
    let pLate: number | null = null;
    if (source === "rule") {
      ruleVerdict = ruleFires(gap, planned as number)
        ? "fires"
        : "does_not_fire";
      pLate = rateFor(rates, ruleVerdict, i.Plant);
    } else if (source === "empirical") pLate = pExceedEmpirical(h, gap);
    else if (grid) pLate = pExceedFromQuantiles(gridValues(grid), gap);
    out.push({
      PurchaseOrder: i.PurchaseOrder,
      PurchaseOrderItem: i.PurchaseOrderItem,
      PurchasingGroup: i.PurchasingGroup ?? null,
      source,
      gap,
      ruleVerdict,
      pLate,
      net: Number(i.NetAmountEUR ?? i.NetAmount ?? 0) || 0,
      item: i,
      plannedDays: planned,
      nOwn: h.length,
      grid,
      gridSource: g?.source ?? null,
      contextLevel: g?.contextLevel ?? null,
    });
  }
  return out;
}
