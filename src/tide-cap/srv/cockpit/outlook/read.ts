// Use case: the delivery outlook of one finding (CQL reads -> pure domain).
// Reads kernel entities and the live item facts only; no model call (NS-D4).
import cds from "@sap/cds";
import { asOfDate } from "../kernel/asof";
import { impactText, sourceText } from "../kernel/findings";
import { pdtFlag } from "../atrisk/domain/rules";
import { NS, type Row } from "../kernel/model-calls";
import { daysBetween } from "../kernel/calendar";
import type { ImpactLevel } from "../kernel/types";
import {
  DELIVERY_LISTS,
  outlook,
  type DeliveryList,
  type Outlook,
} from "./domain/outlook";

const { SELECT } = cds.ql;
const iso = (d: unknown) => (d ? String(d).slice(0, 10) : null);

async function deliveryRisk(caseID: string) {
  return SELECT.one
    .from(`${NS}.DeliveryRisks`)
    .columns(
      "header_ID as ID",
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Material",
      "Supplier",
      "Plant",
      "phase",
      "nextActionKind",
      "header.status as status",
    )
    .where({ header_ID: caseID });
}

/** Historical receipts for the current material, supplier, and plant. */
export async function readDeliveryHistory(caseID: string) {
  const f: Row | undefined = await deliveryRisk(caseID);
  if (!f) return null;
  if (!f.Material || !f.Supplier || !f.Plant) return emptyDeliveryHistory();

  const key = {
    PurchaseOrder: f.PurchaseOrder,
    PurchaseOrderItem: f.PurchaseOrderItem,
  };
  const grid: Row | undefined = await SELECT.one
    .from(`${NS}.LineGrid`)
    .columns(
      "arrivalAsOf",
      "openBasis",
      "openSource",
      "arrivalP10",
      "arrivalP50",
      "arrivalP80",
      "arrivalP90",
    )
    .where(key);
  const forecastAsOf = iso(grid?.arrivalAsOf) ?? (await asOfDate());
  const rows: Row[] = await SELECT.from(`${NS}.ItemFact`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "PurchaseOrderDate",
    "RequestedDate",
    "AvailableDate",
    "LeadTimeDays",
  )
    .where`Material = ${f.Material} and Supplier = ${f.Supplier} and Plant = ${f.Plant} and LeadTimeDays >= 0 and AvailableDate is not null and AvailableDate <= ${forecastAsOf}`.orderBy(
    "AvailableDate desc",
    "PurchaseOrder desc",
    "PurchaseOrderItem desc",
  );
  const leadTimes = rows
    .map((row) => Number(row.LeadTimeDays))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const midpoint = leadTimes.length ? Math.floor(leadTimes.length / 2) : 0;
  const typicalDays = leadTimes.length
    ? leadTimes.length % 2
      ? leadTimes[midpoint]
      : (leadTimes[midpoint - 1] + leadTimes[midpoint]) / 2
    : null;
  const recent = rows
    .slice(0, Math.min(5, rows.length))
    .map((row) => Number(row.LeadTimeDays))
    .filter(Number.isFinite);
  const recentTypical = recent.length
    ? recent.reduce((total, value) => total + value, 0) / recent.length
    : null;
  const current: Row | undefined = await SELECT.one
    .from(`${NS}.ItemFactSource`)
    .columns("PurchaseOrderDate", "PlannedDays")
    .where(key);
  const impact: Row | undefined = await SELECT.one
    .from(`${NS}.ItemImpact`)
    .columns("confirmedDate")
    .where(key);
  const currentOrderDate = iso(current?.PurchaseOrderDate);
  const forecastDays = (date: unknown) => {
    const arrival = iso(date);
    return currentOrderDate && arrival
      ? Math.max(0, daysBetween(currentOrderDate, arrival))
      : null;
  };

  return {
    observedReceipts: leadTimes.length,
    typicalDays,
    fastestDays: leadTimes.length ? leadTimes[0] : null,
    slowestDays: leadTimes.length ? leadTimes[leadTimes.length - 1] : null,
    plannedDays: current?.PlannedDays ?? null,
    plannedDaysFlag: pdtFlag(current?.PlannedDays),
    recentTrendDays:
      typicalDays !== null && recentTypical !== null
        ? Math.round((recentTypical - typicalDays) * 10) / 10
        : null,
    forecastSource: impact?.confirmedDate
      ? "confirmation"
      : (grid?.openSource ?? null),
    forecastAsOf,
    forecastBasis: grid?.openBasis ?? null,
    earlyForecastDays: impact?.confirmedDate
      ? null
      : forecastDays(grid?.arrivalP10),
    typicalForecastDays: impact?.confirmedDate
      ? forecastDays(impact.confirmedDate)
      : forecastDays(grid?.arrivalP50),
    planningForecastDays: impact?.confirmedDate
      ? null
      : forecastDays(grid?.arrivalP80),
    lateRiskForecastDays: impact?.confirmedDate
      ? null
      : forecastDays(grid?.arrivalP90),
    confirmedArrival: iso(impact?.confirmedDate),
    currentOrderDate,
    deliveries: rows.slice(0, 25).map((row) => ({
      purchaseOrder: row.PurchaseOrder,
      item: row.PurchaseOrderItem,
      ordered: iso(row.PurchaseOrderDate),
      requested: iso(row.RequestedDate),
      available: iso(row.AvailableDate),
      leadTimeDays: row.LeadTimeDays,
    })),
  };
}

function emptyDeliveryHistory() {
  return {
    observedReceipts: 0,
    typicalDays: null,
    fastestDays: null,
    slowestDays: null,
    plannedDays: null,
    plannedDaysFlag: "not_maintained",
    recentTrendDays: null,
    forecastSource: null,
    forecastAsOf: null,
    forecastBasis: null,
    earlyForecastDays: null,
    typicalForecastDays: null,
    planningForecastDays: null,
    lateRiskForecastDays: null,
    confirmedArrival: null,
    currentOrderDate: null,
    deliveries: [],
  };
}

/** Null when the finding does not exist or is not an at_risk / overdue finding. */
export async function readOutlook(caseID: string): Promise<Outlook | null> {
  const risk: Row | undefined = await deliveryRisk(caseID);
  if (!risk || !DELIVERY_LISTS.includes(risk.phase)) return null;
  const f: Row = { ...risk, list: risk.phase };
  const key = {
    PurchaseOrder: f.PurchaseOrder,
    PurchaseOrderItem: f.PurchaseOrderItem,
  };

  const g: Row | undefined = await SELECT.one
    .from(`${NS}.LineGrid`)
    .columns(
      "arrivalAsOf",
      "arrivalP10",
      "arrivalP50",
      "arrivalP80",
      "arrivalP90",
      "openBasis",
      "openSource",
      "chanceLate",
      "ownArrivalP10",
      "ownArrivalP50",
      "ownArrivalP90",
      "nOwn",
    )
    .where(key);
  const imp: Row | undefined = await SELECT.one
    .from(`${NS}.ItemImpact`)
    .columns(
      "level",
      "revenueAtRisk",
      "needDate",
      "shortageFrom",
      "confirmedDate",
    )
    .where(key);
  const fact: Row | undefined = await SELECT.one
    .from(`${NS}.ItemFactSource`)
    .columns("PurchaseOrderDate", "RequestedDate", "PlannedDays")
    .where(key);
  const action: Row | undefined = await SELECT.one
    .from(`${NS}.CaseActions as link`)
    .columns(
      "link.action.ID as ID",
      "link.action.status as status",
      "link.action.waitingSince as waitingSince",
      "link.action.createdAt as createdAt",
    )
    .where`link.header_ID = ${caseID} and link.action.status in ${["needs_decision", "waiting"]}`.orderBy(
    "createdAt desc",
  );
  // Tagged where: an object where with the column name `list` is read as a CXN list.
  const asOf = iso(g?.arrivalAsOf) ?? (await asOfDate());
  if (!asOf) return null;
  const sib: Row | undefined = await SELECT.one
    .from(`${NS}.ItemFactSource`)
    .columns("max(AvailableDate) as at")
    .where`PurchaseOrder = ${f.PurchaseOrder} and PurchaseOrderItem != ${f.PurchaseOrderItem} and AvailableDate < ${asOf}`;

  return outlook({
    aiOnly: true,
    asOf,
    list: f.list as DeliveryList,
    status: f.status,
    nextActionKind: f.nextActionKind ?? null,
    poDate: iso(fact?.PurchaseOrderDate),
    requested: iso(fact?.RequestedDate),
    plannedDays: [null, "default"].includes(pdtFlag(fact?.PlannedDays))
      ? Number(fact?.PlannedDays)
      : null,
    grid: g
      ? {
          p10: iso(g.arrivalP10),
          p50: iso(g.arrivalP50),
          p80: iso(g.arrivalP80),
          p90: iso(g.arrivalP90),
          basis: g.openBasis ?? null,
          source: g.openSource ?? null,
          sourceText: sourceText(g.openSource),
          chanceLate: g.chanceLate ?? null,
          ownP10: iso(g.ownArrivalP10),
          ownP50: iso(g.ownArrivalP50),
          ownP90: iso(g.ownArrivalP90),
          nOwn: Number(g.nOwn ?? 0),
          agreement: null,
        }
      : null,
    impact: imp
      ? {
          level: (imp.level ?? null) as ImpactLevel | null,
          levelText: impactText(imp.level, imp.revenueAtRisk),
          needDate: iso(imp.needDate),
          shortageFrom: iso(imp.shortageFrom),
        }
      : null,
    action: action
      ? {
          ID: action.ID,
          status: action.status,
          since: iso(action.waitingSince ?? action.createdAt),
        }
      : null,
    confirmedDate: iso(imp?.confirmedDate),
    rootCause: null,
    siblingReceived: iso(sib?.at),
    canSimulate: !!(f.Material && f.Plant),
  });
}
