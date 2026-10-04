import assert from "node:assert/strict";
import { test } from "node:test";
import { promisedFor } from "../srv/cockpit/prepare/open-items";

const demand: any = {
  direct: new Map([["PO1/10", ["SO1/10"]]]),
  bySoItem: new Map([
    ["SO1/10", { SalesOrder: "SO1", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 }],
    ["SO2/10", { SalesOrder: "SO2", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 }],
    ["SO3/10", { SalesOrder: "SO3", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 }],
    ["SO4/10", { SalesOrder: "SO4", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 }],
  ]),
  byMatPlant: new Map([
    ["M1|P1", [
      { SalesOrder: "SO1", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 },
      { SalesOrder: "SO2", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 },
      { SalesOrder: "SO3", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 },
      { SalesOrder: "SO4", SalesOrderItem: "10", RequestedQuantity: 1, ConfdDelivQtyInOrderQtyUnit: 0 },
    ]],
  ]),
};

test("direct sales-order assignment is not double-counted in the stock FIFO upper bound", () => {
  const rows = [
    { PurchaseOrder: "PO1", PurchaseOrderItem: "10", RequestedDate: "2026-01-01", Category: "third_party", OpenQuantity: 1 },
    { PurchaseOrder: "PO2", PurchaseOrderItem: "10", RequestedDate: "2026-01-02", Category: "stock", Material: "M1", Plant: "P1", OpenQuantity: 2 },
  ];
  const result = promisedFor(rows, demand);
  assert.deepEqual(result.get("PO1/10"), { link: "direct", promised: [demand.bySoItem.get("SO1/10")] });
  assert.deepEqual(result.get("PO2/10"), {
    link: "upper_bound",
    promised: [demand.bySoItem.get("SO2/10"), demand.bySoItem.get("SO3/10")],
  });
});
