// Reads of the lead-time feature: own lead times, info records, material
// master and PO activity from the materialized ItemFact / tide.s4.
import cds from "@sap/cds";
import { NS, type Row } from "../kernel/model-calls";
import { RELEVANCE_DAYS, STOCK_TRANSFER, addDays } from "./domain/leadtimes";

const { SELECT } = cds.ql;

export const key = (m: string, s: string, p: string) => `${m}|${s}|${p}`;

export interface Own {
  lt: number;
  available: string;
  po: string;
}

/**
 * Own lead times per source (material|supplier|plant) received before asOf,
 * in receipt order. Same-day receipts (0 days) are after-the-fact orders.
 */
export async function ownLeadTimes(
  asOf: string,
  only?: { Material: string; Supplier?: string | null; Plant: string },
): Promise<Map<string, Own[]>> {
  const q = SELECT.from(`${NS}.ItemFact`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "Material",
    "Supplier",
    "Plant",
    "LeadTimeDays",
    "AvailableDate",
  )
    .where`LeadTimeDays >= 0 and AvailableDate < ${asOf} and Material != ''`.orderBy(
    "AvailableDate",
    "PurchaseOrderDate",
    "PurchaseOrder",
    "PurchaseOrderItem",
  );
  if (only)
    q.where({
      Material: only.Material,
      Plant: only.Plant,
      ...(only.Supplier ? { Supplier: only.Supplier } : {}),
    });
  const out = new Map<string, Own[]>();
  for (const r of (await q) as Row[]) {
    const k = key(r.Material, r.Supplier, r.Plant);
    (out.get(k) ?? out.set(k, []).get(k)!).push({
      lt: Number(r.LeadTimeDays),
      available: r.AvailableDate,
      po: `${r.PurchaseOrder}/${r.PurchaseOrderItem}`,
    });
  }
  return out;
}

/** Info records (not deleted), first per source. */
export async function infoRecords(only?: {
  Material: string;
  Supplier?: string;
  Plant: string;
}): Promise<Map<string, Row>> {
  const q = SELECT.from("tide.s4.PurgInfoRecdOrgPlantData")
    .where`(IsMarkedForDeletion is null or IsMarkedForDeletion = false) and Material != '' and Supplier != ''`.orderBy(
    "PurchasingInfoRecord",
    "PurchasingOrganization",
  );
  if (only) q.where(only);
  const out = new Map<string, Row>();
  for (const r of (await q) as Row[]) {
    const k = key(r.Material, r.Supplier, r.Plant);
    if (!out.has(k)) out.set(k, r);
  }
  return out;
}

/** Material master per material|plant: planned delivery time, special procurement, MRP controller. */
export async function masters(only?: {
  Material: string;
  Plant: string;
}): Promise<Map<string, Row>> {
  const q = SELECT.from("tide.s4.ProductPlantSupplyPlanning").columns(
    "Product",
    "Plant",
    "PlannedDeliveryDurationInDays",
    "ProcurementSubType",
    "ProcurementType",
    "MRPResponsible",
  );
  if (only) q.where({ Product: only.Material, Plant: only.Plant });
  const rows: Row[] = await q;
  return new Map(rows.map((m) => [`${m.Product}|${m.Plant}`, m]));
}

export const isStockTransfer = (m: Row | undefined) =>
  !!m && STOCK_TRANSFER.has(String(m.ProcurementSubType ?? ""));

/** PO count and EUR value per source in the RELEVANCE_DAYS before asOf. */
export async function activity(
  asOf: string,
  only?: { Material: string; Supplier: string; Plant: string },
) {
  const since = addDays(asOf, -RELEVANCE_DAYS);
  const q = SELECT.from(`${NS}.ItemFact`).columns(
    "Material",
    "Supplier",
    "Plant",
    "count(1) as n",
    "sum(NetAmountEUR) as value",
    "max(PurchasingGroup) as PurchasingGroup",
  )
    .where`PurchaseOrderDate >= ${since} and PurchaseOrderDate < ${asOf} and Material != ''`.groupBy(
    "Material",
    "Supplier",
    "Plant",
  );
  if (only) q.where(only);
  const rows: Row[] = await q;
  return new Map(
    rows.map((r) => [
      key(r.Material, r.Supplier, r.Plant),
      {
        n: Number(r.n),
        value: Number(r.value ?? 0),
        PurchasingGroup: r.PurchasingGroup,
      },
    ]),
  );
}

/** PO items of the relevance window (material, supplier, plant, date) for P-6. */
export async function recentPos(asOf: string): Promise<Row[]> {
  const since = addDays(asOf, -RELEVANCE_DAYS);
  return SELECT.from(`${NS}.ItemFact`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "Material",
    "Supplier",
    "Plant",
    "PurchaseOrderDate",
    "PurchasingGroup",
  )
    .where`PurchaseOrderDate >= ${since} and PurchaseOrderDate < ${asOf} and Material != ''`;
}

export async function names() {
  const [mats, sups]: [Row[], Row[]] = await Promise.all([
    SELECT.from("tide.s4.ProductDescription")
      .columns("Product", "ProductDescription")
      .where({ Language: "EN" }),
    SELECT.from("tide.s4.Supplier").columns("Supplier", "SupplierName"),
  ]);
  return {
    material: new Map<string, string>(
      mats.map((m) => [m.Product, m.ProductDescription]),
    ),
    supplier: new Map<string, string>(
      sups.map((s) => [s.Supplier, s.SupplierName]),
    ),
  };
}
export type Names = Awaited<ReturnType<typeof names>>;

/** Material group and type of a material (Product). */
export async function productFacts(material: string): Promise<Row | undefined> {
  return SELECT.one
    .from("tide.s4.Product")
    .columns("ProductGroup", "ProductType")
    .where({ Product: material });
}

/** Latest PO item of the key, if any (predict row for the range). */
export async function latestItem(
  k: {
    Material: string;
    Supplier?: string | null;
    Plant: string;
  },
  asOf?: string,
): Promise<Row | undefined> {
  const where: Row = { Material: k.Material, Plant: k.Plant };
  if (k.Supplier) where.Supplier = k.Supplier;
  const query = SELECT.one
    .from(`${NS}.ItemFact`)
    .columns("PurchaseOrder", "PurchaseOrderItem")
    .where(where)
    .orderBy(
      "PurchaseOrderDate desc",
      "PurchaseOrder desc",
      "PurchaseOrderItem desc",
    );
  if (asOf) query.and`PurchaseOrderDate < ${asOf}`;
  return query;
}
