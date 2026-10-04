import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryPriority, deliveryWorkPriority, prioritySort, PRIORITY_CRITICALITY, PRIORITY_ORDER } from "../srv/cockpit/impact/domain/priority";

test("delivery priority follows customer need, production impact and overdue age", () => {
  const asOf = "2026-10-05";
  assert.equal(deliveryPriority("customer_order_late", "2026-10-08", asOf, null), "Critical");
  assert.equal(deliveryPriority("customer_order_late", "2026-10-09", asOf, null), "High");
  assert.equal(deliveryPriority("customer_order_late", "2026-10-12", asOf, null), "Medium");
  assert.equal(deliveryPriority("customer_order_late", "2026-10-14", asOf, null), "Low");
  assert.equal(deliveryPriority("customer_order_late", "2026-10-04", asOf, 31), "Critical");
  assert.equal(deliveryPriority("production_affected", null, asOf, null), "High");
  assert.equal(deliveryPriority("stock_uncovered", null, asOf, null), "Medium");
  assert.equal(deliveryPriority("no_impact", null, asOf, 31), "Medium");
  assert.equal(deliveryPriority("no_impact", null, asOf, 30), "Low");
  assert.equal(deliveryPriority("covered_by_stock", null, asOf, 45), "Medium");
  assert.deepEqual(["Critical", "High", "Medium", "Low"].map((p) => PRIORITY_ORDER[p as keyof typeof PRIORITY_ORDER]), [0, 1, 2, 3]);
  assert.deepEqual(["Critical", "High", "Medium", "Low"].map((p) => PRIORITY_CRITICALITY[p as keyof typeof PRIORITY_CRITICALITY]), [1, 1, 2, 3]);
  const rows = [{ deliveryPriorityOrder: 1, revenueAtRisk: 100 }, { deliveryPriorityOrder: 0, revenueAtRisk: 1 }, { deliveryPriorityOrder: 1, revenueAtRisk: 1000 }];
  assert.deepEqual(rows.sort(prioritySort).map((r) => r.revenueAtRisk), [1, 1000, 100]);
});

test("delivery work priority starts with lateness and only escalates for impact or workflow", () => {
  const input = { asOf: "2026-10-05", impactLevel: null, needDate: null, attention: null } as const;
  assert.equal(deliveryWorkPriority({ ...input, phase: "at_risk", forecastDelayDays: 2, daysOverdue: null }), "Low");
  assert.equal(deliveryWorkPriority({ ...input, phase: "at_risk", forecastDelayDays: 9, daysOverdue: null }), "Medium");
  assert.equal(deliveryWorkPriority({ ...input, phase: "at_risk", forecastDelayDays: 16, daysOverdue: null }), "High");
  assert.equal(deliveryWorkPriority({ ...input, phase: "at_risk", forecastDelayDays: null, daysOverdue: null }), "Medium");
  assert.equal(deliveryWorkPriority({ ...input, phase: "overdue", forecastDelayDays: null, daysOverdue: 3 }), "Medium");
  assert.equal(deliveryWorkPriority({ ...input, phase: "overdue", forecastDelayDays: null, daysOverdue: 12 }), "High");
  assert.equal(deliveryWorkPriority({ ...input, phase: "overdue", forecastDelayDays: null, daysOverdue: 35 }), "Critical");
  assert.equal(deliveryWorkPriority({ ...input, phase: "at_risk", forecastDelayDays: 2, daysOverdue: null, impactLevel: "production_affected" }), "High");
  assert.equal(deliveryWorkPriority({ ...input, phase: "at_risk", forecastDelayDays: 2, daysOverdue: null, attention: "follow_up_overdue" }), "High");
});
