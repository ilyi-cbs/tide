// Fixture builders of the cockpit v3 shared entities (contract A1). Every
// builder returns a complete row with plausible defaults; pass overrides for
// what a test cares about. seedFixtures() inserts rows into the database
// (inside cds.test), filling ID / sourceText of findings like the kernel.
import cds from "@sap/cds";
import { findingID, sourceText } from "../../srv/cockpit/kernel/findings";
import type { EventRow, FindingRow } from "../../srv/cockpit/kernel/types";

type Row = Record<string, any>;
const NS = "tide.cockpit";
export const FIXTURE_AS_OF = "2026-10-05";
export const FIXTURE_SNAPSHOT = "00000000-0000-4000-8000-000000000001";

const LEVELS = Array.from({ length: 19 }, (_, i) => Math.round((0.05 + i * 0.05) * 100) / 100);

/** 19 levels 0.05…0.95 → days, monotone: from `lo` to `hi` linearly. */
export function levels(lo = 10, hi = 40): Record<string, number> {
  return Object.fromEntries(LEVELS.map((q, i) => [q.toFixed(2), Math.round((lo + ((hi - lo) * i) / 18) * 10) / 10]));
}

export function lineGrid(o: Row = {}): Row {
  const lv = levels(o.lo ?? 10, o.hi ?? 40);
  const { lo: _lo, hi: _hi, ...rest } = o;
  return {
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    snapshot_ID: FIXTURE_SNAPSHOT,
    Material: "M1",
    Supplier: "S1",
    Plant: "P1",
    source: "empirical",
    nOwn: 25,
    levels: JSON.stringify(lv),
    p10: lv["0.10"],
    p50: lv["0.50"],
    p80: lv["0.80"],
    p90: lv["0.90"],
    contextLevel: "own history of this source",
    ...rest,
  };
}

export function itemImpact(o: Row = {}): Row {
  return {
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    snapshot_ID: FIXTURE_SNAPSHOT,
    level: "customer_order_late",
    rank: 0,
    materialKind: "make_to_order",
    kindNote: null,
    expectedDate: "2026-10-20",
    cautiousDate: "2026-10-27",
    confirmedDate: null,
    needDate: "2026-10-15",
    delayDays: 5,
    customerDelayDays: 5,
    revenueAtRisk: 12400,
    revenueCautious: 15000,
    shortageFrom: null,
    shortageDays: null,
    coverageDays: null,
    stock: 0,
    productionOrders: 0,
    salesOrders: 1,
    note: null,
    scenarios: JSON.stringify([{ level: 0.5, arrival: "2026-10-20", revenue: 12400, customerDelayDays: 5 }]),
    md04: JSON.stringify([]),
    chain: JSON.stringify([]),
    source: "calculation",
    ...o,
  };
}

export function confirmation(o: Row = {}): Row {
  return {
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    line: 1,
    date: "2026-10-12",
    quantity: 10,
    enteredBy: "ilyesse.hettenbach@cbs-consulting.de",
    enteredAt: "2026-10-05T08:00:00Z",
    origin: "sap",
    ...o,
  };
}

export function finding(o: Partial<FindingRow> = {}): FindingRow {
  const row: FindingRow = {
    snapshot_ID: FIXTURE_SNAPSHOT,
    list: "at_risk",
    objectKey: "4500000001/10",
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    Material: "M1",
    Supplier: "S1",
    Plant: "P1",
    PurchasingGroup: "001",
    MRPController: "M01",
    itemTitle: "4500000001/10 · Bearing 6204",
    itemSubtitle: "Supplier S1 GmbH · Plant P1",
    issue: "May arrive after the requested date",
    issueTechnical: "gap 5 days, planned 2 days",
    impactLevel: null,
    impactCriticality: 0,
    impactText: null,
    revenueAtRisk: null,
    dueDate: "2026-10-15",
    nextStep: "Prepare a reminder",
    nextActionKind: "reminder",
    source: "empirical",
    chain: "Checked this morning → may arrive late → Next: prepare a reminder",
    technicalChain: "Trigger morning run at 06:00 → Check requested gap against the lead time range → Result at risk → Next reminder",
    trigger: "morning",
    status: "open",
    arrivedAt: null,
    rank: 1,
    ...o,
  };
  return { ...row, ID: row.ID ?? findingID(row.list, row.objectKey), sourceText: row.sourceText ?? sourceText(row.source) };
}

export function event(o: Partial<EventRow> = {}): EventRow {
  return {
    seq: 1,
    at: "2026-10-05T06:00:00Z",
    simTime: null,
    kind: "morning",
    title: "Morning run",
    findingID: null,
    objectKey: null,
    source: null,
    status: "done",
    modelCalls: 0,
    costUnits: 0,
    latencyMs: 0,
    ...o,
  };
}

export function snapshot(o: Row = {}): Row {
  return {
    ID: FIXTURE_SNAPSHOT,
    asOf: FIXTURE_AS_OF,
    datasetName: "fixture",
    status: "done",
    startedAt: "2026-10-05T06:00:00Z",
    finishedAt: "2026-10-05T06:01:00Z",
    backend: "fake",
    ...o,
  };
}

export interface Seed {
  snapshots?: Row[];
  lineGrids?: Row[];
  itemImpacts?: Row[];
  confirmations?: Row[];
  findings?: Partial<FindingRow>[];
  events?: Partial<EventRow>[];
  buyers?: Row[];
  actions?: Row[];
  /** DatasetInfo "current" with this as-of date (default FIXTURE_AS_OF); false = none. */
  asOf?: string | false;
}

/**
 * Inserts the given rows (builders applied, so partial rows are fine).
 * `db` = cds.db or a connected database service. Returns the inserted rows.
 */
export async function seedFixtures(db: cds.Service = cds.db, seed: Seed = {}) {
  const { INSERT, UPSERT } = cds.ql;
  const out = {
    snapshots: (seed.snapshots ?? [snapshot()]).map((r) => snapshot(r)),
    lineGrids: (seed.lineGrids ?? []).map(lineGrid),
    itemImpacts: (seed.itemImpacts ?? []).map(itemImpact),
    confirmations: (seed.confirmations ?? []).map(confirmation),
    findings: (seed.findings ?? []).map(finding),
    events: (seed.events ?? []).map((e, i) => event({ seq: i + 1, ...e })),
    buyers: seed.buyers ?? [],
    actions: seed.actions ?? [],
  };
  if (seed.asOf !== false)
    await db.run(
      UPSERT.into("tide.s4.DatasetInfo").entries({ ID: "current", name: "fixture", asOf: seed.asOf ?? FIXTURE_AS_OF, containsCustomerData: false }),
    );
  const put = async (entity: string, rows: Row[]) => {
    if (rows.length) await db.run(UPSERT.into(`${NS}.${entity}`).entries(rows));
  };
  await put("Snapshot", out.snapshots);
  await put("LineGrid", out.lineGrids);
  await put("ItemImpact", out.itemImpacts);
  await put("Confirmation", out.confirmations);
  await put("Finding", out.findings);
  for (const row of out.findings) {
    let expert: any = {};
    try { expert = row.expert ? JSON.parse(row.expert) : {}; } catch { expert = {}; }
    if (row.list === "freetext" && row.expert)
      await db.run(UPSERT.into(`${NS}.FreetextDetail`).entries({ finding_ID: row.ID, requestText: "", codingText: "", segment: null, demo: !!expert.demo, contextRows: expert.contextRows ?? 0, inputs: JSON.stringify(expert.inputs ?? []) }));
    if (row.list === "at_risk" && row.expert)
      await db.run(UPSERT.into(`${NS}.AtRiskDetail`).entries({ finding_ID: row.ID, source: null, lateShare: expert.p_late ?? null, gapDays: expert.gap ?? 0, plannedDays: expert.plannedDays ?? null, plannedFlag: expert.plannedFlag ?? null, riskRank: expert.riskRank ?? 0, ruleVerdict: expert.ruleVerdict ?? null, ownDeliveries: expert.nOwn ?? 0, contextLevel: expert.contextLevel ?? null, gridRef: expert.grid ?? "", fastDays: null, typicalDays: null, slowDays: null, dueCriticality: 0 }));
    if (row.list === "mm_pdt" && row.expert) {
      const detail = await db.run(UPSERT.into(`${NS}.MmPdtDetail`).entries({ finding_ID: row.ID, proposalDays: expert.proposalDays ?? null, proposalRule: expert.proposalRule ?? null, masterDays: expert.masterDays ?? null, masterFlag: expert.masterFlag ?? null, difference: expert.difference ?? null, tolerance: expert.tolerance ?? null, orders12m: expert.pos12m ?? null, note: expert.note ?? null }));
      for (const source of expert.sources ?? []) await db.run(UPSERT.into(`${NS}.MmPdtSource`).entries({ finding_finding_ID: row.ID, supplier: source.Supplier, supplierName: source.supplierName ?? null, orders12m: source.pos ?? null, orderShare: source.share ?? null, ownDeliveries: source.nOwn ?? null, typicalDays: source.median ?? null, infoRecordDays: source.infoRecordDays ?? null, source: source.source ?? null, pdtFindingID: source.findingID ?? null }));
      void detail;
    }
  }
  await put("Event", out.events);
  await put("Buyer", out.buyers);
  if (out.actions.length) await db.run(INSERT.into(`${NS}.Actions`).entries(out.actions));
  return out;
}
