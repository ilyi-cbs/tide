// Finding row (list at_risk) of one scored item: the one place that maps a
// verdict and its item onto the first-look fields (contract §3, P-11).
import type { Row } from "../kernel/model-calls";
import type { FindingRow, Source } from "../kernel/types";
import { daysBetween } from "../kernel/calendar";
import {
  gridAt,
  pdtFlag,
  riskRank,
  type AtRiskSource,
  type Grid,
  type Scored,
} from "./domain/rules";
import {
  NEXT_STEP,
  chainText,
  expertJson,
  issueTechnical,
  issueText,
  itemSubtitle,
  itemTitle,
  technicalChainText,
} from "./domain/texts";
import { iso, itemKey, type Names } from "./grids";
import { priorityFields } from "../kernel/priority";

/** "<code> – <name>" combined display for a code-list field; falls back to the code alone. */
function display(
  code: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (!code) return null;
  return name ? `${code} – ${name}` : code;
}

export interface Candidate extends Scored {
  item: Row;
  plannedDays: number | null;
  nOwn: number;
  grid: Grid | null;
  gridSource: Source | null;
  contextLevel: string | null;
}

export interface RowOpts {
  rank: number | null;
  names: Names;
  arrived: boolean;
  snapshotId: string | null;
  asOf: string;
}

export function findingRow(c: Candidate, o: RowOpts): FindingRow {
  const i = c.item;
  const flag = pdtFlag(c.plannedDays);
  const source: AtRiskSource =
    c.source === "tabpfn" &&
    (c.gridSource === "fallback" || c.gridSource === "fake")
      ? c.gridSource
      : c.source;
  const text = {
    source,
    gap: c.gap,
    plannedDays: c.plannedDays,
    flag,
    p50: gridAt(c.grid, 0.5),
    arrived: o.arrived,
  };
  const dueDate = iso(i.RequestedDate);
  const daysToDue = dueDate ? daysBetween(o.asOf, dueDate) : null;
  return {
    snapshot_ID: o.snapshotId,
    list: "at_risk",
    objectKey: itemKey(i),
    PurchaseOrder: i.PurchaseOrder,
    PurchaseOrderItem: i.PurchaseOrderItem,
    Material: i.Material ?? null,
    Supplier: i.Supplier ?? null,
    supplierDisplay: display(i.Supplier, o.names.supplier.get(i.Supplier)),
    Plant: i.Plant ?? null,
    plantDisplay: display(i.Plant, o.names.plant.get(i.Plant)),
    PurchasingGroup: i.PurchasingGroup ?? null,
    MRPController: i.MRPController ?? null,
    itemTitle: itemTitle(
      i.PurchaseOrder,
      i.PurchaseOrderItem,
      o.names.material.get(i.Material) ?? i.Material,
    ),
    itemSubtitle: itemSubtitle(
      o.names.supplier.get(i.Supplier) ?? i.Supplier,
      i.Plant,
    ),
    issue: issueText(text).slice(0, 300),
    issueTechnical: issueTechnical(text).slice(0, 300),
    impactLevel: null,
    impactCriticality: null,
    impactText: null,
    revenueAtRisk: null,
    ...priorityFields(null, null, o.asOf, null),
    dueDate,
    atRiskDetail: {
      source,
      lateShare: c.pLate === null ? null : Math.round(c.pLate * 1000) / 1000,
      gapDays: c.gap,
      plannedDays: c.plannedDays,
      plannedFlag: flag,
      riskRank: riskRank(c),
      ruleVerdict: c.ruleVerdict,
      ownDeliveries: c.nOwn,
      contextLevel: c.contextLevel,
      gridRef: `LineGrids(PurchaseOrder='${i.PurchaseOrder}',PurchaseOrderItem='${i.PurchaseOrderItem}')`,
      fastDays: gridAt(c.grid, 0.1),
      typicalDays: gridAt(c.grid, 0.5),
      slowDays: gridAt(c.grid, 0.9),
      dueCriticality:
        daysToDue === null ? 0 : daysToDue <= 3 ? 1 : daysToDue <= 7 ? 2 : 0,
    },
    expert: expertJson({
      source,
      pLate: c.pLate,
      gap: c.gap,
      plannedDays: c.plannedDays,
      flag,
      riskRank: riskRank(c),
      ruleVerdict: c.ruleVerdict,
      nOwn: c.nOwn,
      contextLevel: c.contextLevel,
      gridRef: `LineGrids(PurchaseOrder='${i.PurchaseOrder}',PurchaseOrderItem='${i.PurchaseOrderItem}')`,
    }),
    nextStep: NEXT_STEP,
    nextActionKind: "reminder",
    source,
    chain: chainText(text).slice(0, 1000),
    technicalChain: technicalChainText(text).slice(0, 1000),
    trigger: o.arrived ? "arrived" : "morning",
    status: "open",
    arrivedAt: o.arrived ? new Date().toISOString() : null,
    rank: o.rank,
  };
}
