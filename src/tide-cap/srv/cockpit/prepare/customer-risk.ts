// Customer risk aggregation of prepareDay: revenue at risk per customer from
// the open items' impacts.
import type { Row } from "../kernel/model-calls";
import { round1 } from "../logic";
import { sumRevenue } from "../impact/domain/impact";

export function customerRisks(impacts: Row[], items: Row[], snapshotId: string) {
  const delay = new Map(items.map((i) => [`${i.PurchaseOrder}/${i.PurchaseOrderItem}`, i.delayP80Days ?? 0]));
  const by = new Map<string, Row>();
  const seen = new Set<string>();
  const retainAmount = (amounts: Map<string, number | null>, key: string, amount: number | null) => {
    const previous = amounts.get(key);
    amounts.set(key, amount == null || previous === null ? null : Math.max(previous ?? 0, amount));
  };
  for (const i of impacts) {
    let c = by.get(i.Customer);
    if (!c) {
      c = {
        Customer: i.Customer,
        CustomerName: i.CustomerName,
        snapshot_ID: snapshotId,
        riskP50: new Map<string, number | null>(),
        riskP80: new Map<string, number | null>(),
        amounts: new Map<string, number | null>(),
        items: new Set<string>(),
        salesItems: 0,
        worstDelayDays: 0,
        direct: new Map<string, number | null>(),
      };
      by.set(i.Customer, c);
    }
    const so = `${i.SalesOrder}/${i.SalesOrderItem}`;
    const po = `${i.PurchaseOrder}/${i.PurchaseOrderItem}`;
    if (!seen.has(`${i.Customer}|${so}`)) {
      seen.add(`${i.Customer}|${so}`);
      c.salesItems++;
    }
    const amount = i.openAmount == null ||
      (typeof i.openAmount === "string" && !i.openAmount.trim()) ||
      !Number.isFinite(Number(i.openAmount)) ? null : Math.max(0, Number(i.openAmount));
    retainAmount(c.amounts, so, amount);
    if (i.atRiskP50) retainAmount(c.riskP50, so, amount);
    if (i.atRiskP80) {
      retainAmount(c.riskP80, so, amount);
      if (i.link === "direct") retainAmount(c.direct, so, amount);
      c.items.add(po);
      c.worstDelayDays = Math.max(c.worstDelayDays, delay.get(po) ?? 0);
    }
  }
  const total = (amounts: Map<string, number | null>) => sumRevenue([...amounts.values()]);
  return [...by.values()].map((c) => {
    const p50 = total(c.riskP50);
    const p80 = total(c.riskP80);
    const amount = total(c.amounts);
    const direct = total(c.direct);
    return {
      Customer: c.Customer,
      CustomerName: c.CustomerName,
      snapshot_ID: c.snapshot_ID,
      revenueAtRiskP50: p50 == null ? null : Math.round(p50),
      revenueAtRiskP80: p80 == null ? null : Math.round(p80),
      openAmount: amount == null ? null : Math.round(amount),
      items: c.items.size,
      salesItems: c.salesItems,
      worstDelayDays: c.worstDelayDays,
      directShare: p80 && direct != null ? round1((direct / p80) * 100) / 100 : null,
    };
  });
}
