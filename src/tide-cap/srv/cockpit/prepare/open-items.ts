// Step 4 of prepareDay: open items read model — expected availability
// p10..p90, status, customer impact.
import { STATUS_CRITICALITY, STATUS_RANK, VERDICT_TEXT, at, daysBetween, effectiveDays, expectation, itemStatus, pdtVerdict } from "../logic";
import type { Row } from "../kernel/model-calls";
import { key } from "./shared";
import type { RangeRow } from "./ranges";
import type { Demand, Names } from "./lookups";
import { sumRevenue } from "../impact/domain/impact";

export function effectivePdt(o: Row, irByKey: Map<string, Row>, masterByKey: Map<string, Row>) {
  const ir = irByKey.get(key(o.Material, o.Supplier, o.Plant));
  const irDays = ir ? Number(ir.MaterialPlannedDeliveryDurn) : null;
  const masterDays = masterByKey.get(`${o.Material}|${o.Plant}`)?.PlannedDeliveryDurationInDays ?? null;
  return { ...effectiveDays(irDays, masterDays), irDays, masterDays };
}

/**
 * Customer demand each open item serves. Third-party/MTO items use their
 * account assignment; stock items first use exact material-plant fulfillment
 * links from the PO account assignment table when present, then remaining
 * demand is allocated in requested-date FIFO order as an upper bound.
 */
export function promisedFor(rows: Row[], d: Demand) {
  const out = new Map<string, { link: string | null; promised: Row[] }>();
  const stockCursor = new Map<string, number>();
  const linkedDemand = new Set([...d.direct.values()].flat());
  const sorted = [...rows].sort((a, b) =>
    (a.RequestedDate ?? "") < (b.RequestedDate ?? "") ? -1 : 1,
  );
  for (const o of sorted) {
    const itemKey = `${o.PurchaseOrder}/${o.PurchaseOrderItem}`;
    const promised: Row[] = [];
    let link: string | null = null;
    const directSo = d.direct.get(itemKey);
    if (directSo?.length) {
      link = "direct";
      for (const so of directSo) {
        const s = d.bySoItem.get(so);
        if (s) {
          promised.push(s);
        }
      }
    } else if (o.Category === "stock" && o.Material) {
      const mp = `${o.Material}|${o.Plant}`;
      const list = d.byMatPlant.get(mp) ?? [];
      let i = stockCursor.get(mp) ?? 0;
      while (i < list.length && linkedDemand.has(`${list[i].SalesOrder}/${list[i].SalesOrderItem}`)) i++;
      let covered = 0;
      while (i < list.length && covered < o.OpenQuantity) {
        const soKey = `${list[i].SalesOrder}/${list[i].SalesOrderItem}`;
        if (linkedDemand.has(soKey)) {
          i++;
          continue;
        }
        const fulfilled = Number(list[i].ConfdDelivQtyInOrderQtyUnit ?? 0);
        const requested = Number(list[i].RequestedQuantity ?? 0);
        const remaining = Math.max(0, requested - fulfilled);
        if (remaining <= 0) {
          i++;
          continue;
        }
        covered += remaining;
        promised.push(list[i]);
        linkedDemand.add(soKey);
        i++;
      }
      stockCursor.set(mp, i);
      if (promised.length) link = "upper_bound";
    }
    out.set(itemKey, { link, promised });
  }
  return out;
}

/** The read-model row of one open item and its customer impacts. */
export function buildItem(
  o: Row,
  r: RangeRow | undefined,
  pdt: ReturnType<typeof effectivePdt>,
  demandOf: { link: string | null; promised: Row[] },
  nm: Names,
  asOf: string,
  snapshotId: string,
) {
  const grid = r?.grid ?? null;
  const e = expectation(o.PurchaseOrderDate, grid, asOf);
  const status = itemStatus(o.RequestedDate, e, asOf);
  const verdict = o.Material ? pdtVerdict(pdt.days, grid) : "no_range";
  const { link, promised } = demandOf;
  const impacts: Row[] = [];
  const p50Amounts: Array<number | null> = [];
  const p80Amounts: Array<number | null> = [];
  const custNames = new Set<string>();
  for (const s of promised) {
    const riskP50 = !!(e.p50 && s.promisedDate && e.p50 > s.promisedDate);
    const riskP80 = !!(e.p80 && s.promisedDate && e.p80 > s.promisedDate) || riskP50;
    if (riskP50) p50Amounts.push(s.openAmount);
    if (riskP80) p80Amounts.push(s.openAmount);
    if (riskP80) custNames.add(s.CustomerName);
    impacts.push({
      PurchaseOrder: o.PurchaseOrder,
      PurchaseOrderItem: o.PurchaseOrderItem,
      SalesOrder: s.SalesOrder,
      SalesOrderItem: s.SalesOrderItem,
      Customer: s.Customer,
      CustomerName: s.CustomerName,
      Product: s.Product,
      promisedDate: s.promisedDate,
      openAmount: s.openAmount == null ? null : Math.round(s.openAmount * 100) / 100,
      link,
      atRiskP50: riskP50,
      atRiskP80: riskP80,
    });
  }
  const p50 = sumRevenue(p50Amounts);
  const p80 = sumRevenue(p80Amounts);
  const planned = pdt.days;
  const reason =
    status === "overdue"
      ? `requested date ${o.RequestedDate} has passed without a goods receipt`
      : !grid
        ? "no lead-time range for this source"
        : `SAP plans ${planned ?? "no"} days (${VERDICT_TEXT[verdict]}); similar deliveries take ${at(grid, 0.1)} to ${at(grid, 0.9)} days (${r?.source}, n=${r?.source === "empirical" ? r?.nOwn : r?.contextRows})`;
  const item: Row = {
    PurchaseOrder: o.PurchaseOrder,
    PurchaseOrderItem: o.PurchaseOrderItem,
    snapshot_ID: snapshotId,
    Material: o.Material,
    MaterialText: nm.material.get(o.Material) ?? null,
    Supplier: o.Supplier,
    SupplierName: nm.supplier.get(o.Supplier) ?? o.Supplier,
    Plant: o.Plant,
    PurchasingGroup: o.PurchasingGroup,
    MRPController: o.MRPController,
    PurchaseOrderDate: o.PurchaseOrderDate,
    RequestedDate: o.RequestedDate,
    OpenQuantity: o.OpenQuantity,
    OrderQuantity: o.OrderQuantity,
    Unit: o.Unit,
    NetAmount: o.NetAmount,
    Currency: o.Currency,
    category: o.Category,
    plannedDays: planned,
    plannedFrom: pdt.from,
    pdtVerdict: verdict,
    requestedGapDays: o.RequestedGapDays,
    ageDays: daysBetween(o.PurchaseOrderDate, asOf),
    expectedP10: e.p10,
    expectedP50: e.p50,
    expectedP80: e.p80,
    expectedP90: e.p90,
    delayP50Days: e.p50 && o.RequestedDate ? Math.max(0, daysBetween(o.RequestedDate, e.p50)) : null,
    delayP80Days: e.p80 && o.RequestedDate ? Math.max(0, daysBetween(o.RequestedDate, e.p80)) : null,
    status,
    statusCriticality: STATUS_CRITICALITY[status],
    source: status === "overdue" ? "rule" : (r?.source ?? "none"),
    reason: reason.slice(0, 300),
    revenueAtRiskP50: p50 == null ? null : Math.round(p50),
    revenueAtRiskP80: p80 == null ? null : Math.round(p80),
    customers: new Set(promised.map((p) => p.Customer)).size,
    customerNames: [...custNames].slice(0, 5).join(", ").slice(0, 300) || null,
    impactLink: link,
  };
  return { item, impacts };
}

/** Worklist order: status, then customer revenue at risk, then delay. */
export function byPriority(a: Row, b: Row) {
  return (
    STATUS_RANK[a.status as keyof typeof STATUS_RANK] - STATUS_RANK[b.status as keyof typeof STATUS_RANK] ||
    (b.revenueAtRiskP80 ?? 0) - (a.revenueAtRiskP80 ?? 0) ||
    (b.delayP80Days ?? 0) - (a.delayP80Days ?? 0)
  );
}

export function openItems(
  rows: Row[],
  rangeMap: Map<string, RangeRow>,
  d: Demand,
  masterByKey: Map<string, Row>,
  irRows: Row[],
  nm: Names,
  asOf: string,
  snapshotId: string,
) {
  const irByKey = new Map(irRows.map((r) => [key(r.Material, r.Supplier, r.Plant), r]));
  const demandBy = promisedFor(rows, d);
  const items: Row[] = [];
  const impacts: Row[] = [];
  for (const o of rows) {
    const built = buildItem(
      o,
      rangeMap.get(key(o.Material, o.Supplier, o.Plant)),
      effectivePdt(o, irByKey, masterByKey),
      demandBy.get(`${o.PurchaseOrder}/${o.PurchaseOrderItem}`)!,
      nm,
      asOf,
      snapshotId,
    );
    items.push(built.item);
    impacts.push(...built.impacts);
  }
  items.sort(byPriority);
  items.forEach((i, n) => (i.priority = n + 1));
  return { items, impacts };
}
