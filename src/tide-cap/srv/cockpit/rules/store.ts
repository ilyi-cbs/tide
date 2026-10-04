// Database reads of the rule lists (P-13). Optional S/4 tables and columns
// (confirmations, confirmation control key, special procurement) may be
// missing: every read checks the model first and returns [] on a missing
// table or column instead of failing the step.
import cds from "@sap/cds";
import { NS, type Row } from "../kernel/model-calls";
import type { PriceRow } from "./domain/price";

const { SELECT } = cds.ql;
const LOG = cds.log("cockpit");
const S4 = "tide.s4";

const defs = () =>
  ((cds.model as any)?.definitions ?? {}) as Record<string, any>;

export const hasEntity = (name: string) => defs()[name]?.kind === "entity";
export const hasColumn = (entity: string, column: string) =>
  !!defs()[entity]?.elements?.[column];

/** Runs a read; a missing table / column (optional v4 data) yields []. */
export async function safeRead(
  label: string,
  read: () => PromiseLike<any> | any,
): Promise<Row[]> {
  try {
    return ((await read()) as Row[]) ?? [];
  } catch (e: any) {
    LOG.warn(
      `rules: ${label} not readable, treated as empty (${String(e?.message ?? e).slice(0, 120)})`,
    );
    return [];
  }
}

export const stripZeros = (x: unknown) =>
  String(x ?? "").replace(/^0+(?=\d)/, "");

export async function names() {
  const [mats, sups, plts] = await Promise.all([
    safeRead("ProductDescription", () =>
      SELECT.from(`${S4}.ProductDescription`)
        .columns("Product", "ProductDescription")
        .where({ Language: "EN" }),
    ),
    safeRead("Supplier", () =>
      SELECT.from(`${S4}.Supplier`).columns("Supplier", "SupplierName"),
    ),
    safeRead("Plant", () =>
      SELECT.from(`${S4}.Plant`).columns("Plant", "PlantName"),
    ),
  ]);
  return {
    material: new Map<string, string>(
      mats.map((m) => [m.Product, m.ProductDescription]),
    ),
    supplier: new Map<string, string>(
      sups.map((s) => [s.Supplier, s.SupplierName]),
    ),
    plant: new Map<string, string>(plts.map((p) => [p.Plant, p.PlantName])),
  };
}
export type Names = Awaited<ReturnType<typeof names>>;

const ITEM_COLUMNS = [
  "PurchaseOrder",
  "PurchaseOrderItem",
  "Material",
  "Plant",
  "Supplier",
  "PurchasingGroup",
  "MRPController",
  "PurchaseOrderDate",
  "RequestedDate",
  "NetAmount",
  "Currency",
  "OrderQuantity",
  "OpenQuantity",
  "ReceivedQuantity",
  "ArrivalDate",
  "IsOpen",
];

/** Open PO items ordered before asOf (current facts view), optionally only `keys`. */
export async function openItems(
  asOf: string,
  keys?: { PurchaseOrder: string; PurchaseOrderItem: string }[],
): Promise<Row[]> {
  if (keys && !keys.length) return [];
  const q = SELECT.from(`${NS}.ItemFactSource`).columns(...ITEM_COLUMNS)
    .where`IsOpen = true and PurchaseOrderDate < ${asOf}`;
  if (keys)
    q.where({
      PurchaseOrder: { in: [...new Set(keys.map((k) => k.PurchaseOrder))] },
    });
  const rows: Row[] = await safeRead("open items", () => q);
  if (!keys) return rows;
  const want = new Set(
    keys.map((k) => `${k.PurchaseOrder}/${k.PurchaseOrderItem}`),
  );
  return rows.filter((r) =>
    want.has(`${r.PurchaseOrder}/${r.PurchaseOrderItem}`),
  );
}

/** One PO item from the current facts view (open or not), or null. */
export async function itemFact(
  PurchaseOrder: string,
  PurchaseOrderItem: string,
): Promise<Row | null> {
  const r = await safeRead("item", () =>
    SELECT.from(`${NS}.ItemFactSource`)
      .columns(...ITEM_COLUMNS)
      .where({ PurchaseOrder, PurchaseOrderItem }),
  );
  return r[0] ?? null;
}

/** Row sets of every loaded S/4 confirmation entity (CE_SUPPLIERCONFIRMATION_0001), keyed by entity name. */
export async function sapConfirmationRows(): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const [name, d] of Object.entries(defs())) {
    if (
      !name.startsWith(`${S4}.`) ||
      d.kind !== "entity" ||
      !/confirmation/i.test(name)
    )
      continue;
    out[name.slice(S4.length + 1)] = await safeRead(name, () =>
      SELECT.from(name),
    );
  }
  return out;
}

/** Items with header data for the price rule (all PO items with a price), optionally one key set. */
export async function priceRows(
  filter?: { Material: string; Plant: string }[],
): Promise<Array<PriceRow & Row>> {
  const iq = SELECT.from(`${S4}.PurchaseOrderItem`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "Material",
    "MaterialGroup",
    "MaterialType",
    "Plant",
    "OrderQuantity",
    "NetPriceAmount",
    "NetPriceQuantity",
    "DocumentCurrency",
    "NetAmount",
    "PurchaseOrderQuantityUnit",
  )
    .where`NetPriceAmount > 0 and NetPriceQuantity > 0 and Material is not null and Material != ''`;
  if (filter) {
    if (!filter.length) return [];
    iq.where({ Material: { in: [...new Set(filter.map((f) => f.Material))] } });
  }
  const [items, heads] = await Promise.all([
    safeRead("price items", () => iq),
    safeRead("PO headers", () =>
      SELECT.from(`${S4}.PurchaseOrder`).columns(
        "PurchaseOrder",
        "PurchaseOrderDate",
        "Supplier",
        "PurchasingGroup",
        "PurchasingOrganization",
        "DocumentCurrency",
      ),
    ),
  ]);
  const h = new Map(heads.map((x) => [x.PurchaseOrder, x]));
  const plants = filter
    ? new Set(filter.map((f) => `${f.Material}|${f.Plant}`))
    : null;
  return items
    .filter(
      (i) =>
        h.get(i.PurchaseOrder)?.PurchaseOrderDate &&
        (!plants || plants.has(`${i.Material}|${i.Plant}`)),
    )
    .map((i) => {
      const x = h.get(i.PurchaseOrder)!;
      return {
        ...i,
        PurchaseOrder: i.PurchaseOrder,
        PurchaseOrderItem: i.PurchaseOrderItem,
        Material: i.Material,
        Plant: i.Plant,
        PurchaseOrderDate: String(x.PurchaseOrderDate).slice(0, 10),
        Supplier: x.Supplier,
        PurchasingGroup: x.PurchasingGroup,
        PurchasingOrganization: x.PurchasingOrganization,
        Currency: i.DocumentCurrency ?? x.DocumentCurrency ?? "",
        OrderUnit: i.PurchaseOrderQuantityUnit ?? null,
        NetPriceAmount: Number(i.NetPriceAmount),
        NetPriceQuantity: Number(i.NetPriceQuantity),
      };
    });
}

/** POs (by PO date) and goods movements (by posting date) per material and plant. */
export async function activityRows(): Promise<Row[]> {
  const [items, heads, docs] = await Promise.all([
    safeRead("PO items", () =>
      SELECT.from(`${S4}.PurchaseOrderItem`).columns(
        "PurchaseOrder",
        "Material",
        "Plant",
      ),
    ),
    safeRead("PO headers", () =>
      SELECT.from(`${S4}.PurchaseOrder`).columns(
        "PurchaseOrder",
        "PurchaseOrderDate",
      ),
    ),
    safeRead("material documents", () =>
      SELECT.from(`${S4}.MaterialDocumentItem`).columns(
        "Material",
        "Plant",
        "PostingDate",
      ),
    ),
  ]);
  const poDate = new Map(
    heads.map((h) => [h.PurchaseOrder, h.PurchaseOrderDate]),
  );
  const out: Row[] = [];
  for (const i of items) {
    const d = poDate.get(i.PurchaseOrder);
    if (i.Material && d)
      out.push({
        Material: i.Material,
        Plant: i.Plant,
        date: String(d).slice(0, 10),
        kind: "po",
      });
  }
  for (const m of docs)
    if (m.Material && m.PostingDate)
      out.push({
        Material: m.Material,
        Plant: m.Plant,
        date: String(m.PostingDate).slice(0, 10),
        kind: "movement",
      });
  return out;
}

export async function materials(): Promise<Row[]> {
  const [prods, descs] = await Promise.all([
    safeRead("Product", () =>
      SELECT.from(`${S4}.Product`).columns("Product", "ProductType"),
    ),
    safeRead("ProductDescription", () =>
      SELECT.from(`${S4}.ProductDescription`)
        .columns("Product", "ProductDescription")
        .where({ Language: "EN" }),
    ),
  ]);
  const d = new Map(descs.map((x) => [x.Product, x.ProductDescription]));
  return prods.map((p) => ({
    Product: p.Product,
    ProductType: p.ProductType ?? null,
    ProductDescription: d.get(p.Product) ?? null,
  }));
}

/** Planning fields per material and plant, with material type; a missing column counts as blank. */
export async function planningRows(): Promise<Row[]> {
  const E = `${S4}.ProductPlantSupplyPlanning`;
  const fields = [
    "ProcurementType",
    "ProcurementSubType",
    "MRPType",
    "LotSizingProcedure",
    "MRPResponsible",
  ].filter((c) => hasColumn(E, c));
  const [rows, prods] = await Promise.all([
    safeRead("supply planning", () =>
      SELECT.from(E).columns("Product", "Plant", ...fields),
    ),
    safeRead("Product", () =>
      SELECT.from(`${S4}.Product`).columns("Product", "ProductType"),
    ),
  ]);
  const type = new Map(prods.map((p) => [p.Product, p.ProductType]));
  return rows
    .filter((r) => type.has(r.Product))
    .map((r) => ({ ...r, ProductType: type.get(r.Product) ?? null }));
}

/** Purchasing group per material and plant (buyer scope of master-data findings). */
export async function purchasingGroups(): Promise<Map<string, string>> {
  const rows = await safeRead("ProductPlantProcurement", () =>
    SELECT.from(`${S4}.ProductPlantProcurement`).columns(
      "Product",
      "Plant",
      "PurchasingGroup",
    ),
  );
  return new Map(
    rows.map((r) => [`${r.Product}|${r.Plant}`, r.PurchasingGroup]),
  );
}
