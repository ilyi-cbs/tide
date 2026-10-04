// Shared lookups of prepareDay: exchange rates, customer demand and links,
// material/supplier display names.
import cds from "@sap/cds";
import type { Row } from "../kernel/model-calls";
import { eurAmount } from "../impact/domain/planning";

const { SELECT } = cds.ql;
const salesItemKey = (order: string, item: string) => `${order}/${String(item).replace(/^0+(?=\d)/, "")}`;

export async function rates(): Promise<Map<string, number>> {
  const rows: Row[] = await SELECT.from("tide.s4.ExchangeRate");
  const m = new Map<string, number>([["EUR", 1]]);
  for (const r of rows) m.set(r.SourceCurrency, Number(r.ExchangeRate));
  return m;
}

/** Open customer demand per material and plant, and third-party links. */
export async function demand(asOf: string, fx: Map<string, number>) {
  const items: Row[] = await SELECT.from("tide.s4.SalesOrderItem")
    .columns(
      "SalesOrder",
      "SalesOrderItem",
      "Product",
      "Plant",
      "RequestedDeliveryDate",
      "ConfirmedDeliveryDate",
      "NetAmount",
      "RequestedQuantity",
      "ConfdDelivQtyInOrderQtyUnit",
      "TransactionCurrency as Currency",
      "SalesOrderItemCategory as Category",
      "header.SoldToParty as Customer",
    )
    .where`DeliveryStatus != 'C'`;
  const customers = new Map<string, string>(
    ((await SELECT.from("tide.s4.Customer").columns("Customer", "CustomerName")) as Row[]).map(
      (c) => [c.Customer, c.CustomerName ?? c.Customer],
    ),
  );
  const byMatPlant = new Map<string, Row[]>();
  const bySoItem = new Map<string, Row>();
  for (const i of items) {
    const row = {
      ...i,
      CustomerName: customers.get(i.Customer) ?? i.Customer,
      openAmount: eurAmount(i.NetAmount, i.Currency, fx),
      promisedDate: i.ConfirmedDeliveryDate ?? i.RequestedDeliveryDate,
    };
    bySoItem.set(salesItemKey(i.SalesOrder, i.SalesOrderItem), row);
    const k = `${i.Product}|${i.Plant}`;
    // Third-party items are fulfilled by their supplier and must not be
    // mistaken for stock demand covered by an unrelated warehouse PO.
    if (i.Category !== "TAS") (byMatPlant.get(k) ?? byMatPlant.set(k, []).get(k)!).push(row);
  }
  for (const list of byMatPlant.values())
    list.sort((a, b) => (a.promisedDate < b.promisedDate ? -1 : 1));
  const links: Row[] = await SELECT.from("tide.s4.PurchaseOrderAccountAssignment")
    .columns("PurchaseOrder", "PurchaseOrderItem", "SalesOrder", "SalesOrderItem", "IsDeleted")
    .where`SalesOrder != '' and (IsDeleted is null or IsDeleted = false)`;
  const direct = new Map<string, string[]>();
  for (const l of links) {
    const k = `${l.PurchaseOrder}/${String(l.PurchaseOrderItem).replace(/^0+(?=\d)/, "")}`;
    (direct.get(k) ?? direct.set(k, []).get(k)!).push(salesItemKey(l.SalesOrder, l.SalesOrderItem));
  }
  return { byMatPlant, bySoItem, direct };
}

export async function names() {
  const mats: Row[] = await SELECT.from("tide.s4.ProductDescription")
    .columns("Product", "ProductDescription")
    .where({ Language: "EN" });
  const sups: Row[] = await SELECT.from("tide.s4.Supplier").columns("Supplier", "SupplierName");
  return {
    material: new Map(mats.map((m) => [m.Product, m.ProductDescription])),
    supplier: new Map(sups.map((s) => [s.Supplier, s.SupplierName])),
  };
}

export type Demand = Awaited<ReturnType<typeof demand>>;
export type Names = Awaited<ReturnType<typeof names>>;
