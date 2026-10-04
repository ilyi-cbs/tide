import { daysBetween } from "./calendar";
import type { ImpactLevel } from "./types";

export type DeliveryPriority = "Critical" | "High" | "Medium" | "Low";

export type DeliveryPriorityInput = {
  phase: "at_risk" | "overdue";
  forecastDelayDays: number | null;
  daysOverdue: number | null;
  impactLevel: ImpactLevel | null;
  needDate: string | null;
  attention?: string | null;
  asOf: string;
};

const order = (priority: DeliveryPriority) => PRIORITY_ORDER[priority];
const fromOrder = (value: number): DeliveryPriority =>
  value <= 0 ? "Critical" : value === 1 ? "High" : value === 2 ? "Medium" : "Low";

/**
 * Buyer worklist priority: delivery urgency establishes the baseline; confirmed
 * impact and workflow escalation can only raise it. Missing demand data never
 * downgrades a late or overdue delivery.
 */
export function deliveryWorkPriority(input: DeliveryPriorityInput): DeliveryPriority {
  const overdue = Math.max(0, input.daysOverdue ?? 0);
  const delay = Math.max(0, input.forecastDelayDays ?? 0);
  let value: number;

  if (input.phase === "overdue") {
    value = overdue > 30 ? order("Critical") : overdue > 7 ? order("High") : order("Medium");
  } else if (input.forecastDelayDays === null) {
    value = order("Medium");
  } else {
    value = delay > 14 ? order("High") : delay > 3 ? order("Medium") : order("Low");
  }

  if (input.impactLevel === "customer_order_late") {
    const daysToNeed = input.needDate ? daysBetween(input.asOf, input.needDate) : 0;
    value = Math.min(value, order(daysToNeed <= 3 ? "Critical" : daysToNeed <= 7 ? "High" : "Medium"));
  } else if (input.impactLevel === "production_affected") {
    value = Math.min(value, order("High"));
  } else if (input.impactLevel === "stock_uncovered") {
    value = Math.min(value, order("Medium"));
  }

  if (input.attention === "follow_up_overdue" || input.attention === "source_changed")
    value = Math.min(value, order("High"));

  return fromOrder(value);
}

/** Impact and customer need decide the tier; revenue and overdue age break ties within it. */
export function deliveryPriority(level: ImpactLevel | null, needDate: string | null, asOf: string, daysOverdue: number | null): DeliveryPriority {
  if (level === "customer_order_late") {
    const daysToNeed = needDate ? daysBetween(asOf, needDate) : 0;
    if (daysToNeed <= 3) return "Critical";
    if (daysToNeed <= 6) return "High";
    if (daysToNeed <= 8) return "Medium";
    return "Low";
  }
  if (level === "production_affected") return "High";
  if (level === "stock_uncovered" || (daysOverdue ?? 0) > 30) return "Medium";
  return "Low";
}

export const PRIORITY_CRITICALITY: Record<DeliveryPriority, number> = {
  Critical: 1,
  High: 1,
  Medium: 2,
  Low: 3,
};

export const PRIORITY_ORDER: Record<DeliveryPriority, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

export function prioritySort(a: { deliveryPriorityOrder?: number | null; revenueAtRisk?: number | null; daysOverdue?: number | null }, b: { deliveryPriorityOrder?: number | null; revenueAtRisk?: number | null; daysOverdue?: number | null }): number {
  return (a.deliveryPriorityOrder ?? 4) - (b.deliveryPriorityOrder ?? 4) ||
    (b.revenueAtRisk ?? 0) - (a.revenueAtRisk ?? 0) ||
    (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0);
}

/** The same stored priority on newly-created delivery findings between impact refreshes. */
export function priorityFields(level: ImpactLevel | null, needDate: string | null, asOf: string, daysOverdue: number | null) {
  const priority = deliveryPriority(level, needDate, asOf, daysOverdue);
  return { deliveryPriority: priority, deliveryPriorityOrder: PRIORITY_ORDER[priority], deliveryPriorityCriticality: PRIORITY_CRITICALITY[priority] };
}
