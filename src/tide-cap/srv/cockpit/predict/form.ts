// P-8 strict request form and filter resolution (pure): 400 before any model call.
import {
  bad,
  isDate,
  Filters,
  Item,
  MAX_LATE_DAYS,
  MIN_LATE_DAYS,
  REGIONS,
  Request,
  TARGETS,
  Target,
} from "./types";

const FILTER_KEYS: (keyof Filters)[] = [
  "buyer",
  "purchasingGroup",
  "plant",
  "supplier",
  "supplierRegion",
  "materialType",
  "materialGroup",
  "material",
  "poDateFrom",
  "poDateTo",
];
const REQUEST_KEYS = ["target", "lateDays", "key", "filters"];
const KEY_KEYS = ["material", "supplier", "plant"];

const present = (v: unknown) => v !== undefined && v !== null && v !== "";

function extra(obj: Record<string, unknown>, allowed: string[], where: string) {
  const unknown = Object.keys(obj).filter(
    (k) => present(obj[k]) && !allowed.includes(k),
  );
  if (unknown.length)
    throw bad(
      `invalid request: ${where}${unknown[0]}: extra fields not permitted`,
    );
}

function text(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim())
    throw bad(`invalid request: ${name}: must be a nonempty string`);
  return v.trim();
}

/** The strict request form (P-8): anything else is a 400 before any model call. */
export function parseRequest(raw: Record<string, unknown>): Request {
  if (!raw || typeof raw !== "object")
    throw bad("invalid request: request must be an object");
  extra(raw, REQUEST_KEYS, "");
  const target = raw.target;
  if (
    typeof target !== "string" ||
    !(TARGETS as readonly string[]).includes(target)
  )
    throw bad(`invalid request: target: must be one of ${TARGETS.join(", ")}`);
  let lateDays: number | null = null;
  if (present(raw.lateDays)) {
    const n = Number(raw.lateDays);
    if (!Number.isInteger(n) || n < MIN_LATE_DAYS || n > MAX_LATE_DAYS)
      throw bad(
        `invalid request: lateDays: must be a whole number from ${MIN_LATE_DAYS} to ${MAX_LATE_DAYS}`,
      );
    lateDays = n;
  }
  if ((target === "late_by_days") !== (lateDays !== null))
    throw bad(
      "invalid request: lateDays is required for late_by_days and only allowed there",
    );
  let key: Request["key"] = null;
  if (present(raw.key)) {
    if (typeof raw.key !== "object")
      throw bad("invalid request: key: must be an object");
    const k = raw.key as Record<string, unknown>;
    extra(k, KEY_KEYS, "key.");
    key = {
      material: text(k.material, "key.material"),
      supplier: text(k.supplier, "key.supplier"),
      plant: text(k.plant, "key.plant"),
    };
    if (target !== "lead_time_days")
      throw bad(
        "invalid request: a material, supplier and plant key is only allowed for lead_time_days",
      );
  }
  const filters: Filters = {};
  if (present(raw.filters)) {
    if (typeof raw.filters !== "object")
      throw bad("invalid request: filters: must be an object");
    const f = raw.filters as Record<string, unknown>;
    extra(f, FILTER_KEYS as string[], "filters.");
    for (const name of FILTER_KEYS) {
      if (!present(f[name])) continue;
      const v = text(f[name], `filters.${name}`);
      if (
        name === "supplierRegion" &&
        !(REGIONS as readonly string[]).includes(v)
      )
        throw bad(
          `invalid request: filters.supplierRegion: must be one of ${REGIONS.join(", ")}`,
        );
      if ((name === "poDateFrom" || name === "poDateTo") && !isDate(v))
        throw bad(
          `invalid request: filters.${name}: must be a date (YYYY-MM-DD)`,
        );
      (filters as Record<string, string>)[name] = v;
    }
  }
  return { target: target as Target, lateDays, key, filters };
}

export interface Known {
  plants: Set<string>;
  purchasingGroups: Set<string>;
  suppliers: Set<string>;
  materialTypes: Set<string>;
  materialGroups: Set<string>;
  materials: Set<string>;
}

export interface BuyerRow {
  userId: string;
  name?: string | null;
  Plant?: string | null;
  PurchasingGroup?: string | null;
}

/**
 * Filters with the buyer resolved and every value checked (400 on an unknown
 * one), before any model call. Without plant and purchasing group the
 * caller's scope applies; a named plant never gets the buyer's group added.
 */
export function resolveFilters(
  req: Request,
  known: Known,
  scope: { plant?: string | null; purchasingGroup?: string | null },
  buyers: BuyerRow[],
): Filters {
  const f: Filters = { ...req.filters };
  if (req.key)
    Object.assign(f, {
      plant: req.key.plant,
      supplier: req.key.supplier,
      material: req.key.material,
    });
  if (f.buyer) {
    const want = f.buyer.toLowerCase();
    const b = buyers.find(
      (x) =>
        x.userId.toLowerCase() === want ||
        String(x.name ?? "").toLowerCase() === want,
    );
    if (!b) throw bad(`unknown buyer ${f.buyer}`);
    if (!f.plant && b.Plant) f.plant = b.Plant;
    if (b.PurchasingGroup) f.purchasingGroup = b.PurchasingGroup;
    delete f.buyer;
  }
  if (!f.plant && !f.purchasingGroup) {
    if (scope.plant) f.plant = scope.plant;
    if (scope.purchasingGroup) f.purchasingGroup = scope.purchasingGroup;
  }
  const checks: [keyof Filters, keyof Known, string][] = [
    ["plant", "plants", "plant"],
    ["purchasingGroup", "purchasingGroups", "purchasing group"],
    ["supplier", "suppliers", "supplier"],
    ["materialType", "materialTypes", "material type"],
    ["materialGroup", "materialGroups", "material group"],
    ["material", "materials", "material"],
  ];
  for (const [name, set, words] of checks) {
    if (!f[name] || known[set].has(String(f[name]))) continue;
    if (name === "plant")
      throw bad(
        `unknown plant ${f[name]}; valid plants: ${[...known.plants].sort().join(", ")}`,
      );
    throw bad(`unknown ${words} ${f[name]}`);
  }
  if (f.poDateFrom && f.poDateTo && f.poDateFrom > f.poDateTo)
    throw bad("poDateFrom is after poDateTo");
  return f;
}

/** Known values of the items ordered before the as-of date. */
export function knownValues(items: Item[], asOf: string): Known {
  const k: Known = {
    plants: new Set(),
    purchasingGroups: new Set(),
    suppliers: new Set(),
    materialTypes: new Set(),
    materialGroups: new Set(),
    materials: new Set(),
  };
  for (const i of items) {
    if (!(i.PurchaseOrderDate < asOf)) continue;
    if (i.Plant) k.plants.add(i.Plant);
    if (i.PurchasingGroup) k.purchasingGroups.add(i.PurchasingGroup);
    if (i.Supplier) k.suppliers.add(i.Supplier);
    if (i.MaterialType) k.materialTypes.add(i.MaterialType);
    if (i.MaterialGroup) k.materialGroups.add(i.MaterialGroup);
    if (i.Material) k.materials.add(i.Material);
  }
  return k;
}
