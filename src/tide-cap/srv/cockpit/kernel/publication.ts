import cds from "@sap/cds";
import { fail } from "./errors";
import { inTx, NS, type Row } from "./model-calls";
import type { StepContext } from "./types";

export const PREPARATION_POLICY = "cockpit-publication:v2";

export async function sourceIdentity() {
  const info = await cds.ql.SELECT.one
    .from("tide.s4.DatasetInfo")
    .columns("asOf", "loadId", "loadedAt", "source", "name")
    .where({ ID: "current" });
  return {
    asOf: info?.asOf ?? null,
    loadId: info?.loadId ?? null,
    loadedAt: info?.loadedAt ?? null,
    source: info?.source ?? null,
    name: info?.name ?? null,
  };
}

export async function workflowFence() {
  const model = cds.model;
  if (!model)
    throw new Error("Workflow publication requires a loaded CDS model");
  const entities = [
    { name: "Cases", keys: ["ID"] },
    { name: "Actions", keys: ["ID"] },
    {
      name: "FreetextReview",
      keys: ["PurchaseRequisition", "PurchaseRequisitionItem"],
    },
    {
      name: "FreetextReviewAccountAssignment",
      keys: [
        "PurchaseRequisition",
        "PurchaseRequisitionItem",
        "PurchaseReqnAcctAssgmtNumber",
      ],
    },
  ];
  const state: Row = {};
  for (const { name, keys } of entities) {
    const entity = `${NS}.${name}`;
    if (!model.definitions[entity]) continue;
    state[name] = await cds.ql.SELECT.from(entity)
      .columns(...keys, "modifiedAt")
      .orderBy(...keys);
  }
  for (const name of [
    "PurchaseRequisitionReviews",
    "FreetextReviewAccountAssignments",
  ]) {
    const entity = `PurchasingDeskService.${name}.drafts`;
    const definition = model.definitions[entity] as any;
    if (!definition) continue;
    const keys = Object.entries(definition.elements)
      .filter(
        ([, element]: [string, any]) =>
          element.key && !element.target && !element.virtual,
      )
      .map(([key]) => key);
    state[entity] = await cds.ql.SELECT.from(entity)
      .columns(...keys, "modifiedAt")
      .orderBy(...keys);
  }
  return JSON.stringify(state);
}

export async function assertPublicationFence(
  source: Awaited<ReturnType<typeof sourceIdentity>>,
  versions: string,
) {
  if (JSON.stringify(await sourceIdentity()) !== JSON.stringify(source))
    throw fail(
      409,
      "Imported source changed during preparation; prepare again",
    );
  if ((await workflowFence()) !== versions)
    throw fail(409, "Buyer work changed during preparation; prepare again");
}

export async function writePreparation(
  ctx: Pick<StepContext, "publication">,
  write: () => Promise<unknown>,
) {
  if (ctx.publication) ctx.publication.writes.push(write);
  else await inTx(write);
}

export async function observePublication(
  snapshotId: string,
  asOf: string,
  observedAt: string,
  retain: boolean,
) {
  const { SELECT, INSERT, DELETE, UPSERT } = cds.ql;
  const headers: Row[] = await SELECT.from(`${NS}.Cases`).orderBy("ID");
  const observations = headers.map((header) => ({
    snapshot_ID: snapshotId,
    caseID: header.ID,
    kind: header.kind,
    status: header.status,
    listing: header.listing,
    priority: header.priority,
    sourceRevision: header.sourceRevision,
    sourceFingerprint: header.sourceFingerprint,
    Plant: header.Plant,
    PurchasingGroup: header.PurchasingGroup,
    observedAt,
  }));
  const active = new Map(
    headers
      .filter(
        (header) =>
          header.kind === "delivery" &&
          header.status === "open" &&
          header.listing === "listed",
      )
      .map((header) => [header.ID, header]),
  );
  const deliveries: Row[] = await SELECT.from(`${NS}.DeliveryRisks`);
  const byItem = new Map(
    deliveries
      .filter((delivery) => active.has(delivery.header_ID))
      .map((delivery) => [
        `${delivery.PurchaseOrder}/${delivery.PurchaseOrderItem}`,
        active.get(delivery.header_ID)!,
      ]),
  );
  const impacts: Row[] = await SELECT.from(`${NS}.SalesOrderImpact`);
  const exposures = impacts.flatMap((impact) => {
    const header = byItem.get(
      `${impact.PurchaseOrder}/${impact.PurchaseOrderItem}`,
    );
    if (!header) return [];
    const valued =
      impact.RevenueAtRisk !== null &&
      impact.RevenueAtRisk !== undefined &&
      Number.isFinite(Number(impact.RevenueAtRisk));
    return [
      {
        snapshot_ID: snapshotId,
        caseID: header.ID,
        SalesOrder: impact.SalesOrder,
        SalesOrderItem: impact.SalesOrderItem,
        Plant: header.Plant,
        PurchasingGroup: header.PurchasingGroup,
        revenueAtRisk: valued ? Number(impact.RevenueAtRisk) : null,
        currency: impact.Currency,
        valuationStatus:
          valued && impact.Currency === "EUR" ? "valued" : "unvalued",
      },
    ];
  });
  if (retain) {
    if (observations.length)
      await INSERT.into(`${NS}.CaseObservation`).entries(observations);
    if (exposures.length)
      await INSERT.into(`${NS}.ExposureObservation`).entries(exposures);
    const daily = [...active.values()].filter(
      (header) =>
        Number.isInteger(header.priority) &&
        header.priority >= 0 &&
        header.priority <= 3,
    );
    await DELETE.from(`${NS}.DeliveryPriorityDailyState`).where({ day: asOf });
    if (daily.length)
      await INSERT.into(`${NS}.DeliveryPriorityDailyState`).entries(
        daily.map((header) => ({
          day: asOf,
          findingID: header.ID,
          problemKey: header.ID,
          priority: header.priority,
          Plant: header.Plant,
          PurchasingGroup: header.PurchasingGroup,
          revenueAtRisk: null,
        })),
      );
    await UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries(
      [0, 1, 2, 3].map((priority) => ({
        day: asOf,
        priority,
        count: daily.filter((header) => header.priority === priority).length,
      })),
    );
  }
  return {
    unvaluedDemands: new Set(
      exposures
        .filter((row) => row.valuationStatus !== "valued")
        .map((row) => `${row.SalesOrder}/${row.SalesOrderItem}`),
    ).size,
    overdue: deliveries.filter(
      (delivery) =>
        active.has(delivery.header_ID) && delivery.phase === "overdue",
    ).length,
    revenueAtRisk: exposureRevenue(exposures),
  };
}

export function exposureRevenue(rows: Row[]) {
  const demand = new Map<string, number>();
  for (const row of rows) {
    if (row.valuationStatus !== "valued" || row.currency !== "EUR") continue;
    const key = `${row.SalesOrder}/${row.SalesOrderItem}`;
    demand.set(
      key,
      Math.max(demand.get(key) ?? 0, Number(row.revenueAtRisk) || 0),
    );
  }
  return [...demand.values()].reduce((sum, amount) => sum + amount, 0);
}
